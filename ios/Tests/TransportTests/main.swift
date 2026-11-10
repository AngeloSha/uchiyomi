// Runs the production HTTP framing/response code on Linux without pretending to run WebKit,
// Apple networking, signing or the iOS SDK. No cryptography is replaced in the application.
import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

// A child leaves an upload exactly as a killed app does: the kernel releases its lock but no
// Swift deinitializer runs. The parent must reap that owned directory, not another active one.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--abandon-upload" {
    let session = try UploadSpoolSession(root: URL(fileURLWithPath: CommandLine.arguments[2]))
    try Data(repeating: 19, count: 131_072).write(to: session.directory.appendingPathComponent("body"))
    FileHandle.standardOutput.write(Data((session.directory.path + "\n").utf8))
    _exit(0)
}

enum ClientError: Error { case invalid(String) }
var passed = 0
func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try value() else { throw NSError(domain: "transport-test", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    passed += 1
}
func rejects(_ body: () throws -> Void) throws {
    do { try body() } catch { passed += 1; return }
    throw NSError(domain: "transport-test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Accepted malformed input"])
}
let root = FileManager.default.temporaryDirectory.appendingPathComponent("uchiyomi-native-framing-" + UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
func decoder(limit: Int64 = 32 * 1024 * 1024, allow: Bool = true) -> HTTPRequestDecoder {
    HTTPRequestDecoder(directory: root, accept: { _ in allow }, bodyLimit: { _ in limit })
}
func wire(_ headers: String, path: String = "/api/library/upload") -> Data {
    Data("POST \(path) HTTP/1.1\r\nHost: localhost:48521\r\n\(headers)\r\n\r\n".utf8)
}
// Upload exceeds the old eight-MiB ceiling while heap buffering remains one network chunk.
do {
    let d = decoder(); defer { d.cleanup() }
    let size = 9 * 1024 * 1024 + 173
    try check(try d.append(wire("Content-Length: \(size)")) == nil, "Headers alone finished upload")
    var request: HTTPRequest?
    var maxBuffered = 0
    for offset in stride(from: 0, to: size, by: 65_536) {
        request = try d.append(Data(repeating: UInt8((offset / 65_536) % 251), count: min(65_536, size - offset)))
        maxBuffered = max(maxBuffered, d.bufferedBytes)
    }
    let body = try Data(contentsOf: request!.bodyFile!)
    try check(request?.body.isEmpty == true, "Large upload was returned in memory")
    try check(body.count == size, "Upload lost bytes")
    try check(body[0] == 0 && body[65_536] == 1 && body.last == UInt8(((size-1)/65_536)%251), "Upload contents changed")
    try check(maxBuffered <= 65_536, "Parser retained upload in memory")
    let file = request!.bodyFile!; d.cleanup()
    try check(!FileManager.default.fileExists(atPath: file.path), "Finished upload file leaked")
}
// Exercise every boundary of chunk-size/data/CRLF/terminal framing, not just aligned chunks.
do {
    let encoded = wire("Transfer-Encoding: chunked") + Data("3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n".utf8)
    for width in [1, 2, 3, 7, 64, 65_536] {
        let d = decoder(); defer { d.cleanup() }
        var result: HTTPRequest?
        for start in stride(from: 0, to: encoded.count, by: width) {
            result = try d.append(Data(encoded[start..<min(encoded.count, start + width)]))
        }
        try check(try Data(contentsOf: result!.bodyFile!) == Data("abcdefg".utf8), "Chunked upload changed bytes")
        try check(d.bodyBytes == 7 && d.bufferedBytes == 0, "Chunk framing leaked into body")
    }
}
// Authentication/ordinary JSON is bounded memory only, including partial/chunked bodies.
for headers in ["Content-Length: 54", "Transfer-Encoding: chunked"] {
    let d = decoder(); defer { d.cleanup() }
    let credentials = Data(#"{"username":"fixture","password":"secret","code":"1234"}"#.utf8)
    let isChunked = headers.hasPrefix("Transfer")
    let first = wire(isChunked ? headers : "Content-Length: \(credentials.count)", path: "/auth/login")
    try check(try d.append(first) == nil, "Auth body finished without its bytes")
    let prefix = Data(credentials.prefix(10)), rest = Data(credentials.dropFirst(10))
    let partial = isChunked ? Data((String(prefix.count, radix: 16) + "\r\n").utf8) + prefix + Data("\r\n".utf8) : prefix
    try check(try d.append(partial) == nil, "Partial auth body unexpectedly finished")
    try check(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "Partial password/TOTP was written to disk")
    let ending = isChunked ? Data((String(rest.count, radix: 16) + "\r\n").utf8) + rest + Data("\r\n0\r\n\r\n".utf8) : rest
    let request = try d.append(ending)
    try check(request?.body == credentials && request?.bodyFile == nil, "Auth body did not remain in memory")
    try check(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "Completed password/TOTP was written to disk")
}
do {
    let activeA = try UploadSpoolSession(root: root)
    let activeB = try UploadSpoolSession(root: root)
    defer { activeA.cleanup(); activeB.cleanup() }
    try Data("active profile A".utf8).write(to: activeA.directory.appendingPathComponent("body"))
    try Data("active profile B".utf8).write(to: activeB.directory.appendingPathComponent("body"))
    let unrelated = root.appendingPathComponent("unrelated-personal-data", isDirectory: true)
    try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: false)
    try Data("retain".utf8).write(to: unrelated.appendingPathComponent("keep"))
    defer { try? FileManager.default.removeItem(at: unrelated) }
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--abandon-upload", root.path]; process.standardOutput = output
    try process.run(); process.waitUntilExit()
    let abandoned = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
    try check(process.terminationStatus == 0 && FileManager.default.fileExists(atPath: abandoned + "/body"), "Crash fixture did not leave its upload")
    try UploadSpoolSession.reapAbandoned(root: root)
    try check(!FileManager.default.fileExists(atPath: abandoned), "Abandoned upload was not reaped")
    try check(try Data(contentsOf: activeA.directory.appendingPathComponent("body")) == Data("active profile A".utf8), "Reaper deleted another active profile A upload")
    try check(try Data(contentsOf: activeB.directory.appendingPathComponent("body")) == Data("active profile B".utf8), "Reaper deleted another active profile B upload")
    try check(try Data(contentsOf: unrelated.appendingPathComponent("keep")) == Data("retain".utf8), "Reaper deleted unowned data")
}
for framing in ["Content-Length: 1\r\ncontent-length: 2", "Content-Length: -1", "Content-Length: 999999999999999999999999", "Content-Length: 1\r\nTransfer-Encoding: chunked", "Transfer-Encoding: gzip, chunked", "Transfer-Encoding: chunked\r\nTrailer: Authorization", "Content-Length: 1\r\nExpect: 100-continue"] {
    let d = decoder(); defer { d.cleanup() }
    try rejects { _ = try d.append(wire(framing) + Data("a".utf8)) }
}
for extra in ["1\r\naX\r\n0\r\n\r\n", "g\r\na\r\n0\r\n\r\n", "0\r\nX-Hidden: unsafe\r\n\r\n", "0\r\n\r\nGET / HTTP/1.1\r\n\r\n", "2;injected=1\r\nab\r\n0\r\n\r\n"] {
    let d = decoder(); defer { d.cleanup() }
    try rejects { _ = try d.append(wire("Transfer-Encoding: chunked") + Data(extra.utf8)) }
}
do {
    let d = decoder(limit: 3); defer { d.cleanup() }
    try rejects { _ = try d.append(wire("Content-Length: 4") + Data("abcd".utf8)) }
    try check(d.bodyBytes == 0, "Oversized declared body was written")
}
do {
    let d = decoder(limit: 3); defer { d.cleanup() }
    try rejects { _ = try d.append(wire("Transfer-Encoding: chunked") + Data("4\r\nabcd\r\n0\r\n\r\n".utf8)) }
    try check(d.bodyBytes == 0, "Oversized chunk was written")
}
do {
    let d = decoder(allow: false); defer { d.cleanup() }
    try rejects { _ = try d.append(wire("Content-Length: 5") + Data("hello".utf8)) }
    try check(d.bodyBytes == 0, "Unauthenticated caller created upload data")
}
do {
    let d = decoder()
    _ = try d.append(wire("Content-Length: 200") + Data("partial".utf8))
    try check(try FileManager.default.contentsOfDirectory(atPath: root.path).count == 1, "Partial upload was not spooled")
    d.cleanup()
    try check(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "Cancelled partial upload was not removed")
}
do {
    let privateHeaders = HTTPResponse(status: 200, headers: ["Vary": "*", "Cache-Control": "private, no-store", "X-Uchiyomi-Private": "1"])
    let text = String(data: privateHeaders.encoded(), encoding: .utf8)!
    try check(text.contains("Vary: *\r\n"), "Native encoding dropped Vary star")
    try check(text.contains("X-Uchiyomi-Private: 1\r\n"), "Native encoding dropped private marker")
    try check(text.components(separatedBy: "Cache-Control:").count == 2 && text.contains("Cache-Control: private, no-store\r\n"), "Native encoding lost or duplicated cache policy")
    let shared = HTTPResponse(status: 200, headers: ["Cache-Control": "public, max-age=3600"])
    try check(String(data: shared.encoded(), encoding: .utf8)!.contains("Cache-Control: no-store\r\n"), "Native gateway enabled shared response caching")
}
print("PASS \(passed) portable production-HTTP assertions; native WebKit/signing/device checks remain separate")
