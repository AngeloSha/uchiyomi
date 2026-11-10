import Foundation
import CryptoKit
import Testing
@testable import UchiyomiCore

private final class MemoryVault: CookieVault {
    var data: Data?
    func read() -> Data? { data }
    func write(_ data: Data) { self.data = data }
}

private extension HTTPResponse {
    func collected() async throws -> HTTPResponse {
        var copy = self
        if let stream { try await stream.write { copy.body.append($0) } }
        copy.stream = nil
        return copy
    }
}

final class IntegrationTests {
    private var fixture: Process!
    private var origin: URL!
    private var directory: URL!

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        fixture = Process()
        fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/server.mjs")
        fixture.arguments = ["node", script.path]
        let output = Pipe()
        fixture.standardOutput = output
        try fixture.run()
        let line = String(data: output.fileHandleForReading.availableData, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = try #require(UInt16(line))
        origin = URL(string: "http://127.0.0.1:\(port)")!
    }
    deinit {
        fixture?.terminate()
        fixture?.waitUntilExit()
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }

    @Test func testFileBackedUploadLargerThanOldLimitKeepsItsBytes() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel() }
        let upload = FileManager.default.temporaryDirectory.appendingPathComponent("uchiyomi-upload-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: upload) }
        let chunk = Data((0..<65_536).map { UInt8($0 % 251) })
        FileManager.default.createFile(atPath: upload.path, contents: nil)
        let handle = try FileHandle(forWritingTo: upload)
        var digest = SHA256()
        for _ in 0..<145 { try handle.write(contentsOf: chunk); digest.update(data: chunk) }
        try handle.close()
        let request = HTTPRequest(method: "POST", target: "/api/upload-check",
                                  headers: ["content-type": "application/octet-stream"], body: Data(), bodyFile: upload)
        let response = try await client.proxy(request).collected()
        #expect(response.status == 200)
        let answer = try #require(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(answer["bytes"] as? Int == 145 * chunk.count)
        #expect(answer["contentLength"] as? String == String(145 * chunk.count))
        #expect(answer["sha256"] as? String == digest.finalize().map { String(format: "%02x", $0) }.joined())
    }

    @Test func testUploadAndOrdinaryRequestsUseIndependentResourceDeadlines() throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel() }
        let file = URL(fileURLWithPath: "/not-read-by-this-configuration-test")
        let upload = HTTPRequest(method: "POST", target: "/api/library/upload?images=1", headers: [:], body: Data(), bodyFile: file)
        let api = HTTPRequest(method: "POST", target: "/api/admin/import/parse", headers: [:], body: Data(), bodyFile: file)
        let manifest = HTTPRequest(method: "GET", target: "/mobile-assets.json", headers: [:], body: Data())
        #expect(client.resourceDeadline(for: upload) == 900)
        #expect(client.resourceDeadline(for: api) == 120)
        #expect(client.resourceDeadline(for: manifest) == 120)
        let probe = try RemoteClient(origin: origin, vault: MemoryVault(), resourceTimeout: 5)
        defer { probe.cancel() }
        #expect(probe.resourceDeadline(for: manifest) == 5)
    }

    @Test func testCancelStopsFirstTasksAcrossBothSessionsWithoutNumericIDCollision() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        let observer = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel(); observer.cancel() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("uchiyomi-cancel-upload-" + UUID().uuidString)
        try Data(repeating: 23, count: 65_536).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        // Each URLSession starts its task counter at 1. Keying cancellation by that number
        // would replace one still-running task with the other in the lifetime registry.
        let ordinary = Task { try await client.fetch("/auth/long-request", maxBytes: 4096) }
        let upload = Task { await client.proxy(HTTPRequest(method: "POST", target: "/api/library/upload?wait=1",
            headers: ["content-type": "application/octet-stream"], body: Data(), bodyFile: file)) }
        func active() async throws -> (Int, Int) {
            let reply = try await observer.fetch("/__stats", maxBytes: 4096)
            let values = try #require(JSONSerialization.jsonObject(with: reply.body) as? [String: Any])
            return (values["longActive"] as? Int ?? -1, values["uploadsActive"] as? Int ?? -1)
        }
        var bothStarted = false
        for _ in 0..<100 {
            let counts = try await active()
            if counts == (1,1) { bothStarted = true; break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(bothStarted)
        client.cancel()
        var bothStopped = false
        for _ in 0..<100 {
            let counts = try await active()
            if counts == (0,0) { bothStopped = true; break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(bothStopped, "Closing a profile left one session's first request running")
        do { _ = try await ordinary.value; Issue.record("Canceled ordinary request completed") } catch {}
        #expect(await upload.value.status == 503)
    }

    @Test func testAvailabilityProbeDistinguishesOutageAndCompatibilityWithoutAccountCookies() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel() }
        _ = try await client.fetch("/auth/login", maxBytes: 4096)
        #expect(await ServerAvailability.check(origin) == .available)
        _ = try await client.fetch("/__incompatible", maxBytes: 100)
        #expect(await ServerAvailability.check(origin) == .needsAttention)
        _ = try await client.fetch("/__server-down", maxBytes: 100)
        #expect(await ServerAvailability.check(origin) == .unavailable)
        // A gateway error page can exceed a small asset's declared size. Keep its
        // HTTP outage reason rather than surfacing download cancellation/storage.
        let anonymous = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { anonymous.cancel() }
        do { _ = try await anonymous.fetch("/auth/config", maxBytes: 1); Issue.record("Accepted gateway error") }
        catch { #expect(ClientError.isUnavailable(error), "\(error)") }
        fixture.terminate(); fixture.waitUntilExit()
        #expect(await ServerAvailability.check(origin) == .unavailable)
    }

    @Test func testProxyCookiesRelaunchIsolationBinaryBodiesAndFailures() async throws {
        let vault = MemoryVault()
        let client = try RemoteClient(origin: origin, vault: vault)
        defer { client.cancel() }
        let body = Data(#"{"username":"fixture","password":"test-only","code":"123456"}"#.utf8)
        let login = try await client.proxy(HTTPRequest(method: "POST", target: "/auth/login", headers: ["content-type": "application/json", "cookie": "uchiyomi_gateway=must-not-leave", "authorization": "Bearer fixture-access"], body: body)).collected()
        #expect(login.status == 200)
        #expect(login.headers["Set-Cookie"] == nil)
        let echoed = try #require(try JSONSerialization.jsonObject(with: login.body) as? [String: Any])
        let headers = try #require(echoed["headers"] as? [String: String])
        #expect(headers["cookie"] == nil, "Local gateway credentials reached the server")
        #expect(headers["origin"] == origin.absoluteString)
        #expect(headers["authorization"] == "Bearer fixture-access")
        #expect(echoed["body"] as? String == String(data: body, encoding: .utf8))

        let privateReply = try await client.proxy(HTTPRequest(method: "GET", target: "/api/private-response", headers: [:], body: Data())).collected()
        #expect(privateReply.headers["Vary"] == "*")
        #expect(privateReply.headers["Cache-Control"] == "private, no-store")
        #expect(privateReply.headers["X-Uchiyomi-Private"] == "1")
        #expect(privateReply.body == Data([0,255,9,128]))

        let restored = try RemoteClient(origin: origin, vault: vault)
        defer { restored.cancel() }
        let refresh = try await restored.fetch("/auth/refresh", maxBytes: 4096)
        let refreshJSON = try #require(try JSONSerialization.jsonObject(with: refresh.body) as? [String: Any])
        let refreshHeaders = try #require(refreshJSON["headers"] as? [String: String])
        #expect(refreshHeaders["cookie"]?.contains("fixture_refresh=session-secret") == true)
        #expect(!(refreshHeaders["cookie"]?.contains("fixture_image") == true), "Cookie path isolation failed")

        let isolated = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { isolated.cancel() }
        let isolatedReply = try await isolated.fetch("/auth/refresh", maxBytes: 4096)
        let isolatedJSON = try #require(try JSONSerialization.jsonObject(with: isolatedReply.body) as? [String: Any])
        #expect((isolatedJSON["headers"] as? [String: String])?["cookie"] == nil)
        let image = try await restored.fetch("/img/chapter", maxBytes: 4)
        #expect(image.body == Data([0, 255, 1, 128]))

        do { _ = try await restored.fetch("/redirect", maxBytes: 4096); Issue.record("Followed redirect") }
        catch { #expect(error is ClientError) }
        let rejected = await client.proxy(HTTPRequest(method: "POST", target: "/auth/rejected", headers: [:], body: Data()))
        #expect(rejected.status == 401)
        fixture.terminate(); fixture.waitUntilExit()
        let unavailable = await client.proxy(HTTPRequest(method: "POST", target: "/auth/refresh", headers: [:], body: Data()))
        #expect(unavailable.status == 503)
    }

    @Test func testCachedRoutesWithoutUpstreamAndListenerRestart() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel() }
        let cache = AssetCache(root: directory)
        _ = try await cache.prepare(client: client) { _, _ in }
        _ = try await client.fetch("/__bad-hash", maxBytes: 100)
        do { _ = try await cache.prepare(client: client) { _, _ in }; Issue.record("Accepted corrupt UI") }
        catch { #expect(error is ClientError) }
        // Failed preparation leaves the previously activated UI available.
        let loaded = try await cache.load()
        let ui = try #require(loaded)
        fixture.terminate(); fixture.waitUntilExit()
        let profile = ServerProfile(id: UUID(), origin: origin, port: UInt16.random(in: 49152...60999))
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        func get(_ path: String, authorized: Bool = true) async throws -> (Data, Int) {
            var request = URLRequest(url: URL(string: profile.localOrigin.absoluteString + path)!)
            request.httpShouldHandleCookies = false
            if authorized { request.setValue("\(gateway.policy.cookieName)=\(gateway.policy.token)", forHTTPHeaderField: "Cookie") }
            let (bytes, response) = try await session.data(for: request)
            return (bytes, (response as! HTTPURLResponse).statusCode)
        }
        for (path, expected) in [("/", "/index.html"), ("/downloads/", "/downloads/index.html"), ("/reader/", "/reader/index.html"), ("/reader/index.txt?_rsc=test", "/reader/index.txt"), ("/_next/static/reader.js", "/_next/static/reader.js")] {
            let (bytes, status) = try await get(path)
            #expect(status == 200)
            #expect(String(data: bytes, encoding: .utf8) == "fixture \(expected)")
        }
        let denied = try await get("/", authorized: false)
        #expect(denied.1 == 403)
        await gateway.stop()
        try await gateway.start()
        let restarted = try await get("/downloads/")
        #expect(restarted.1 == 200)
        await gateway.stop()
    }

    @Test func testStreamingDeliversBytesBeforeCompletionAndCancelsDisconnectedRequests() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel() }
        let cache = AssetCache(root: directory)
        let ui = try await cache.prepare(client: client) { _, _ in }
        let profile = ServerProfile(id: UUID(), origin: origin, port: UInt16.random(in: 49152...60999))
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        let session = URLSession(configuration: .ephemeral)
        var request = URLRequest(url: profile.localOrigin.appendingPathComponent("api/stream"))
        request.httpShouldHandleCookies = false
        request.setValue("\(gateway.policy.cookieName)=\(gateway.policy.token)", forHTTPHeaderField: "Cookie")
        func stats() async throws -> [String: Any] {
            let reply = try await client.fetch("/__stats", maxBytes: 4096)
            return try #require(JSONSerialization.jsonObject(with: reply.body) as? [String: Any])
        }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
            var iterator = bytes.makeAsyncIterator()
            #expect(try await iterator.next() == 0)
            let during = try await stats()
            #expect(during["completed"] as? Int == 0, "The gateway buffered the whole download before delivering it")
            session.invalidateAndCancel()
            var stopped = false
            for _ in 0..<30 {
                if try await stats()["streaming"] as? Int == 0 { stopped = true; break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            #expect(stopped, "An abandoned local request kept downloading from the server")
            let end = try await stats()
            #expect(end["completed"] as? Int == 0)
            let complete = try await client.proxy(HTTPRequest(method: "GET", target: "/api/stream", headers: [:], body: Data())).collected()
            #expect(complete.body.count == 32 * 65536)
            for n in 0..<32 { #expect(complete.body[n * 65536] == UInt8(n)) }
            let truncated = await client.proxy(HTTPRequest(method: "GET", target: "/api/truncated", headers: [:], body: Data()))
            if truncated.status == 200 {
                do { _ = try await truncated.collected(); Issue.record("Accepted a truncated chapter response") } catch {}
            } else { #expect(truncated.status == 503) }
            await gateway.stop()
        } catch { session.invalidateAndCancel(); await gateway.stop(); throw error }
    }

    @Test func testCancelPreventsLateCookiePersistenceAndCrossOriginRedirect() async throws {
        let vault = MemoryVault()
        let client = try RemoteClient(origin: origin, vault: vault)
        let observer = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel(); observer.cancel() }
        let pending = Task { try await client.fetch("/auth/slow-login", maxBytes: 4096) }
        for _ in 0..<50 {
            let status = try await observer.fetch("/__stats", maxBytes: 4096)
            if (try JSONSerialization.jsonObject(with: status.body) as? [String: Any])?["slowLogin"] as? Bool == true { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        client.cancel(); vault.data = nil
        do { _ = try await pending.value; Issue.record("Canceled request completed") } catch {}
        try await Task.sleep(nanoseconds: 350_000_000)
        #expect(vault.data == nil, "A late response recreated the removed profile's session")
        let redirect = await observer.proxy(HTTPRequest(method: "POST", target: "/redirect", headers: ["authorization": "Bearer test-token"], body: Data("password=test-only".utf8)))
        #expect(redirect.status == 503)
        let status = try await observer.fetch("/__stats", maxBytes: 4096)
        #expect((try JSONSerialization.jsonObject(with: status.body) as? [String: Any])?["redirectHits"] as? Int == 0)
    }

    @Test func testRequestsAfterCancellationNeverReachTheServer() async throws {
        let vault = MemoryVault()
        let client = try RemoteClient(origin: origin, vault: vault)
        let observer = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { observer.cancel() }
        client.cancel()
        let late = await client.proxy(HTTPRequest(method: "GET", target: "/caught", headers: [:], body: Data()))
        #expect(late.status == 503)
        do { _ = try await client.fetch("/caught", maxBytes: 4096); Issue.record("Canceled client accepted a fetch") }
        catch { #expect(error is CancellationError) }
        let status = try await observer.fetch("/__stats", maxBytes: 4096)
        #expect((try JSONSerialization.jsonObject(with: status.body) as? [String: Any])?["redirectHits"] as? Int == 0)
        #expect(vault.data == nil)
    }

    @Test func testClientCancellationStopsAnActiveResponseBody() async throws {
        let client = try RemoteClient(origin: origin, vault: MemoryVault())
        let observer = try RemoteClient(origin: origin, vault: MemoryVault())
        defer { client.cancel(); observer.cancel() }
        let reply = await client.proxy(HTTPRequest(method: "GET", target: "/api/stream", headers: [:], body: Data()))
        #expect(reply.status == 200)
        let stream = try #require(reply.stream)
        var received = 0
        do {
            try await stream.write { data in received += data.count; client.cancel() }
            Issue.record("Canceled response body completed normally")
        } catch {}
        #expect(received > 0 && received < 32 * 65536)
        var stopped = false
        for _ in 0..<50 {
            let status = try await observer.fetch("/__stats", maxBytes: 4096)
            let stats = try #require(JSONSerialization.jsonObject(with: status.body) as? [String: Any])
            #expect(stats["completed"] as? Int == 0)
            if stats["streaming"] as? Int == 0 { stopped = true; break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(stopped, "Canceled profile kept downloading the response body")
    }
}
