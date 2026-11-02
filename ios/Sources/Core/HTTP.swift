import Foundation

struct HTTPRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
    var path: String? {
        let raw = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard let decoded = raw.removingPercentEncoding, decoded.hasPrefix("/"), !decoded.hasPrefix("//"),
              !decoded.contains("\\"), !decoded.contains("\0"),
              !decoded.split(separator: "/", omittingEmptySubsequences: false).contains("..") else { return nil }
        return decoded
    }

    // One request per connection. Reject ambiguous framing rather than guessing where a request ends.
    static func parse(_ data: Data) throws -> HTTPRequest? {
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
              first[1].hasPrefix("/"), !first[1].hasPrefix("//") else { throw ClientError.invalid("Invalid request line.") }
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
        guard headers["transfer-encoding"] == nil else { throw ClientError.invalid("Chunked uploads are not supported.") }
        let lengthText = headers["content-length"] ?? "0"
        guard !lengthText.isEmpty, lengthText.allSatisfy({ $0.isASCII && $0.isNumber }),
              let length = Int(lengthText), length <= 8 * 1024 * 1024 else { throw ClientError.invalid("Invalid or excessive body length.") }
        let available = data.count - end.upperBound
        if available < length { return nil }
        guard available == length else { throw ClientError.invalid("Unexpected bytes after request body.") }
        let request = HTTPRequest(method: String(first[0]), target: String(first[1]), headers: headers, body: Data(data[end.upperBound...]))
        guard request.path != nil else { throw ClientError.invalid("Invalid request path.") }
        return request
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
            if !["content-length", "connection", "transfer-encoding"].contains(key.lowercased()) { text += "\(key): \(value)\r\n" }
        }
        if stream != nil && !headOnly { text += "Transfer-Encoding: chunked\r\n" }
        else { text += "Content-Length: \(headOnly ? headLength ?? Int64(body.count) : Int64(body.count))\r\n" }
        text += "Connection: close\r\nCache-Control: no-store\r\n\r\n"
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
