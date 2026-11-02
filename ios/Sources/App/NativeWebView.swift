import WebKit
import UIKit

@MainActor
enum NativeWebView {
    static func removeStore(for id: UUID) async throws {
        // WebKit's process shutdown can outlive the final WKWebView reference. Deletion is
        // idempotent; retry briefly, but keep the profile listed if removal still fails.
        for attempt in 0..<3 {
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    WKWebsiteDataStore.remove(forIdentifier: id) { error in
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume() }
                    }
                }
                return
            } catch {
                if attempt == 2 { throw error }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }
    static func make(profile: ServerProfile, policy: GatewayPolicy, onReady: @escaping () -> Void = {}) async throws -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profile.id)
        configuration.limitsNavigationsToAppBoundDomains = true
        let marker: [String: Any] = ["platform": "ios", "protocolVersion": 1, "serverOrigin": profile.origin.absoluteString]
        let json = String(data: try JSONSerialization.data(withJSONObject: marker), encoding: .utf8)!
        let script = "Object.defineProperty(window, 'uchiyomiNative', {value:Object.freeze(Object.assign(\(json), {ready:()=>window.webkit.messageHandlers.readerReady.postMessage(null)})), writable:false, configurable:false});"
        configuration.userContentController.add(NativeReadyHandler(origin: profile.localOrigin, ready: onReady), name: "readerReady")
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let cookie = HTTPCookie(properties: [.name: policy.cookieName, .value: policy.token,
            .domain: "localhost", .path: "/", HTTPCookiePropertyKey("HttpOnly"): "TRUE", HTTPCookiePropertyKey("SameSite"): "Strict"])!
        await configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        #if DEBUG
        view.isInspectable = true
        #endif
        return view
    }
}

@MainActor
private final class NativeReadyHandler: NSObject, WKScriptMessageHandler {
    let origin: URL
    let ready: () -> Void
    init(origin: URL, ready: @escaping () -> Void) { self.origin = origin; self.ready = ready }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { return }
        ready()
    }
}
