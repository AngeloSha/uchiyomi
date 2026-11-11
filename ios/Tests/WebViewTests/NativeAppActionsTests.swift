import XCTest
import WebKit
@testable import Uchiyomi

@MainActor
final class NativeAppActionsTests: XCTestCase {
    private func waitFor(_ condition: () async throws -> Bool) async throws {
        for _ in 0..<200 {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw ClientError.invalid("App controls fixture did not settle")
    }

    func testEarlyAcknowledgementWaitsForTheCurrentDocumentToFinish() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let cache = AssetCache(root: root)
        let ui = try await cache.prepare(client: AppControlsPage()) { _, _ in }
        let client = try RemoteClient(origin: profile.origin, vault: AppControlsEmptyVault())
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        var actions: [NativeAppAction] = [], loading: [Bool] = []
        let bridge = NativeAppActionsBridge(origin: profile.localOrigin) { actions.append($0) }
        let web = try await NativeWebView.make(profile: profile, policy: gateway.policy, appActions: bridge)
        web.configuration.userContentController.add(AppControlsLoadingHandler { [weak web] in loading.append(web?.isLoading == true) }, name: "fixtureLoading")
        defer {
            bridge.retire(); web.stopLoading(); client.cancel()
            web.configuration.userContentController.removeScriptMessageHandler(forName: "fixtureLoading")
            try? FileManager.default.removeItem(at: root)
        }
        func load(_ mode: String) async throws {
            web.load(URLRequest(url: URL(string: "/?ack=\(mode)", relativeTo: profile.localOrigin)!.absoluteURL))
            try await waitFor {
                guard !web.isLoading else { return false }
                return (try? await web.evaluateJavaScript("document.readyState === 'complete'")) as? Bool == true
            }
        }
        do {
            try await load("current")
            XCTAssertEqual(loading, [true], "The fixture must acknowledge while navigation is genuinely loading")
            XCTAssertTrue(actions.isEmpty, "A loading document must not acknowledge before didFinish")
            bridge.documentDidFinish()
            try await waitFor { actions == [.controlsReady] }
            _ = try await web.evaluateJavaScript("sessionStorage.retired=JSON.stringify({version:1,documentID:uchiyomiNative.appActions.documentID,action:'controls-ready'}); true")

            bridge.reset()
            try await load("retired")
            XCTAssertEqual(loading, [true, true])
            bridge.documentDidFinish()
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(actions, [.controlsReady], "An early acknowledgement from the retired document must not pass the current-document check")

            bridge.reset()
            try await load("current")
            XCTAssertEqual(loading, [true, true, true])
            XCTAssertEqual(actions, [.controlsReady])
            bridge.documentDidFinish()
            try await waitFor { actions == [.controlsReady, .controlsReady] }
            await gateway.stop()
        } catch { await gateway.stop(); throw error }
    }

    func testOnlyCurrentLocalMainDocumentCanOpenAppControls() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let cache = AssetCache(root: root)
        let ui = try await cache.prepare(client: AppControlsPage()) { _, _ in }
        let client = try RemoteClient(origin: profile.origin, vault: AppControlsEmptyVault())
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        var actions: [NativeAppAction] = []
        var ready = false
        let bridge = NativeAppActionsBridge(origin: profile.localOrigin) { actions.append($0) }
        let web = try await NativeWebView.make(profile: profile, policy: gateway.policy, appActions: bridge) { ready = true }
        defer { bridge.retire(); web.stopLoading(); client.cancel(); try? FileManager.default.removeItem(at: root) }
        do {
            web.load(URLRequest(url: profile.localOrigin))
            try await waitFor {
                guard !web.isLoading else { return false }
                return (try? await web.evaluateJavaScript("document.readyState === 'complete' && !!uchiyomiNative.appActions")) as? Bool == true
            }
            bridge.setNavigationLayout(.side)
            try await waitFor { (try? await web.evaluateJavaScript("document.documentElement.getAttribute('data-native-navigation-layout')")) as? String == "side" }
            bridge.setNavigationLayout(.bottom)
            try await waitFor { (try? await web.evaluateJavaScript("document.documentElement.getAttribute('data-native-navigation-layout')")) as? String == "bottom" }
            _ = try await web.evaluateJavaScript("uchiyomiNative.appActions.request('servers'); true")
            try await waitFor { actions == [.servers] }
            XCTAssertFalse(ready, "Opening app controls must not acknowledge cache startup")

            _ = try await web.callAsyncJavaScript("""
                const valid = {version:1,documentID:uchiyomiNative.appActions.documentID,action:'reload'};
                const invalid = [
                  {...valid,version:2}, {...valid,documentID:'invalid'},
                  {...valid,action:'open-url'}, {...valid,unused:'x'.repeat(1024)}
                ];
                for(const message of invalid) window.webkit.messageHandlers.appActions.postMessage(message);
                const iframe=document.createElement('iframe');
                iframe.srcdoc='<script>window.webkit.messageHandlers.appActions.postMessage('+JSON.stringify(valid)+');parent.frameSent=true;<\\/script>';
                document.body.append(iframe);
                return true;
                """, arguments: [:], in: nil, contentWorld: .page)
            try await waitFor { (try? await web.evaluateJavaScript("window.frameSent === true")) as? Bool == true }
            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertEqual(actions, [.servers], "Malformed and child-frame messages must not open app controls")

            let retired = try await web.evaluateJavaScript("({version:1,documentID:uchiyomiNative.appActions.documentID,action:'reload'})")
            let oldDocument = try await web.evaluateJavaScript("uchiyomiNative.appActions.documentID") as? String
            bridge.reset(); web.reload()
            try await waitFor {
                guard !web.isLoading, let current = (try? await web.evaluateJavaScript("uchiyomiNative.appActions.documentID")) as? String else { return false }
                return current != oldDocument
            }
            bridge.documentDidFinish()
            try await waitFor { (try? await web.evaluateJavaScript("document.documentElement.getAttribute('data-native-navigation-layout')")) as? String == "bottom" }
            bridge.setNavigationLayout(nil)
            try await waitFor { (try? await web.evaluateJavaScript("document.documentElement.hasAttribute('data-native-navigation-layout')")) as? Bool == false }
            _ = try await web.callAsyncJavaScript("window.webkit.messageHandlers.appActions.postMessage(retired); return true", arguments: ["retired": retired!], in: nil, contentWorld: .page)
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(actions, [.servers], "A message from a replaced document must not affect the current server")

            _ = try await web.evaluateJavaScript("uchiyomiNative.appActions.request('reload'); true")
            try await waitFor { actions == [.servers, .reload] }
            bridge.retire()
            _ = try await web.evaluateJavaScript("uchiyomiNative.appActions.request('servers'); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(actions, [.servers, .reload], "Retired views must not open controls")

            let otherOrigin = URL(string: "http://localhost:\(profile.port == 65535 ? 65534 : profile.port + 1)")!
            let other = NativeAppActionsBridge(origin: otherOrigin) { actions.append($0) }
            web.configuration.userContentController.removeScriptMessageHandler(forName: "appActions")
            web.configuration.userContentController.add(other, name: "appActions")
            other.attach(web)
            _ = try await web.evaluateJavaScript("uchiyomiNative.appActions.request('servers'); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(actions, [.servers, .reload], "An origin with a different gateway port must be rejected")
            other.retire()
            await gateway.stop()
        } catch { await gateway.stop(); throw error }
    }
}

private struct AppControlsEmptyVault: CookieVault {
    func read() -> Data? { nil }
    func write(_ data: Data) {}
}

@MainActor
private final class AppControlsLoadingHandler: NSObject, WKScriptMessageHandler {
    let started: () -> Void
    init(started: @escaping () -> Void) { self.started = started }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { started() }
}

private struct AppControlsPage: AssetFetching {
    private let paths = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt", "/_next/static/reader.js"]
    private let bytes = Data("""
        <!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><h1>App controls fixture</h1><script>
        const mode = new URLSearchParams(location.search).get('ack');
        if (mode) {
          const message = mode === 'retired' ? JSON.parse(sessionStorage.retired)
            : {version:1,documentID:uchiyomiNative.appActions.documentID,action:'controls-ready'};
          window.webkit.messageHandlers.appActions.postMessage(message);
          window.webkit.messageHandlers.fixtureLoading.postMessage(null);
          // WebKit's content process holds DOM completion while the native handler receives both messages.
          const until = performance.now() + 500; while (performance.now() < until) {}
        }
        </script>
        """.utf8)
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        if path == "/mobile-assets.json" {
            let manifest = AssetManifest(schemaVersion: 1, protocolVersion: 2, offlineSchemaVersion: 2,
                buildId: AssetManifest.digest(bytes), files: paths.map {
                    .init(path: $0, size: bytes.count, sha256: AssetManifest.digest(bytes), contentType: "text/html")
                })
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: try JSONEncoder().encode(manifest))
        }
        return HTTPResponse(status: 200, body: bytes)
    }
}
