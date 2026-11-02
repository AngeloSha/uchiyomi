import Foundation
import Network
import CryptoKit

struct GatewayPolicy {
    let profile: ServerProfile
    let token: String
    let cookieName = "uchiyomi_gateway"

    func allows(_ request: HTTPRequest) -> Bool {
        guard request.headers["host"]?.lowercased() == profile.localHost else { return false }
        if let origin = request.headers["origin"], origin != profile.localOrigin.absoluteString { return false }
        if let site = request.headers["sec-fetch-site"], !["same-origin", "none"].contains(site) { return false }
        let values = (request.headers["cookie"] ?? "").split(separator: ";").compactMap { entry -> String? in
            let parts = entry.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            return parts.count == 2 && parts[0] == cookieName ? String(parts[1]) : nil
        }
        guard values.count == 1 else { return false }
        let a = Array(SHA256.hash(data: Data(values[0].utf8)))
        let b = Array(SHA256.hash(data: Data(token.utf8)))
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    func isProxyPath(_ path: String) -> Bool {
        ["/api", "/auth", "/img"].contains { path == $0 || path.hasPrefix($0 + "/") }
    }
}

// Mutable listener/connection state is accessed only on queue; request routing reads immutable state.
final class Gateway: @unchecked Sendable {
    let policy: GatewayPolicy
    private let ui: PreparedUI
    private let client: RemoteClient
    private let queue = DispatchQueue(label: "uchiyomi.loopback")
    private var listener: NWListener?
    private var connections: [UUID: HTTPConnection] = [:]
    private var ready = false
    private var stopping = false
    private var startWaiters: [CheckedContinuation<Void, Error>] = []
    private var stopWaiters: [CheckedContinuation<Void, Never>] = []

    init(profile: ServerProfile, ui: PreparedUI, client: RemoteClient) {
        policy = GatewayPolicy(profile: profile, token: SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() })
        self.ui = ui
        self.client = client
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                guard !self.stopping else { continuation.resume(throwing: ClientError.invalid("The local reader is still stopping. Please retry.")); return }
                if self.ready { continuation.resume(); return }
                self.startWaiters.append(continuation)
                guard self.listener == nil else { return }
                do {
                    let parameters = NWParameters.tcp
                    parameters.requiredInterfaceType = .loopback
                    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: self.policy.profile.port)!)
                    parameters.allowLocalEndpointReuse = true
                    let listener = try NWListener(using: parameters)
                    self.listener = listener
                    listener.stateUpdateHandler = { [weak self, weak listener] state in
                        guard let self, self.listener === listener else { return }
                        switch state {
                        case .ready:
                            self.ready = true
                            self.finishStarting()
                        case .failed(let error):
                            self.finishStarting(error)
                            listener?.cancel()
                        case .cancelled:
                            self.listener = nil; self.ready = false; self.stopping = false
                            self.finishStarting(CancellationError())
                            let waiting = self.stopWaiters
                            self.stopWaiters.removeAll()
                            waiting.forEach { $0.resume() }
                        default: break
                        }
                    }
                    listener.newConnectionHandler = { [weak self] connection in
                        guard let self, self.connections.count < 32 else { connection.cancel(); return }
                        let id = UUID()
                        let handler = HTTPConnection(connection: connection, queue: self.queue,
                            respond: { [weak self] request in await self?.respond(request) ?? .message(503, "closed") },
                            finish: { [weak self] in self?.connections.removeValue(forKey: id) })
                        self.connections[id] = handler
                        handler.start()
                    }
                    listener.start(queue: self.queue)
                } catch { self.listener = nil; self.finishStarting(error) }
            }
        }
    }

    private func finishStarting(_ error: Error? = nil) {
        let waiting = startWaiters
        startWaiters.removeAll()
        for continuation in waiting {
            if let error { continuation.resume(throwing: error) }
            else { continuation.resume() }
        }
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                let active = Array(self.connections.values)
                active.forEach { $0.cancel() }
                self.connections.removeAll()
                guard let listener = self.listener else { continuation.resume(); return }
                // Cancellation is asynchronous. Keep the listener alive and wait for .cancelled
                // before allowing the caller to rebind the saved port (observed on iOS 27.2).
                self.stopping = true
                self.stopWaiters.append(continuation)
                listener.cancel()
            }
        }
    }

    func respond(_ request: HTTPRequest) async -> HTTPResponse {
        guard policy.allows(request) else { return .message(403, "local_access_denied") }
        guard let path = request.path else { return .message(400, "invalid_path") }
        if policy.isProxyPath(path) { return await client.proxy(request) }
        guard request.method == "GET" || request.method == "HEAD" else { return .message(405, "method_not_allowed") }
        guard let asset = ui.asset(for: path) else { return .message(404, "asset_not_prepared") }
        do {
            let bytes = try Data(contentsOf: ui.directory.appendingPathComponent(String(asset.path.dropFirst())))
            return HTTPResponse(status: 200, headers: ["Content-Type": asset.contentType, "X-Content-Type-Options": "nosniff"], body: bytes)
        } catch { return .message(503, "cached_asset_unavailable") }
    }
}

// All connection state is confined to queue. The async responder never mutates it directly.
private final class HTTPConnection: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let respond: (HTTPRequest) async -> HTTPResponse
    private let finish: () -> Void
    private var buffer = Data()
    private var task: Task<Void, Never>?
    private var timeout: DispatchWorkItem?
    private var closed = false

    init(connection: NWConnection, queue: DispatchQueue, respond: @escaping (HTTPRequest) async -> HTTPResponse, finish: @escaping () -> Void) {
        self.connection = connection; self.queue = queue; self.respond = respond; self.finish = finish
    }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.cancel() }
        }
        connection.start(queue: queue)
        let timeout = DispatchWorkItem { [weak self] in self?.cancel() }
        self.timeout = timeout
        queue.asyncAfter(deadline: .now() + 130, execute: timeout)
        receive()
    }
    func cancel() {
        guard !closed else { return }
        closed = true; timeout?.cancel(); task?.cancel(); connection.cancel(); finish()
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] bytes, _, complete, error in
            guard let self, !self.closed else { return }
            if let bytes { self.buffer.append(bytes) }
            do {
                if let request = try HTTPRequest.parse(self.buffer) {
                    self.buffer.removeAll()
                    self.task = Task {
                        let response = await self.respond(request)
                        self.queue.async { self.send(response, headOnly: request.method == "HEAD") }
                    }
                    // WebKit closes canceled fetches; release their upstream work immediately.
                    self.connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak self] bytes, _, complete, error in
                        if complete || error != nil || !(bytes?.isEmpty ?? true) { self?.cancel() }
                    }
                } else if complete || error != nil { self.cancel() }
                else { self.receive() }
            } catch { self.send(.message(400, "invalid_request")) }
        }
    }
    private func send(_ response: HTTPResponse, headOnly: Bool = false) {
        guard !closed else { return }
        guard let stream = response.stream, !headOnly else {
            connection.send(content: response.encoded(headOnly: headOnly), completion: .contentProcessed { [weak self] _ in self?.cancel() })
            return
        }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.sendBytes(response.encodedHeaders())
                try await stream.write { chunk in
                    try Task.checkCancellation()
                    var framed = Data((String(chunk.count, radix: 16) + "\r\n").utf8)
                    framed.append(chunk); framed.append(Data("\r\n".utf8))
                    try await self.sendBytes(framed)
                }
                try await self.sendBytes(Data("0\r\n\r\n".utf8))
            } catch { /* A truncated response closes without a terminal chunk; fetch rejects it. */ }
            self.queue.async { self.cancel() }
        }
    }
    private func sendBytes(_ bytes: Data) async throws {
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard !self.closed else { continuation.resume(throwing: CancellationError()); return }
                self.connection.send(content: bytes, completion: .contentProcessed { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                })
            }
        }
    }
}
