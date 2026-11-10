import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

enum HTTPFramingError: Error { case localAccessDenied }

struct HTTPRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
    // Large uploads are spooled incrementally, then read by URLSession without loading the file into RAM.
    var bodyFile: URL? = nil
    var path: String? {
        let raw = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard let decoded = raw.removingPercentEncoding, decoded.hasPrefix("/"), !decoded.hasPrefix("//"),
              !decoded.contains("\\"), !decoded.contains("\0"),
              !decoded.split(separator: "/", omittingEmptySubsequences: false).contains("..") else { return nil }
        return decoded
    }

    // One request per connection. Header parsing is shared by the small in-memory fixtures and
    // production's incremental file-backed decoder. Ambiguous framing is always refused.
    static func head(_ data: Data, allowChunked: Bool = false) throws -> (request: HTTPRequest, offset: Int, length: Int64?, chunked: Bool)? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            if data.count > 32_768 { throw ClientError.invalid("Request headers are too large.") }
            return nil
        }
        guard end.lowerBound <= 32_768, let text = String(data: data[..<end.lowerBound], encoding: .utf8) else {
            throw ClientError.invalid("Invalid request headers.")
        }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, ["HTTP/1.1", "HTTP/1.0"].contains(String(first[2])),
              ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(String(first[0])),
              first[1].hasPrefix("/"), !first[1].hasPrefix("//"),
              !first[1].contains(where: { $0.asciiValue.map { $0 < 33 || $0 == 127 } ?? false }) else {
            throw ClientError.invalid("Invalid request line.")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw ClientError.invalid("Invalid header.") }
            let name = String(line[..<colon]).lowercased()
            guard !name.isEmpty, name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "!#$%&'*+-.^_`|~".contains($0)) }), headers[name] == nil else {
                throw ClientError.invalid("Duplicate or invalid request header.")
            }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !value.contains(where: { character in
                guard let byte = character.asciiValue else { return false }
                return (byte < 32 && byte != 9) || byte == 127
            }) else { throw ClientError.invalid("Invalid header value.") }
            headers[name] = value
        }
        let chunked = headers["transfer-encoding"] != nil
        guard !chunked || (allowChunked && headers["transfer-encoding"]?.lowercased() == "chunked" && headers["content-length"] == nil),
              headers["expect"] == nil, headers["trailer"] == nil else {
            throw ClientError.invalid("Unsupported or ambiguous request framing.")
        }
        let length: Int64?
        if chunked { length = nil }
        else {
            let text = headers["content-length"] ?? "0"
            guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int64(text) else {
                throw ClientError.invalid("Invalid body length.")
            }
            length = value
        }
        let request = HTTPRequest(method: String(first[0]), target: String(first[1]), headers: headers, body: Data())
        guard request.path != nil else { throw ClientError.invalid("Invalid request path.") }
        return (request, end.upperBound, length, chunked)
    }

    static func parse(_ data: Data) throws -> HTTPRequest? {
        guard let head = try head(data) else { return nil }
        let length = head.length ?? 0
        guard length <= 8 * 1024 * 1024 else { throw ClientError.invalid("Excessive in-memory body length.") }
        let available = data.count - head.offset
        if available < length { return nil }
        guard available == length else { throw ClientError.invalid("Unexpected bytes after request body.") }
        return HTTPRequest(method: head.request.method, target: head.request.target, headers: head.request.headers,
                           body: Data(data[head.offset...]))
    }

}

/// Each active upload owns a locked session directory. A cold launch can reap only marked,
/// unlocked sessions left by a terminated process; another profile's active upload is never deleted.
final class UploadSpoolSession {
    static var defaultRoot: URL { FileManager.default.temporaryDirectory.appendingPathComponent("UchiyomiUploadSpools", isDirectory: true) }
    private static let marker = ".uchiyomi-upload-session"
    private static let markerData = Data("uchiyomi-upload-spool-v1\n".utf8)
    let directory: URL
    private var descriptor: Int32 = -1

    init(root: URL = UploadSpoolSession.defaultRoot) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Self.reapAbandoned(root: root)
        directory = root.appendingPathComponent("session-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        descriptor = open(directory.appendingPathComponent(".lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            if descriptor >= 0 { _ = close(descriptor); descriptor = -1 }
            try? fm.removeItem(at: directory)
            throw CocoaError(.fileWriteUnknown)
        }
        do { try Self.markerData.write(to: directory.appendingPathComponent(Self.marker), options: .atomic) }
        catch { cleanup(); throw error }
    }
    deinit { cleanup() }
    func cleanup() {
        guard descriptor >= 0 else { return }
        try? FileManager.default.removeItem(at: directory)
        _ = flock(descriptor, LOCK_UN); _ = close(descriptor); descriptor = -1
    }
    static func reapAbandoned(root: URL = UploadSpoolSession.defaultRoot) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else { return }
        for directory in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            let name = directory.lastPathComponent
            guard name.hasPrefix("session-"), UUID(uuidString: String(name.dropFirst(8))) != nil,
                  let values = try? directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  (try? Data(contentsOf: directory.appendingPathComponent(marker))) == markerData else { continue }
            let fd = open(directory.appendingPathComponent(".lock").path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { continue }
            defer { _ = close(fd) }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { continue }
            defer { _ = flock(fd, LOCK_UN) }
            try fm.removeItem(at: directory)
        }
    }
}

/// Bounds memory to one socket chunk plus headers. Uploads are copied to a private temporary file;
/// only upload routes with a validated local capability can create one. Auth/JSON stays in memory.
/// The upstream server still checks its own content
/// limits and permissions. The file is removed on success, malformed input, timeout and cancellation.
final class HTTPRequestDecoder {
    private enum State { case headers, fixed(Int64), chunkSize, chunk(Int64), chunkCRLF, chunkEnd, done }
    private var state = State.headers
    private var buffer = Data()
    private var request: HTTPRequest?
    private var file: FileHandle?
    private var fileURL: URL?
    private var spoolSession: UploadSpoolSession?
    private var memoryBody = Data()
    private var count: Int64 = 0
    private var limit: Int64 = 0
    private let directory: URL
    private let accept: (HTTPRequest) -> Bool
    private let bodyLimit: (HTTPRequest) -> Int64
    var bufferedBytes: Int { buffer.count }
    var bodyBytes: Int64 { count }

    init(directory: URL = UploadSpoolSession.defaultRoot,
         accept: @escaping (HTTPRequest) -> Bool,
         bodyLimit: @escaping (HTTPRequest) -> Int64) {
        self.directory = directory; self.accept = accept; self.bodyLimit = bodyLimit
    }
    deinit { cleanup() }
    func cleanup() {
        try? file?.close(); file = nil
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        spoolSession?.cleanup(); spoolSession = nil
        memoryBody.removeAll(keepingCapacity: false)
    }
    private func appendBody(_ data: Data) throws {
        guard Int64(data.count) <= limit - count else { throw ClientError.invalid("The upload exceeds the local transfer limit.") }
        if data.isEmpty { return }
        guard request?.path == "/api/library/upload" else {
            // Password/TOTP and other bounded JSON must not become durable plaintext after a crash.
            memoryBody.append(data); count += Int64(data.count); return
        }
        if file == nil {
            let session = try UploadSpoolSession(root: directory)
            spoolSession = session
            let url = session.directory.appendingPathComponent("body")
            guard FileManager.default.createFile(atPath: url.path, contents: nil,
                attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            fileURL = url; file = try FileHandle(forWritingTo: url)
        }
        // Keep a small reserve for WebKit and the atomic offline database, including chunked uploads.
        if count == 0 || count / (16 * 1024 * 1024) != (count + Int64(data.count)) / (16 * 1024 * 1024) {
            let stats = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
            if let free = stats[.systemFreeSize] as? NSNumber,
               free.int64Value < Int64(data.count) + 32 * 1024 * 1024 { throw CocoaError(.fileWriteOutOfSpace) }
        }
        try file?.write(contentsOf: data)
        count += Int64(data.count)
    }
    func append(_ data: Data) throws -> HTTPRequest? {
        guard data.count <= 65_536 else { throw ClientError.invalid("Oversized socket chunk.") }
        if case .done = state { throw ClientError.invalid("Unexpected request bytes.") }
        buffer.append(data)
        while true {
            switch state {
            case .headers:
                guard let head = try HTTPRequest.head(buffer, allowChunked: true) else { return nil }
                guard accept(head.request) else { throw HTTPFramingError.localAccessDenied }
                request = head.request; limit = bodyLimit(head.request)
                guard limit >= 0, head.length.map({ $0 <= limit }) ?? true else { throw ClientError.invalid("The upload exceeds the local transfer limit.") }
                buffer = Data(buffer.dropFirst(head.offset))
                state = head.chunked ? .chunkSize : .fixed(head.length ?? 0)
            case .fixed(let remaining):
                let taken = min(Int64(buffer.count), remaining)
                try appendBody(Data(buffer.prefix(Int(taken))))
                buffer = Data(buffer.dropFirst(Int(taken)))
                if taken < remaining { state = .fixed(remaining - taken); return nil }
                guard buffer.isEmpty else { throw ClientError.invalid("Unexpected bytes after request body.") }
                state = .done
            case .chunkSize:
                guard let end = buffer.range(of: Data("\r\n".utf8)) else {
                    guard buffer.count <= 128 else { throw ClientError.invalid("Invalid chunk framing.") }
                    return nil
                }
                // No extensions/trailers: WebKit's ordinary chunked framing needs neither.
                guard end.lowerBound > 0, end.lowerBound <= 16,
                      let text = String(data: buffer[..<end.lowerBound], encoding: .ascii),
                      text.allSatisfy({ $0.isHexDigit }), let size = Int64(text, radix: 16), size <= limit - count else {
                    throw ClientError.invalid("Invalid or excessive chunk length.")
                }
                buffer = Data(buffer.dropFirst(end.upperBound))
                state = size == 0 ? .chunkEnd : .chunk(size)
            case .chunk(let remaining):
                if buffer.isEmpty { return nil }
                let taken = min(Int64(buffer.count), remaining)
                try appendBody(Data(buffer.prefix(Int(taken))))
                buffer = Data(buffer.dropFirst(Int(taken)))
                state = taken == remaining ? .chunkCRLF : .chunk(remaining - taken)
            case .chunkCRLF:
                guard buffer.count >= 2 else { return nil }
                guard buffer.prefix(2) == Data("\r\n".utf8) else { throw ClientError.invalid("Invalid chunk delimiter.") }
                buffer = Data(buffer.dropFirst(2)); state = .chunkSize
            case .chunkEnd:
                guard buffer.count >= 2 else { return nil }
                guard buffer == Data("\r\n".utf8) else { throw ClientError.invalid("Trailers or bytes after upload are not supported.") }
                buffer.removeAll(); state = .done
            case .done:
                try file?.close(); file = nil
                guard let request else { throw ClientError.invalid("Missing request.") }
                return HTTPRequest(method: request.method, target: request.target, headers: request.headers,
                                   body: memoryBody, bodyFile: fileURL)
            }
        }
    }
}

struct HTTPResponse {
    let status: Int
    var headers: [String: String] = [:]
    var body = Data()
    var stream: HTTPBodyStream?
    var headLength: Int64?

    static func message(_ status: Int, _ text: String) -> HTTPResponse {
        HTTPResponse(status: status, headers: ["Content-Type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: ["error": text])) ?? Data())
    }
    func encodedHeaders(headOnly: Bool = false) -> Data {
        var text = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Response")\r\n"
        for (key, value) in headers where !key.contains("\r") && !key.contains("\n") && !value.contains("\r") && !value.contains("\n") {
            if !["content-length", "connection", "transfer-encoding", "cache-control"].contains(key.lowercased()) { text += "\(key): \(value)\r\n" }
        }
        if stream != nil && !headOnly { text += "Transfer-Encoding: chunked\r\n" }
        else { text += "Content-Length: \(headOnly ? headLength ?? Int64(body.count) : Int64(body.count))\r\n" }
        let upstreamCache = headers.first { $0.key.lowercased() == "cache-control" }?.value ?? ""
        let cache = upstreamCache.lowercased().split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces) == "no-store" }
            && !upstreamCache.contains("\r") && !upstreamCache.contains("\n") ? upstreamCache : "no-store"
        text += "Connection: close\r\nCache-Control: \(cache)\r\n\r\n"
        return Data(text.utf8)
    }
    func encoded(headOnly: Bool = false) -> Data {
        var data = encodedHeaders(headOnly: headOnly)
        if !headOnly { data.append(body) }
        return data
    }
}

/// A single-consumer body. The producer awaits each send so the gateway applies back pressure.
final class HTTPBodyStream {
    let write: (@escaping (Data) async throws -> Void) async throws -> Void
    init(write: @escaping (@escaping (Data) async throws -> Void) async throws -> Void) { self.write = write }
}
