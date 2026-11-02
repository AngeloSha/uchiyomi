import XCTest
import WebKit
@testable import Uchiyomi

@MainActor
final class ReaderLifecycleTests: XCTestCase {
    private func waitForPath(_ model: ReaderModel, _ path: String) async throws {
        let view = try XCTUnwrap(model.webView)
        for _ in 0..<100 {
            if (try? await view.evaluateJavaScript("document.readyState === 'complete' && location.pathname === '\(path)'")) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw ClientError.invalid("The reader did not reach \(path).")
    }

    func testColdLaunchStartsAtHomeWhileResumeKeepsCurrentPage() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let profile = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        try store.save(.init(profiles: [profile], selectedID: profile.id))
        let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
        let ui = try await cache.prepare(client: ReaderFixture()) { _, _ in }
        try await cache.confirm(ui)
        var model = ReaderModel(root: root, assetClient: { _ in UnavailableReaderFixture() })
        do {
            await model.restore()
            XCTAssertNil(model.error)
            XCTAssertEqual(model.status, "Server unavailable. You’re using the saved offline reader.")
            XCTAssertEqual(model.serverStatuses[profile.id], .unavailable)
            try await waitForPath(model, "/")
            model.webView?.load(URLRequest(url: URL(string: "/reader/?book=fixture-1", relativeTo: profile.localOrigin)!.absoluteURL))
            try await waitForPath(model, "/reader/")
            await model.resume()
            try await waitForPath(model, "/reader/")

            // Release the view/listener and create a new model from persisted state,
            // as a process restart does. A previous reader URL must not be restored.
            await model.addServer()
            model = ReaderModel(root: root, assetClient: { _ in UnavailableReaderFixture() })
            await model.restore()
            try await waitForPath(model, "/")
            XCTAssertEqual(model.selectedID, profile.id)
            let query = try await model.webView?.evaluateJavaScript("location.search") as? String
            XCTAssertEqual(query, "")
        } catch {
            await model.addServer()
            try? KeychainCookieVault(profileID: profile.id).remove()
            try? await removeFixtureStore(profile.id)
            try? FileManager.default.removeItem(at: root)
            throw error
        }
        await model.addServer()
        try KeychainCookieVault(profileID: profile.id).remove()
        try await removeFixtureStore(profile.id)
        try FileManager.default.removeItem(at: root)
    }

    func testServerAvailabilityChecksRefreshAndIgnoreCancelledOrRemovedProfiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let first = try store.profile(for: URL(string: "https://available.example")!, in: .init())
        let second = try store.profile(for: URL(string: "https://unavailable.example")!, in: .init(profiles: [first]))
        try store.save(.init(profiles: [first, second], selectedID: nil))
        let probe = AvailabilityProbeFixture()
        let model = ReaderModel(root: root, serverProbe: { await probe.check($0) })
        await model.restore()
        func waitForProbes(_ count: Int = 2) async throws {
            for _ in 0..<100 {
                if await probe.count == count { return }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTFail("Availability checks did not start")
        }
        let check = Task { await model.refreshServerStatuses() }
        try await waitForProbes()
        XCTAssertEqual(model.serverStatuses[first.id], .checking)
        XCTAssertEqual(model.serverStatuses[second.id], .checking)
        await probe.complete(first.origin, with: .available)
        await probe.complete(second.origin, with: .unavailable)
        await check.value
        XCTAssertEqual(model.serverStatuses[first.id], .available)
        XCTAssertEqual(model.serverStatuses[second.id], .unavailable)

        // A newer refresh must restore the last completed observation if cancelled,
        // even when it replaced a refresh that was already showing "Checking".
        let older = Task { await model.refreshServerStatuses() }
        try await waitForProbes()
        let newer = Task { await model.refreshServerStatuses() }
        try await waitForProbes(4)
        await probe.complete(first.origin, with: .unavailable)
        await probe.complete(second.origin, with: .available)
        await older.value
        XCTAssertEqual(model.serverStatuses[first.id], .checking)
        newer.cancel()
        await probe.complete(first.origin, with: .unavailable)
        await probe.complete(second.origin, with: .available)
        await newer.value
        XCTAssertEqual(model.serverStatuses[first.id], .available)
        XCTAssertEqual(model.serverStatuses[second.id], .unavailable)

        let cancelled = Task { await model.refreshServerStatuses() }
        try await waitForProbes()
        cancelled.cancel()
        await probe.complete(first.origin, with: .unavailable)
        await probe.complete(second.origin, with: .available)
        await cancelled.value
        XCTAssertEqual(model.serverStatuses[first.id], .available)
        XCTAssertEqual(model.serverStatuses[second.id], .unavailable)

        let removed = Task { await model.refreshServerStatuses() }
        try await waitForProbes()
        await model.forget(second)
        XCTAssertNil(model.error)
        await probe.complete(first.origin, with: .available)
        await probe.complete(second.origin, with: .available)
        await removed.value
        XCTAssertNil(model.serverStatuses[second.id])
        XCTAssertEqual(model.profiles, [first])
        try FileManager.default.removeItem(at: root)
    }

    func testRecoveredOutageClearsOnResumeAndWhileReadingWithoutReload() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let profile = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        try store.save(.init(profiles: [profile], selectedID: profile.id))
        let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
        let ui = try await cache.prepare(client: ReaderFixture()) { _, _ in }
        try await cache.confirm(ui)
        let probe = RecoveryProbeFixture()
        let model = ReaderModel(root: root, assetClient: { _ in UnavailableReaderFixture() },
                                outageRetryInterval: 50_000_000, serverProbe: { _ in await probe.check() })
        func waitForRecovery() async throws {
            for _ in 0..<100 {
                if model.status == nil { return }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTFail("Recovered server left its outage notice visible")
        }
        do {
            await model.restore()
            model.suspend()
            XCTAssertNotNil(model.status)
            model.webView?.load(URLRequest(url: URL(string: "/reader/?book=fixture-1", relativeTo: profile.localOrigin)!.absoluteURL))
            try await waitForPath(model, "/reader/")
            let identity = ObjectIdentifier(try XCTUnwrap(model.webView))
            _ = try await model.webView?.evaluateJavaScript("window.retainedPage = 42")
            await probe.recover()
            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertNotNil(model.status, "Background app must not keep polling")
            await model.resume()
            try await waitForRecovery()
            XCTAssertEqual(model.serverStatuses[profile.id], .available)
            XCTAssertEqual(ObjectIdentifier(try XCTUnwrap(model.webView)), identity)
            try await waitForPath(model, "/reader/")
            let retained = try await model.webView?.evaluateJavaScript("window.retainedPage") as? Int
            XCTAssertEqual(retained, 42, "Recovery check must not reload the reader")

            // An outage that recovers while the reader stays open also clears itself.
            await model.choose(profile)
            XCTAssertNotNil(model.status)
            try await waitForRecovery()
            XCTAssertEqual(model.serverStatuses[profile.id], .available)
            // Availability must not erase unrelated update/storage feedback.
            model.status = "Not enough storage to save the update."
            await model.refreshServerStatuses()
            XCTAssertEqual(model.status, "Not enough storage to save the update.")

            await model.choose(profile)
            model.dismissStatus()
            let count = await probe.count
            try await Task.sleep(nanoseconds: 150_000_000)
            let afterDismissal = await probe.count
            XCTAssertEqual(afterDismissal, count, "Dismissed outage must stop retrying")
        } catch {
            await model.addServer()
            try? await removeFixtureStore(profile.id)
            try? FileManager.default.removeItem(at: root)
            throw error
        }
        await model.addServer()
        try await removeFixtureStore(profile.id)
        try FileManager.default.removeItem(at: root)
    }

    private func removeFixtureStore(_ id: UUID) async throws {
        // A fresh simulator can retain WebKit's network process after the view is gone.
        // The app exposes retry on removal failure; fixture teardown waits for that same
        // asynchronous shutdown without making lifecycle assertions depend on its timing.
        for attempt in 0..<10 {
            do { try await NativeWebView.removeStore(for: id); return }
            catch {
                if attempt == 9 { throw error }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }
    func testRetiredReaderCannotAcknowledgeReopenedGeneration() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let profile = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        try store.save(.init(profiles: [profile], selectedID: profile.id))
        let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
        _ = try await cache.prepare(client: ReaderFixture()) { _, _ in }
        let model = ReaderModel(root: root)
        await model.restore()
        var retired: WKWebView? = try XCTUnwrap(model.webView)
        for _ in 0..<100 {
            if (try? await retired?.evaluateJavaScript("document.readyState === 'complete' && !!window.uchiyomiNative")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        // Reopening the same cache generation still creates a different reader instance.
        await model.choose(profile)
        XCTAssertNotNil(model.webView)
        XCTAssertFalse(model.webView === retired)
        XCTAssertTrue(model.awaitingConfirmation)
        model.error = "Current reader has not started"
        _ = try await retired?.evaluateJavaScript("window.uchiyomiNative.ready(); true")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(model.awaitingConfirmation, "Retired web view acknowledged the new reader")
        XCTAssertEqual(model.error, "Current reader has not started")
        let pending = try await cache.needsConfirmation()
        XCTAssertTrue(pending, "Retired callback confirmed the cached generation")
        retired = nil
        for _ in 0..<100 {
            if (try? await model.webView?.evaluateJavaScript("document.readyState === 'complete' && !!window.uchiyomiNative")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        _ = try await model.webView?.evaluateJavaScript("window.uchiyomiNative.ready(); true")
        for _ in 0..<100 {
            if !model.awaitingConfirmation { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertFalse(model.awaitingConfirmation)
        XCTAssertNil(model.error)
        let confirmed = try await cache.needsConfirmation()
        XCTAssertFalse(confirmed, "The current reader must still be able to acknowledge startup")
        await model.addServer()
        try KeychainCookieVault(profileID: profile.id).remove()
        try await removeFixtureStore(profile.id)
        try FileManager.default.removeItem(at: root)
    }

    func testAddingServerCannotOverlapProfileSelection() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let first = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        let second = try store.profile(for: URL(string: "https://127.0.0.1:10")!, in: .init(profiles: [first]))
        try store.save(.init(profiles: [first, second], selectedID: first.id))
        for profile in [first, second] {
            let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
            let ui = try await cache.prepare(client: ReaderFixture()) { _, _ in }
            try await cache.confirm(ui)
        }
        let model = ReaderModel(root: root)
        await model.restore()
        XCTAssertNil(model.error)
        // Keep the old view alive to reproduce SwiftUI retaining it across a transition.
        var retired: WKWebView? = try XCTUnwrap(model.webView)
        let adding = Task { await model.addServer() }
        for _ in 0..<100 {
            if model.webView == nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNil(model.webView)
        XCTAssertTrue(model.busy, "Server teardown must exclude a second transition")
        await model.choose(second)
        XCTAssertEqual(model.selectedID, first.id, "Selection changed during teardown")
        XCTAssertNil(model.webView, "A second reader opened during teardown")
        withExtendedLifetime(retired) {}
        retired = nil
        await adding.value
        XCTAssertFalse(model.busy)
        XCTAssertTrue(model.addingServer)
        XCTAssertEqual(model.address, "")
        // Selecting a saved server works again once teardown completes.
        await model.choose(second)
        XCTAssertEqual(model.selectedID, second.id)
        XCTAssertNotNil(model.webView)
        await model.addServer()
        for profile in [first, second] {
            try KeychainCookieVault(profileID: profile.id).remove()
            try await removeFixtureStore(profile.id)
        }
        try FileManager.default.removeItem(at: root)
    }
}

private actor AvailabilityProbeFixture {
    private var pending: [URL: [CheckedContinuation<ServerAvailability, Never>]] = [:]
    var count: Int { pending.values.reduce(0) { $0 + $1.count } }
    func check(_ origin: URL) async -> ServerAvailability {
        await withCheckedContinuation { pending[origin, default: []].append($0) }
    }
    func complete(_ origin: URL, with result: ServerAvailability) {
        guard pending[origin]?.isEmpty == false else { return }
        pending[origin]?.removeFirst().resume(returning: result)
    }
}

private actor RecoveryProbeFixture {
    private var available = false
    private(set) var count = 0
    func recover() { available = true }
    func check() -> ServerAvailability {
        count += 1
        return available ? .available : .unavailable
    }
}

private struct UnavailableReaderFixture: AssetFetching {
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        HTTPResponse(status: 502, headers: ["Content-Type": "text/html"], body: Data("This App is Down".utf8))
    }
}

private struct ReaderFixture: AssetFetching {
    private let paths = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt", "/_next/static/reader.js"]
    private let bytes = Data("<!doctype html><title>Reader fixture</title>".utf8)
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        if path == "/mobile-assets.json" {
            let manifest = AssetManifest(schemaVersion: 1, protocolVersion: 1, offlineSchemaVersion: 2,
                buildId: AssetManifest.digest(bytes), files: paths.map {
                    .init(path: $0, size: bytes.count, sha256: AssetManifest.digest(bytes), contentType: "text/html")
                })
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: try JSONEncoder().encode(manifest))
        }
        return HTTPResponse(status: 200, body: bytes)
    }
}
