import Foundation
import Testing
@testable import UchiyomiCore

private final class AuthVault: CookieVault {
    private var bytes: Data?
    func read() -> Data? { bytes }
    func write(_ data: Data) { bytes = data }
}

struct NativeAuthTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["TEST_DATABASE_URL"] != nil))
    func realTotpRefreshRelaunchAndLogout() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let fixture = Process()
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let readyFile = root.appendingPathComponent("ready.json")
        fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        fixture.arguments = ["node", "--import", "tsx", repository.appendingPathComponent("ios/Tests/Fixtures/auth-server.mjs").path]
        fixture.currentDirectoryURL = repository.appendingPathComponent("bff")
        var environment = ProcessInfo.processInfo.environment
        environment["UCHI_AUTH_READY_FILE"] = readyFile.path
        environment["UCHI_AUTH_CONFIG_DIR"] = root.appendingPathComponent("config").path
        fixture.environment = environment
        try fixture.run()
        defer {
            if fixture.isRunning { fixture.terminate(); fixture.waitUntilExit() }
            try? FileManager.default.removeItem(at: root)
        }
        for _ in 0..<200 {
            if FileManager.default.fileExists(atPath: readyFile.path) || !fixture.isRunning { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let settings = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: readyFile)) as? [String: Any])
        let origin = URL(string: "http://127.0.0.1:\(try #require(settings["port"] as? Int))")!
        let vault = AuthVault()
        let client = try RemoteClient(origin: origin, vault: vault)
        defer { client.cancel() }
        func post(_ client: RemoteClient, _ path: String, _ payload: [String: Any] = [:]) async throws -> (Int, [String: Any]) {
            let response = await client.proxy(HTTPRequest(method: "POST", target: path, headers: ["content-type": "application/json"], body: try JSONSerialization.data(withJSONObject: payload)))
            var data = response.body
            if let stream = response.stream { try await stream.write { data.append($0) } }
            #expect(response.headers["Set-Cookie"] == nil)
            return (response.status, try #require(JSONSerialization.jsonObject(with: data) as? [String: Any]))
        }
        var login = ["username": settings["username"]!, "password": settings["password"]!]
        let missing = try await post(client, "/auth/login", login)
        #expect(missing.0 == 401 && missing.1["error"] as? String == "totp_required")
        login["code"] = "invalid"
        let wrong = try await post(client, "/auth/login", login)
        #expect(wrong.0 == 401 && wrong.1["error"] as? String == "totp_invalid")
        let code = try await client.fetch("/__code", maxBytes: 1024)
        login["code"] = try #require(JSONSerialization.jsonObject(with: code.body) as? [String: String])["code"]
        let success = try await post(client, "/auth/login", login)
        #expect(success.0 == 200)
        #expect((success.1["user"] as? [String: Any])?["id"] as? String == settings["id"] as? String)
        let replay = try await post(client, "/auth/login", login)
        #expect(replay.0 == 401 && replay.1["error"] as? String == "totp_invalid")
        client.cancel()
        let relaunched = try RemoteClient(origin: origin, vault: vault)
        defer { relaunched.cancel() }
        let refreshed = try await post(relaunched, "/auth/refresh")
        #expect(refreshed.0 == 200)
        #expect((refreshed.1["user"] as? [String: Any])?["id"] as? String == settings["id"] as? String)
        let isolated = try RemoteClient(origin: origin, vault: AuthVault())
        defer { isolated.cancel() }
        #expect(try await post(isolated, "/auth/refresh").0 == 401)
        #expect(try await post(relaunched, "/auth/logout").0 == 200)
        #expect(try await post(relaunched, "/auth/refresh").0 == 401)
    }
}
