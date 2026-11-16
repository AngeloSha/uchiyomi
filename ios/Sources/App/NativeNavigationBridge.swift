import Foundation
import WebKit

/// The message handler never owns a web view or grants a general-purpose native API.
@MainActor
final class NativeNavigationBridge: NSObject, WKScriptMessageHandler {
    private struct Message: Decodable {
        let kind: String
        let version: Int
        let session: String
        let revision: Int
        var state: ReaderNavigationPresentation?
        var request: String?
        var accepted: Bool?
    }
    private struct Envelope: Decodable { let document: String; let message: Message }
    private let origin: URL
    private let changed: (ReaderNavigationPresentation?) -> Void
    private weak var webView: WKWebView?
    private var document: String?
    private var session: String?
    private var revision = 0
    private var epoch = UUID()
    private var pendingHello = UUID()
    private var earlyHello: Envelope?
    private var timeout: Task<Void, Never>?
    private(set) var presentation: ReaderNavigationPresentation?

    init(origin: URL, changed: @escaping (ReaderNavigationPresentation?) -> Void) {
        self.origin = origin; self.changed = changed
    }
    func attach(_ view: WKWebView) { webView = view }
    func retire() { reset(); webView = nil }
    func reset() {
        if let webView, let document, let session {
            // Restore web chrome if this document is still alive. Captured identities
            // prevent a delayed reset from affecting a replacement document/session.
            Task { [weak webView] in
                _ = try? await webView?.callAsyncJavaScript(
                    "return window.uchiyomiNative?.navigation?.deliver(documentID, message)",
                    arguments: ["documentID": document, "message": ["kind": "reset", "version": 2, "session": session]],
                    in: nil, contentWorld: .page)
            }
        }
        epoch = UUID(); pendingHello = UUID(); earlyHello = nil; document = nil; session = nil; revision = 0
        timeout?.cancel(); timeout = nil
        presentation = nil; changed(nil)
    }

    func documentDidFinish() {
        guard let earlyHello, let webView, !webView.isLoading else { return }
        self.earlyHello = nil
        receive(earlyHello, from: webView)
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    // Executed at document start in the main frame; document identity changes on every load.
    static let script = """
        const navigationDocument = crypto.randomUUID();
        const navigationListeners = new Set();
        const navigation = Object.freeze({
          version: 2, documentID: navigationDocument,
          send: message => window.webkit.messageHandlers.navigation.postMessage({document: navigationDocument, message}),
          subscribe: receive => { navigationListeners.add(receive); return () => navigationListeners.delete(receive); },
          deliver: (documentID, message) => {
            if (documentID !== navigationDocument || !navigationListeners.size) return false;
            for (const receive of [...navigationListeners]) receive(message);
            return true;
          }
        });
        """

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              isLocal(message.frameInfo.request.url), isLocal(webView.url),
              let body = message.body as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 196_608,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              UUID(uuidString: envelope.document) != nil else { return }
        if webView.isLoading {
            if envelope.message.kind == "hello" { earlyHello = envelope }
            return
        }
        receive(envelope, from: webView)
    }

    private func receive(_ envelope: Envelope, from webView: WKWebView) {
        let value = envelope.message
        guard value.version == 2, UUID(uuidString: value.session) != nil,
              value.revision > 0, value.revision <= 9_007_199_254_740_991 else { return }
        if value.kind == "hello" {
            guard let state = value.state, state.valid else { return }
            guard envelope.document != document || value.session != session else { return }
            let epoch = self.epoch
            let attempt = UUID()
            pendingHello = attempt
            Task { [weak self, weak webView] in
                guard let self, let webView else { return }
                // An old main document can still have queued messages at the same origin.
                // Check the identity in the CURRENT document before accepting its handshake.
                let current = try? await webView.callAsyncJavaScript("return window.uchiyomiNative?.navigation?.documentID", arguments: [:], in: nil, contentWorld: .page)
                guard self.epoch == epoch, self.pendingHello == attempt, self.webView === webView, !webView.isLoading, self.isLocal(webView.url), current as? String == envelope.document else { return }
                self.reset()
                let epoch = self.epoch
                self.document = envelope.document; self.session = value.session; self.revision = value.revision
                self.timeout = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
                    guard let self, self.epoch == epoch else { return }
                    self.reset()
                }
                await self.deliver(["kind": "ready"], epoch: epoch)
            }
            return
        }
        guard envelope.document == document, value.session == session, value.revision >= revision else { return }
        switch value.kind {
        case "state":
            guard let state = value.state, state.valid else { reset(); return }
            guard value.revision > revision || presentation == nil || presentation == state else { return }
            revision = value.revision
            timeout?.cancel(); timeout = nil
            presentation = state; changed(state)
            let epoch = self.epoch
            Task { [weak self] in await self?.deliver(["kind": "mounted", "revision": value.revision], epoch: epoch) }
        case "stop": reset()
        case "result":
            // A rejection leaves committed web state authoritative, including overflow.
            if value.accepted == false { changed(presentation) }
        default: break
        }
    }

    func request(_ action: ReaderNavigationAction) {
        guard presentation?.allows(action) == true else { return }
        let epoch = self.epoch
        let message: [String: Any] = ["kind": "action", "action": action.rawValue, "request": UUID().uuidString, "revision": revision]
        Task { [weak self] in await self?.deliver(message, epoch: epoch) }
    }
    private func deliver(_ value: [String: Any], epoch: UUID) async {
        guard self.epoch == epoch, let webView, !webView.isLoading, isLocal(webView.url), let document, let session else { return }
        var value = value
        value["version"] = 2; value["session"] = session
        let delivered = try? await webView.callAsyncJavaScript(
            "return window.uchiyomiNative?.navigation?.deliver(documentID, message) === true",
            arguments: ["documentID": document, "message": value], in: nil, contentWorld: .page)
        guard self.epoch == epoch, self.webView === webView else { return }
        if delivered as? Bool != true { reset() }
    }
}
