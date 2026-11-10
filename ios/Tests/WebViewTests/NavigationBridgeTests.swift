import XCTest
import WebKit
@testable import Uchiyomi

@MainActor
final class NavigationBridgeTests: XCTestCase {
    private func waitFor(_ condition: () async throws -> Bool) async throws {
        for _ in 0..<200 {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw ClientError.invalid("Bridge fixture did not settle")
    }

    func testCurrentMainDocumentOwnsNavigationAndNeverAcknowledgesCacheStartup() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let cache = AssetCache(root: root)
        print("Bridge boundary: preparing fixture")
        let ui = try await cache.prepare(client: NavigationPage()) { _, _ in }
        print("Bridge boundary: starting gateway")
        let client = try RemoteClient(origin: profile.origin, vault: BridgeEmptyVault())
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        print("Bridge boundary: creating web view")
        var ready = false
        let bridge = NativeNavigationBridge(origin: profile.localOrigin) { _ in }
        let web = try await NativeWebView.make(profile: profile, policy: gateway.policy, navigation: bridge) { ready = true }
        print("Bridge boundary: loading document")
        defer { bridge.retire(); web.stopLoading(); client.cancel(); try? FileManager.default.removeItem(at: root) }
        do {
            web.load(URLRequest(url: profile.localOrigin))
            try await waitFor { bridge.presentation?.auth == .authed }
            XCTAssertFalse(ready, "Navigation handshake must not confirm cache startup")
            let baseline = bridge.presentation
            // Exercise actual WKScriptMessageHandler delivery, not a direct decoder invocation.
            _ = try await web.callAsyncJavaScript("""
                const messages = [
                  {...fixture.message, version: 99},
                  {...fixture.message, revision: -1},
                  {...fixture.message, state: {...fixture.state, selected: 'search'}},
                  {...fixture.message, state: {...fixture.state, items: [...fixture.state.items, fixture.state.items[0]]}},
                  {...fixture.message, state: {...fixture.state, selected: 'javascript:alert(1)'}},
                  {...fixture.message, state: {...fixture.state, items: fixture.state.items.map(i=>({...i,label:'x'.repeat(500)}))}},
                  {...fixture.message, session: crypto.randomUUID()},
                ];
                for(const message of messages) uchiyomiNative.navigation.send(message);
                const iframe = document.createElement('iframe');
                const envelope = {document: uchiyomiNative.navigation.documentID,
                  message: {...fixture.message, revision: 10, state: {...fixture.state, selected: 'search'}}};
                iframe.srcdoc = '<script>window.webkit.messageHandlers.navigation.postMessage('+JSON.stringify(envelope)+'); parent.fixture.frameSent = true;<\\/script>';
                document.body.append(iframe);
                return true;
                """, arguments: [:], in: nil, contentWorld: .page)
            try await waitFor { (try? await web.evaluateJavaScript("fixture.frameSent === true")) as? Bool == true }
            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertEqual(bridge.presentation, baseline)
            let retired = try await web.callAsyncJavaScript("return {document:uchiyomiNative.navigation.documentID,message:fixture.message}", arguments: [:], in: nil, contentWorld: .page)
            bridge.reset(); web.reload()
            try await waitFor { bridge.presentation?.auth == .authed }
            _ = try await web.callAsyncJavaScript("window.webkit.messageHandlers.navigation.postMessage(retired); retired.message.kind='hello'; window.webkit.messageHandlers.navigation.postMessage(retired); return true", arguments: ["retired": retired!], in: nil, contentWorld: .page)
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(bridge.presentation, baseline, "A retired document changed current navigation")

            bridge.request(.search)
            try await waitFor { bridge.presentation?.selected == .search }
            let requests = try await web.evaluateJavaScript("fixture.actions") as? [String]
            XCTAssertEqual(requests, ["search"])
            bridge.retire()
            _ = try await web.evaluateJavaScript("uchiyomiNative.navigation.send(fixture.message); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertNil(bridge.presentation, "A retired view regained navigation ownership")
            XCTAssertFalse(ready)
            // The same main-frame message must fail when its origin is not the
            // profile's exact origin (including the local gateway port).
            let otherOrigin = URL(string: "http://localhost:\(profile.port == 65535 ? 65534 : profile.port + 1)")!
            let other = NativeNavigationBridge(origin: otherOrigin) { _ in }
            web.configuration.userContentController.removeScriptMessageHandler(forName: "navigation")
            web.configuration.userContentController.add(other, name: "navigation")
            other.attach(web)
            _ = try await web.evaluateJavaScript("fixture.message.kind='hello'; uchiyomiNative.navigation.send(fixture.message); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertNil(other.presentation, "A different origin obtained navigation ownership")
            other.retire()
            await gateway.stop()
        } catch { await gateway.stop(); throw error }
    }
}

private struct BridgeEmptyVault: CookieVault {
    func read() -> Data? { nil }
    func write(_ data: Data) {}
}

struct NavigationPage: AssetFetching {
    private let paths = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt", "/_next/static/reader.js"]
    private let bytes = Data(#"""
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#15131a;color:white;padding:16px"><h1>Navigation transport fixture</h1><script>
        const state = {auth:'authed',immersive:false,selected:'home',secondary:[],
          items:['home','library','search','discover','offline','profile'].map(id=>({id,label:id,enabled:true}))};
        window.fixture = {state, actions:[], message:{kind:'hello',version:1,session:crypto.randomUUID(),revision:1,state}};
        uchiyomiNative.navigation.subscribe(message=>{
          if(message.session!==fixture.message.session)return;
          if(message.kind==='ready') {fixture.message.kind='state'; uchiyomiNative.navigation.send(fixture.message);}
          if(message.kind==='action') {
            fixture.actions.push(message.action); state.selected=message.action;
            fixture.message.revision++; uchiyomiNative.navigation.send(fixture.message);
          }
        });
        uchiyomiNative.navigation.send(fixture.message);
        </script></body>
        """#.utf8)
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
