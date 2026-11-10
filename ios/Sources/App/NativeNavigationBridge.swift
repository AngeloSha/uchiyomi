import Foundation
import WebKit

enum ReaderNavigationAction: String, Codable {
    case home, library, search, discover, offline, profile
    case lists, history, moments, updates, admin
    case quickSettings = "quick-settings"
    var symbol: String {
        if let primary = ReaderDestination(rawValue: rawValue) { return primary.symbol }
        switch self {
        case .lists: return "bookmark"
        case .history: return "clock"
        case .moments: return "photo"
        case .updates: return "bell"
        case .admin: return "shield"
        default: return "slider.horizontal.3"
        }
    }
}
struct ReaderSecondaryItem: Equatable, Codable, Identifiable {
    let id: ReaderNavigationAction
    let label: String
    let enabled: Bool
}
struct ReaderNavigationPresentation: Equatable, Codable {
    enum Auth: String, Codable { case loading, anon, authed, offline }
    let auth: Auth
    let immersive: Bool
    let selected: ReaderDestination
    let items: [ReaderNavigationItem]
    let secondary: [ReaderSecondaryItem]
    var showsTabs: Bool { (auth == .authed || auth == .offline) && !immersive }
    func allows(_ action: ReaderNavigationAction) -> Bool {
        items.contains { $0.id.rawValue == action.rawValue && $0.enabled } || secondary.contains { $0.id == action && $0.enabled }
    }
    var valid: Bool {
        guard items.count <= 6, secondary.count <= 6,
              Set(items.map(\.id)).count == items.count, Set(secondary.map(\.id)).count == secondary.count,
              items.allSatisfy({ !$0.label.isEmpty && $0.label.utf16.count <= 120 && ($0.badge?.utf16.count ?? 0) <= 8 && ($0.status?.utf16.count ?? 0) <= 240 }),
              secondary.allSatisfy({ !$0.label.isEmpty && $0.label.utf16.count <= 120 && ReaderDestination(rawValue: $0.id.rawValue) == nil }) else { return false }
        if auth == .anon || auth == .loading { return items.isEmpty && secondary.isEmpty }
        let required: Set<ReaderDestination> = [.home, .library, .search, .offline, .profile]
        guard required.isSubset(of: Set(items.map(\.id))), items.contains(where: { $0.id == selected }) else { return false }
        if auth == .offline {
            return items.allSatisfy { $0.enabled == ($0.id == .offline) }
                && secondary.allSatisfy { $0.enabled == ($0.id == .quickSettings) }
        }
        return true
    }
}

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
                    arguments: ["documentID": document, "message": ["kind": "reset", "version": 1, "session": session]],
                    in: nil, contentWorld: .page)
            }
        }
        epoch = UUID(); pendingHello = UUID(); document = nil; session = nil; revision = 0
        timeout?.cancel(); timeout = nil
        presentation = nil; changed(nil)
    }

    // Executed at document start in the main frame; document identity changes on every load.
    static let script = """
        const navigationDocument = crypto.randomUUID();
        const navigationListeners = new Set();
        const navigation = Object.freeze({
          version: 1, documentID: navigationDocument,
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
              let url = message.frameInfo.request.url, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
              let data = try? JSONSerialization.data(withJSONObject: message.body), data.count <= 16_384,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              UUID(uuidString: envelope.document) != nil else { return }
        let value = envelope.message
        guard value.version == 1, UUID(uuidString: value.session) != nil,
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
                guard self.epoch == epoch, self.pendingHello == attempt, self.webView === webView, current as? String == envelope.document else { return }
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
            guard let state = value.state, state.valid else { return }
            guard value.revision > revision || presentation == nil || presentation == state else { return }
            revision = value.revision
            timeout?.cancel(); timeout = nil
            presentation = state; changed(state)
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
        guard self.epoch == epoch, let webView, let document, let session else { return }
        var value = value
        value["version"] = 1; value["session"] = session
        let delivered = try? await webView.callAsyncJavaScript(
            "return window.uchiyomiNative?.navigation?.deliver(documentID, message) === true",
            arguments: ["documentID": document, "message": value], in: nil, contentWorld: .page)
        guard self.epoch == epoch, self.webView === webView else { return }
        if delivered as? Bool != true { reset() }
    }
}
