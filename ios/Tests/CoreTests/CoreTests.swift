import Foundation
import Testing
@testable import UchiyomiCore

final class CoreTests {
    let profile = ServerProfile(id: UUID(), origin: URL(string: "https://books.example")!, port: 48521)
    func request(_ target: String = "/", headers: [String: String] = [:]) -> HTTPRequest {
        HTTPRequest(method: "GET", target: target, headers: headers, body: Data())
    }

    @Test func testOriginNormalizationAndUnsafeInputs() throws {
        #expect(try ServerProfile.parse("  Books.Example:443/  ").absoluteString == "https://books.example")
        #expect(try ServerProfile.parse("https://books.example:8443").port == 8443)
        for value in ["", "http://books.example", "https://u:p@books.example", "https://books.example/subpath", "https://books.example?token=secret", "https://books.example#fragment", "https://books.example:99999"] {
            #expect(throws: (any Error).self) { try ServerProfile.parse(value) }
        }
        #expect(throws: (any Error).self) { try ServerProfile.parse("http://localhost:3000") }
        _ = try ServerProfile.parse("http://localhost:3000", allowLoopbackHTTP: true)
        #expect(throws: (any Error).self) { try ServerProfile.parse("http://example.com", allowLoopbackHTTP: true) }
    }

    @Test func testRequestFramingAndTraversal() throws {
        let partial = Data("POST /auth/login HTTP/1.1\r\nHost: localhost:48521\r\nContent-Length: 2\r\n\r\n{".utf8)
        #expect(try HTTPRequest.parse(partial) == nil)
        let parsed = try #require(try HTTPRequest.parse(partial + Data("}".utf8)))
        #expect(parsed.body == Data("{}".utf8))
        #expect(parsed.path == "/auth/login")
        for header in ["Content-Length: 0\r\ncontent-length: 2", "Content-Length: -1", "Transfer-Encoding: chunked", "Content-Length: 999999999"] {
            #expect(throws: (any Error).self) { try HTTPRequest.parse(Data("POST / HTTP/1.1\r\n\(header)\r\n\r\n".utf8)) }
        }
        #expect(throws: (any Error).self) { try HTTPRequest.parse(partial + Data("}GET / HTTP/1.1\r\n\r\n".utf8)) }
        #expect(request("/%2e%2e/secrets").path == nil)
        #expect(request("/%2fexample.com").path == nil)
        #expect(request("/a%00b").path == nil)
        #expect(request("/reader/?bookId=a%2Fb").path == "/reader/")
    }

    @Test func testGatewayRequiresHostOriginAndCapability() {
        let policy = GatewayPolicy(profile: profile, token: "test-token")
        var headers = ["host": profile.localHost, "cookie": "uchiyomi_gateway=test-token"]
        #expect(policy.allows(request(headers: headers)))
        headers["origin"] = profile.localOrigin.absoluteString
        #expect(policy.allows(request(headers: headers)))
        headers["origin"] = "https://unrelated.example"
        #expect(!(policy.allows(request(headers: headers))))
        headers["origin"] = nil
        headers["host"] = "attacker.example:48521"
        #expect(!(policy.allows(request(headers: headers))))
        headers["host"] = profile.localHost
        headers["cookie"] = "uchiyomi_gateway=test-token; uchiyomi_gateway=other"
        #expect(!(policy.allows(request(headers: headers))))
        headers["cookie"] = nil
        #expect(!(policy.allows(request(headers: headers))))
        #expect(policy.isProxyPath("/auth/login"))
        #expect(!(policy.isProxyPath("/authentication")))
        #expect(!(policy.isProxyPath("/https://elsewhere.example")))
    }

    @Test func testManifestRejectsUnsafeOrIncompatiblePackages() throws {
        let paths = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt"]
        let assets = paths.map { AssetManifest.Asset(path: $0, size: 0, sha256: AssetManifest.digest(Data()), contentType: "text/plain") }
        func manifest(_ files: [AssetManifest.Asset], schema: Int = 2) -> AssetManifest {
            AssetManifest(schemaVersion: 1, protocolVersion: 1, offlineSchemaVersion: schema, buildId: String(repeating: "a", count: 64), files: files)
        }
        try manifest(assets).validate()
        #expect(throws: (any Error).self) { try manifest(assets, schema: 3).validate() }
        #expect(throws: (any Error).self) { try manifest(Array(assets.dropLast())).validate() }
        #expect(throws: (any Error).self) { try manifest(assets + [assets[0]]).validate() }
        for path in ["/../secret", "/a/%2e%2e/secret", "/a//b", "/.hidden", "https://elsewhere/a", "/a?secret", "/a\\b"] {
            #expect(!(AssetManifest.safePath(path)))
        }
        let ui = PreparedUI(directory: URL(fileURLWithPath: "/tmp"), manifest: manifest(assets))
        #expect(ui.asset(for: "/reader/")?.path == "/reader/index.html")
        #expect(ui.asset(for: "/reader")?.path == "/reader/index.html")
        #expect(ui.asset(for: "/downloads/index.txt")?.path == "/downloads/index.txt")
        #expect(ui.asset(for: "/not-prepared/") == nil)
    }

    @Test func testMissingInventoryExplainsHTMLFallback() throws {
        let html = HTTPResponse(status: 200, headers: ["Content-Type": "text/html; charset=utf-8"], body: Data("<!doctype html><title>Uchiyomi</title>".utf8))
        do {
            _ = try AssetManifest.decodeResponse(html)
            Issue.record("Accepted the server's HTML fallback as an inventory")
        } catch {
            #expect(error.localizedDescription.contains("Update it to a compatible Uchiyomi build"))
        }
    }

    @Test func testCompatibilityAndTLSFailuresAreActionable() throws {
        func config(_ value: [String: Any]) throws -> HTTPResponse {
            HTTPResponse(status: 200, headers: ["Content-Type": "application/json; charset=utf-8"], body: try JSONSerialization.data(withJSONObject: value))
        }
        try ServerCompatibility.validate(config(["mode": "local", "oidc": ["enabled": true]]))
        for unsupported in [["mode": "oidc-only"], ["mode": "unknown"], ["mode": "local", "desktop": true], [:]] as [[String: Any]] {
            #expect(throws: (any Error).self) { try ServerCompatibility.validate(config(unsupported)) }
        }
        #expect(throws: (any Error).self) { try ServerCompatibility.validate(.message(404, "missing")) }
        #expect(ClientError.connectionMessage(URLError(.serverCertificateUntrusted)).contains("certificate"))
        #expect(ClientError.connectionMessage(URLError(.clientCertificateRequired)).contains("client certificate"))
        #expect(ClientError.connectionMessage(URLError(.notConnectedToInternet)).contains("Saved downloads are kept"))
    }

    @Test func testOutagesAreNotReportedAsCompatibilityOrStorageFailures() throws {
        for status in [500, 502, 503, 504] {
            let down = HTTPResponse(status: status, headers: ["Content-Type": "text/html"], body: Data("This App is Down".utf8))
            for validate in [ServerCompatibility.validate, { _ = try AssetManifest.decodeResponse($0) }] {
                do { try validate(down); Issue.record("Accepted an unavailable server") }
                catch {
                    #expect(ServerAvailability.failure(error) == .unavailable)
                    #expect(ClientError.connectionMessage(error).contains("server is unavailable"))
                    #expect(ClientError.savedReaderMessage(error).contains("saved offline reader"))
                }
            }
        }
        #expect(ServerAvailability.failure(URLError(.networkConnectionLost)) == .unavailable)
        let tls = URLError(.serverCertificateUntrusted)
        #expect(ServerAvailability.failure(tls) == .needsAttention)
        #expect(ClientError.savedReaderMessage(tls).contains("certificate"))
        #expect(ClientError.savedReaderMessage(CocoaError(.fileWriteOutOfSpace)).contains("Not enough storage"))
    }
}
