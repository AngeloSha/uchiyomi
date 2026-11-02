import Foundation
import Security

protocol CookieVault {
    func read() throws -> Data?
    func write(_ data: Data) throws
}

// Availability checks never read or mutate a saved account's cookies.
private struct ProbeCookieVault: CookieVault {
    func read() -> Data? { nil }
    func write(_ data: Data) {}
}

extension ServerAvailability {
    static func check(_ origin: URL) async -> Self {
        do {
            let client = try RemoteClient(origin: origin, vault: ProbeCookieVault(), resourceTimeout: 5)
            defer { client.cancel() }
            let reply = try await client.fetch("/auth/config", maxBytes: 64 * 1024, timeout: 5)
            try ServerCompatibility.validate(reply)
            return .available
        } catch { return failure(error) }
    }
}

struct KeychainCookieVault: CookieVault {
    let profileID: UUID
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "uchiyomi.server-cookies",
         kSecAttrAccount as String: profileID.uuidString]
    }
    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ClientError.invalid("Cannot unlock the saved server session (\(status)).") }
        return result as? Data
    }
    func write(_ data: Data) throws {
        let values: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(values) { _, value in value } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ClientError.invalid("Cannot save the server session (\(status)).") }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ClientError.invalid("Cannot remove the saved session (\(status)).")
        }
    }
}

// Keep cancellation independent of URLSession invalidation. An async request can
// enter Foundation after its profile closes; invalidating then raises an Obj-C
// exception instead of a catchable Swift error. Registration runs synchronously
// during task creation, so cancellation also catches tasks created in that race.
private final class RemoteSessionLifetime: @unchecked Sendable {
    private final class Reference {
        weak var task: URLSessionTask?
        init(_ task: URLSessionTask) { self.task = task }
    }
    private let lock = NSLock()
    private var cancelled = false
    private var tasks: [Int: Reference] = [:]

    func whileActive<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw CancellationError() }
        return try body()
    }
    func register(_ task: URLSessionTask) {
        lock.lock()
        let shouldCancel = cancelled
        if !shouldCancel {
            tasks = tasks.filter { $0.value.task != nil }
            tasks[task.taskIdentifier] = Reference(task)
        }
        lock.unlock()
        if shouldCancel { task.cancel() }
    }
    func cancel() {
        lock.lock()
        cancelled = true
        let active = tasks.values.compactMap { $0.task }
        tasks.removeAll()
        lock.unlock()
        active.forEach { $0.cancel() }
    }
}

// Redirects are deliberately rejected. In particular, a server cannot move a
// bearer token, password body, or refresh cookie to an unrelated origin using an HTTP redirect.
private class NoRedirects: NSObject, URLSessionTaskDelegate {
    let lifetime: RemoteSessionLifetime
    init(lifetime: RemoteSessionLifetime) { self.lifetime = lifetime }
    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) { lifetime.register(task) }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private final class BoundedDownload: NoRedirects, URLSessionDownloadDelegate {
    let limit: Int64
    private let lock = NSLock()
    private var failure: Error?
    var validationError: Error? { lock.lock(); defer { lock.unlock() }; return failure }
    init(limit: Int, lifetime: RemoteSessionLifetime) { self.limit = Int64(limit); super.init(lifetime: lifetime) }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let error: Error?
        if let response = downloadTask.response as? HTTPURLResponse, (500...599).contains(response.statusCode) {
            error = ClientError.serverUnavailable(response.statusCode)
        } else if totalBytesWritten > limit || totalBytesExpectedToWrite > limit {
            error = ClientError.invalid("The server response exceeds the size limit.")
        } else { error = nil }
        if let error {
            lock.lock(); failure = error; lock.unlock()
            downloadTask.cancel()
        }
    }
}

final class RemoteClient {
    let origin: URL
    private let session: URLSession
    private let cookies: HTTPCookieStorage
    private let vault: CookieVault
    private let lifetime: RemoteSessionLifetime

    init(origin: URL, vault: CookieVault, configuration: URLSessionConfiguration = .ephemeral,
         resourceTimeout: TimeInterval = 120) throws {
        self.origin = origin
        self.vault = vault
        // A new ephemeral configuration owns its own cookie store. Never use .shared.
        guard let cookies = configuration.httpCookieStorage else { throw ClientError.invalid("No isolated cookie store available.") }
        self.cookies = cookies
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = resourceTimeout
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        if let data = try vault.read(), let records = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Any]] {
            for record in records {
                let properties = Dictionary(uniqueKeysWithValues: record.map { (HTTPCookiePropertyKey($0.key), $0.value) })
                if let cookie = HTTPCookie(properties: properties), cookie.expiresDate.map({ $0 > Date() }) ?? true { cookies.setCookie(cookie) }
            }
        }
        let lifetime = RemoteSessionLifetime()
        self.lifetime = lifetime
        session = URLSession(configuration: configuration, delegate: NoRedirects(lifetime: lifetime), delegateQueue: nil)
    }

    func cancel() { lifetime.cancel() }
    // Active async methods retain this client until task creation has finished.
    deinit { session.invalidateAndCancel() }

    func url(for target: String) throws -> URL {
        guard target.hasPrefix("/"), !target.hasPrefix("//"), !target.contains("\\"),
              !target.contains("#"), let result = URL(string: origin.absoluteString + target),
              result.scheme == origin.scheme, result.host == origin.host, result.port == origin.port else {
            throw ClientError.invalid("Invalid server request.")
        }
        return result
    }

    private func persistCookies() throws {
        try lifetime.whileActive {
            // A late response must not recreate credentials after its profile has been forgotten.
            let records = (cookies.cookies ?? []).compactMap { cookie -> [String: Any]? in
                cookie.properties.map { Dictionary(uniqueKeysWithValues: $0.map { ($0.key.rawValue, $0.value) }) }
            }
            try vault.write(PropertyListSerialization.data(fromPropertyList: records, format: .binary, options: 0))
        }
    }

    private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var kept: [String: String] = [:]
        for name in ["Content-Type", "Content-Range", "Accept-Ranges", "Retry-After", "ETag", "Last-Modified"] {
            if let value = response.value(forHTTPHeaderField: name) { kept[name] = value }
        }
        return kept
    }
    private func validate(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse, ![301,302,303,307,308].contains(http.statusCode) else {
            throw ClientError.invalid("The server redirected this request. Enter its final HTTPS address; external sign-in is not supported.")
        }
        return http
    }

    func fetch(_ target: String, maxBytes: Int, method: String = "GET", headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval = 15) async throws -> HTTPResponse {
        try lifetime.whileActive {}
        var request = URLRequest(url: try url(for: target))
        request.timeoutInterval = timeout
        request.httpMethod = method
        request.httpBody = body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        // Download to a temporary file so a large/malformed response does not grow the app heap unbounded.
        let download = BoundedDownload(limit: maxBytes, lifetime: lifetime)
        let file: URL, response: URLResponse
        do { (file, response) = try await session.download(for: request, delegate: download) }
        catch { throw download.validationError ?? error }
        defer { try? FileManager.default.removeItem(at: file) }
        if let error = download.validationError { throw error }
        try persistCookies()
        let http = try validate(response)
        try ClientError.checkAvailability(HTTPResponse(status: http.statusCode))
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= maxBytes else { throw ClientError.invalid("The server response exceeds the size limit.") }
        return HTTPResponse(status: http.statusCode, headers: responseHeaders(http), body: try Data(contentsOf: file))
    }

    func proxy(_ request: HTTPRequest) async -> HTTPResponse {
        do {
            try lifetime.whileActive {}
            // Cookie, Host, Referer, forwarded headers and the local gateway secret never pass through.
            var headers: [String: String] = ["Origin": origin.absoluteString, "Referer": origin.absoluteString + "/"]
            for key in ["authorization", "content-type", "accept", "accept-language", "range", "if-range"] {
                if let value = request.headers[key] { headers[key] = value }
            }
            var upstream = URLRequest(url: try url(for: request.target))
            upstream.httpMethod = request.method
            upstream.httpBody = request.body.isEmpty ? nil : request.body
            for (name, value) in headers { upstream.setValue(value, forHTTPHeaderField: name) }
            let (bytes, response) = try await session.bytes(for: upstream)
            let http = try validate(response)
            try persistCookies()
            let limit = 64 * 1024 * 1024
            guard http.expectedContentLength <= limit else { throw ClientError.invalid("The server response exceeds 64 MB.") }
            if request.method == "HEAD" || [204,304].contains(http.statusCode) {
                return HTTPResponse(status: http.statusCode, headers: responseHeaders(http), headLength: max(0, http.expectedContentLength))
            }
            let stream = HTTPBodyStream { send in
                var chunk = Data(); chunk.reserveCapacity(65_536)
                var count = 0
                for try await byte in bytes {
                    try Task.checkCancellation()
                    count += 1
                    guard count <= limit else { throw ClientError.invalid("The server response exceeds 64 MB.") }
                    chunk.append(byte)
                    if chunk.count == 65_536 { try await send(chunk); chunk.removeAll(keepingCapacity: true) }
                }
                if http.value(forHTTPHeaderField: "Content-Encoding") == nil, http.expectedContentLength >= 0,
                   count != http.expectedContentLength { throw ClientError.invalid("The chapter transfer ended early.") }
                if !chunk.isEmpty { try await send(chunk) }
            }
            return HTTPResponse(status: http.statusCode, headers: responseHeaders(http), stream: stream)
        } catch {
            // A transport failure must never look like a 401: the frontend retains its offline identity.
            return .message(503, "server_unavailable")
        }
    }
}
