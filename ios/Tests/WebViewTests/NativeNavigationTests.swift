import XCTest
import WebKit
@testable import Uchiyomi

@MainActor
final class NativeNavigationTests: XCTestCase {
    private func waitFor(_ predicate: () async throws -> Bool) async throws {
        for _ in 0..<200 {
            if try await predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw ClientError.invalid("Navigation did not settle")
    }
    func testThemedPresentationAndDocumentFencing() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let cache = AssetCache(root: root)
        let ui = try await cache.prepare(client: AppControlsPage()) { _, _ in }
        let client = try RemoteClient(origin: profile.origin, vault: AppControlsEmptyVault())
        let gateway = Gateway(profile: profile, ui: ui, client: client)
        try await gateway.start()
        var presentations: [ReaderNavigationPresentation?] = []
        let bridge = NativeNavigationBridge(origin: profile.localOrigin) { presentations.append($0) }
        let web = try await NativeWebView.make(profile: profile, policy: gateway.policy, navigation: bridge)
        defer { bridge.retire(); web.stopLoading(); client.cancel(); try? FileManager.default.removeItem(at: root) }
        do {
            web.load(URLRequest(url: profile.localOrigin))
            try await waitFor {
                guard !web.isLoading else { return false }
                return (try? await web.evaluateJavaScript("!!window.uchiyomiNative?.navigation")) as? Bool == true
            }
            let format = UIGraphicsImageRendererFormat(); format.scale = 3
            let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24), format: format).pngData { context in
                UIColor.white.setStroke(); context.cgContext.stroke(CGRect(x: 3, y: 3, width: 18, height: 18), width: 2)
            }.base64EncodedString()
            let appearance = ReaderNavigationAppearance(accent: "#ff0088", foreground: "#ffffff", muted: "#777788", background: "#0b0b0f", selection: "#7c5cff24", moreLabel: "More",
                icons: Dictionary(uniqueKeysWithValues: (ReaderNavigationAction.allCases.map(\.rawValue) + ["more"]).map { ($0, image) }))
            let state = ReaderNavigationPresentation(auth: .authed, immersive: false, blocked: false, selected: .home,
                items: ReaderDestination.allCases.map { .init(id: ReaderNavigationAction(rawValue: $0.rawValue)!, label: $0.rawValue, enabled: true) },
                secondary: [.init(id: .lists, label: "Lists", enabled: true)], appearance: appearance)
            XCTAssertTrue(state.valid)
            XCTAssertEqual(appearance.image("home")?.size, CGSize(width: 24, height: 24))
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state))
            _ = try await web.callAsyncJavaScript("""
                window.messages=[];window.session=crypto.randomUUID();window.state=state;
                uchiyomiNative.navigation.subscribe(m=>messages.push(m));
                window.send=(kind,extra={})=>uchiyomiNative.navigation.send({kind,version:2,session,revision:1,...extra});
                send('hello',{state});return true;
                """, arguments: ["state": object], in: nil, contentWorld: .page)
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertNil(bridge.presentation)
            let phoneMessages = try await web.evaluateJavaScript("messages.length") as? Int
            XCTAssertEqual(phoneMessages, 0, "Regular phones cannot acquire native navigation")
            bridge.setAvailable(true)
            _ = try await web.evaluateJavaScript("send('hello',{state});true")
            try await waitFor { (try? await web.evaluateJavaScript("messages.some(m=>m.kind==='ready')")) as? Bool == true }
            XCTAssertNil(bridge.presentation, "Ready alone must not replace web navigation")
            _ = try await web.evaluateJavaScript("send('state',{state}); true")
            try await waitFor { bridge.presentation == state }
            try await waitFor { (try? await web.evaluateJavaScript("messages.some(m=>m.kind==='mounted'&&m.revision===1)")) as? Bool == true }
            bridge.request(.library)
            try await waitFor { (try? await web.evaluateJavaScript("messages.some(m=>m.kind==='action'&&m.action==='library')")) as? Bool == true }

            let count = presentations.count
            _ = try await web.evaluateJavaScript("""
                for (const bad of [null, 0, 'invalid', []]) window.webkit.messageHandlers.navigation.postMessage(bad);
                send('state',{revision:0,state:{...state,selected:'library'}});
                send('state',{session:crypto.randomUUID(),revision:2,state:{...state,selected:'library'}});
                const envelope={document:uchiyomiNative.navigation.documentID,message:{kind:'state',version:2,session,revision:2,state:{...state,selected:'library'}}};
                const frame=document.createElement('iframe');frame.srcdoc='<script>window.webkit.messageHandlers.navigation.postMessage('+JSON.stringify(envelope)+');<\\/script>';
                document.body.append(frame);true;
                """)
            try await Task.sleep(nanoseconds: 200_000_000)
            XCTAssertEqual(presentations.count, count)
            _ = try await web.evaluateJavaScript("send('state',{revision:2,state:{...state,appearance:{...state.appearance,icons:{...state.appearance.icons,home:'not-a-png'}}}}); true")
            try await waitFor { bridge.presentation == nil }
            try await waitFor { (try? await web.evaluateJavaScript("messages.some(m=>m.kind==='reset')")) as? Bool == true }
            // Losing the rail revokes pending handshakes too; reopening permits a fresh session.
            bridge.setAvailable(false)
            _ = try await web.evaluateJavaScript("messages=[];session=crypto.randomUUID();send('hello',{state});true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertNil(bridge.presentation)
            bridge.setAvailable(true)
            _ = try await web.evaluateJavaScript("send('hello',{state});true")
            try await waitFor { (try? await web.evaluateJavaScript("messages.some(m=>m.kind==='ready')")) as? Bool == true }
            _ = try await web.evaluateJavaScript("send('state',{state});true")
            try await waitFor { bridge.presentation == state }
            bridge.setAvailable(false)
            XCTAssertNil(bridge.presentation, "Folding immediately revokes native actions")
            bridge.retire()
            _ = try await web.evaluateJavaScript("send('hello',{state}); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertNil(bridge.presentation)
            await gateway.stop()
        } catch { await gateway.stop(); throw error }
    }
}
