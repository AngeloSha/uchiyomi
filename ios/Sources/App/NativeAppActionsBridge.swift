import Foundation
import WebKit

enum NativeAppAction: String, Decodable {
    case servers, reload
    case controlsReady = "controls-ready"
    case controlsUnavailable = "controls-unavailable"
    var isAvailability: Bool { self == .controlsReady || self == .controlsUnavailable }
}

enum NativeNavigationLayout: String {
    case side, bottom
}

/// Optional device controls for Profile. It never accepts an address, script or arbitrary native command.
@MainActor
final class NativeAppActionsBridge: NSObject, WKScriptMessageHandler {
    private struct Message: Decodable {
        let version: Int
        let documentID: String
        let action: NativeAppAction
    }
    private let origin: URL
    private let perform: (NativeAppAction) -> Void
    private weak var webView: WKWebView?
    private var epoch = UUID()
    private var pending = UUID()
    private var layoutUpdate = UUID()
    private var navigationLayout: NativeNavigationLayout?
    private var pendingControlsReady: Message?

    init(origin: URL, perform: @escaping (NativeAppAction) -> Void) {
        self.origin = origin
        self.perform = perform
    }

    func attach(_ view: WKWebView) { webView = view }
    func reset() { epoch = UUID(); pending = UUID(); layoutUpdate = UUID(); pendingControlsReady = nil }
    func retire() { reset(); webView = nil }

    func setNavigationLayout(_ layout: NativeNavigationLayout?) {
        guard navigationLayout != layout else { return }
        navigationLayout = layout
        publishNavigationLayout()
    }

    func documentDidFinish() {
        publishNavigationLayout()
        guard let ready = pendingControlsReady, let webView, !webView.isLoading else { return }
        pendingControlsReady = nil
        receive(ready, from: webView)
    }

    private func publishNavigationLayout() {
        guard let webView else { return }
        let epoch = self.epoch, update = UUID(), layout = navigationLayout?.rawValue
        layoutUpdate = update
        Task { [weak self, weak webView] in
            guard let self, let webView, self.isLocal(webView.url), !webView.isLoading else { return }
            let document = try? await webView.callAsyncJavaScript(
                "return window.uchiyomiNative?.appActions?.documentID", arguments: [:], in: nil, contentWorld: .page)
            guard let documentID = document as? String, UUID(uuidString: documentID) != nil,
                  self.epoch == epoch, self.layoutUpdate == update, self.webView === webView else { return }
            // Validate again in the same JavaScript turn as the DOM write, including after a reload.
            _ = try? await webView.callAsyncJavaScript("""
                if (window.uchiyomiNative?.appActions?.documentID !== documentID || !document.documentElement) return false;
                if (layout === null) document.documentElement.removeAttribute('data-native-navigation-layout');
                else document.documentElement.setAttribute('data-native-navigation-layout', layout);
                return true;
                """, arguments: ["documentID": documentID, "layout": layout as Any? ?? NSNull()], in: nil, contentWorld: .page)
        }
    }

    // Each main document owns a fresh immutable identity, including after a same-origin reload.
    static let script = """
        const appDocumentID = crypto.randomUUID();
        const appActions = Object.freeze({
          version: 1, documentID: appDocumentID,
          request: action => window.webkit.messageHandlers.appActions.postMessage({version: 1, documentID: appDocumentID, action})
        });
        """

    private func isLocal(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              isLocal(message.frameInfo.request.url), isLocal(webView.url),
              let body = message.body as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 512,
              let value = try? JSONDecoder().decode(Message.self, from: data), value.version == 1,
              UUID(uuidString: value.documentID) != nil else { return }
        if webView.isLoading {
            // DOM startup can acknowledge before didFinish. Keep only one bounded envelope and validate
            // its document again after navigation commits; an older provisional document proves nothing.
            if value.action.isAvailability { pendingControlsReady = value }
            return
        }
        if value.action.isAvailability { pendingControlsReady = nil }
        receive(value, from: webView)
    }

    private func receive(_ value: Message, from webView: WKWebView) {
        let epoch = self.epoch
        let request = UUID()
        pending = request
        Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            // Queued messages from a retired main document can have the same origin.
            let current = try? await webView.callAsyncJavaScript(
                "return window.uchiyomiNative?.appActions?.documentID", arguments: [:], in: nil, contentWorld: .page)
            guard self.epoch == epoch, self.pending == request, self.webView === webView,
                  self.isLocal(webView.url), !webView.isLoading,
                  current as? String == value.documentID else { return }
            self.perform(value.action)
        }
    }
}
