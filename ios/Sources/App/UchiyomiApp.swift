import SwiftUI
import WebKit

@main
struct UchiyomiApp: App {
    @StateObject private var model = ReaderModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ReaderView(model: model)
                .task {
                    // Hosted XCTest cases own their models/listeners, including installation fixtures.
                    if NSClassFromString("XCTestCase") == nil { await model.restore() }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.resume() } }
                    else { model.suspend() }
                }
        }
    }
}

// Match the default web palette in web/app/globals.css.
private enum ReaderTheme {
    static let accent = Color(red: 124 / 255, green: 92 / 255, blue: 1)
    static let foreground = Color(red: 247 / 255, green: 247 / 255, blue: 251 / 255)
    static let muted = Color(red: 185 / 255, green: 185 / 255, blue: 198 / 255)
    static let surface = Color(red: 11 / 255, green: 11 / 255, blue: 15 / 255)
}
private struct ReaderBackground: View {
    var body: some View {
        Color.black.overlay {
            RadialGradient(colors: [ReaderTheme.accent.opacity(0.15), .clear],
                           center: UnitPoint(x: 0.5, y: 0.2), startRadius: 0, endRadius: 360)
        }.ignoresSafeArea()
    }
}
private struct ReaderBrand: View {
    var body: some View {
        VStack(spacing: 16) {
            Image("BrandMark").resizable().scaledToFit().frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("uchiyomi").foregroundStyle(ReaderTheme.foreground)
                Text(".").foregroundStyle(ReaderTheme.accent)
            }
            .font(.system(size: 42, weight: .bold, design: .rounded)).tracking(-1.5)
            .accessibilityElement(children: .ignore).accessibilityLabel("Uchiyomi")
        }
    }
}
private struct ReaderCard: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(24)
            .background(ReaderTheme.surface, in: RoundedRectangle(cornerRadius: 24))
            .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.08), lineWidth: 1) }
    }
}
private struct ReaderPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
            .padding(.vertical, 16).foregroundStyle(.white)
            .background(ReaderTheme.accent.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 16))
    }
}

struct ReaderView: View {
    @ObservedObject var model: ReaderModel
    var body: some View {
        NavigationStack {
            Group {
                if model.progress != nil {
                    ReaderLoadingView(model: model)
                } else if let webView = model.webView {
                    ReaderWebView(view: webView, model: model).id(ObjectIdentifier(webView))
                } else {
                    ServerConnectionView(model: model)
                }
            }
            .navigationTitle("")
            .toolbar(model.webView == nil ? .hidden : .visible, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.webView != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Section(model.serverName) {
                                Button("Servers", systemImage: "server.rack") { model.showingServers = true }
                                Button("Reload", systemImage: "arrow.clockwise") { Task { await model.reload() } }
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                        .disabled(model.busy).accessibilityLabel("Reader menu")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if model.webView != nil && (model.awaitingConfirmation || model.status != nil || model.error != nil) {
                    VStack(spacing: 10) {
                        if model.awaitingConfirmation {
                            Text("If the app has opened correctly, keep this version.").font(.footnote)
                            HStack {
                                Button("Keep this version") { Task { await model.confirmUI() } }
                                if model.canRecover {
                                    Button("Restore previous version") { Task { await model.recover() } }
                                }
                            }.disabled(model.busy)
                        }
                        if let status = model.status {
                            HStack {
                                Text(status).font(.footnote)
                                Button("Dismiss") { model.dismissStatus() }.font(.footnote)
                            }
                        }
                        if let error = model.error {
                            Text(error).font(.footnote)
                            HStack {
                                Button("Try again") { Task { await model.retry() } }
                                if model.canRecover {
                                    Button("Restore previous version") { Task { await model.recover() } }
                                }
                            }.font(.footnote).disabled(model.busy)
                        }
                    }.padding(12).frame(maxWidth: .infinity).background(.regularMaterial)
                }
            }
            .navigationDestination(isPresented: $model.showingServers) { ServerManagementView(model: model) }
        }
        .tint(ReaderTheme.accent).preferredColorScheme(.dark)
    }
}

struct ReaderLoadingView: View {
    @ObservedObject var model: ReaderModel
    var body: some View {
        VStack(spacing: 32) {
            ReaderBrand()
            VStack(spacing: 18) {
                Text(model.serverName).font(.headline).multilineTextAlignment(.center)
                if let value = model.downloadProgress {
                    ProgressView(value: value).tint(ReaderTheme.accent)
                        .accessibilityLabel("Loading progress")
                    Text(model.progress ?? "Opening your library…").font(.subheadline).foregroundStyle(ReaderTheme.muted)
                    Text(value, format: .percent.precision(.fractionLength(0)))
                        .font(.caption.monospacedDigit()).foregroundStyle(ReaderTheme.muted)
                } else {
                    ProgressView().tint(ReaderTheme.accent)
                    Text(model.progress ?? "Opening your library…").font(.subheadline).foregroundStyle(ReaderTheme.muted)
                }
            }.modifier(ReaderCard())
        }
        .frame(maxWidth: 420).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { ReaderBackground() }.accessibilityIdentifier("readerLoading")
    }
}

struct ServerManagementView: View {
    @ObservedObject var model: ReaderModel
    @State private var removing: ServerProfile?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 14) {
                    Image("BrandMark").resizable().scaledToFit().frame(width: 40, height: 40)
                        .clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Your servers").font(.title2.weight(.bold))
                        Text("Choose a library to open.").font(.subheadline).foregroundStyle(ReaderTheme.muted)
                    }
                }.padding(.vertical, 8)
                ForEach(model.profiles) { profile in
                    VStack(alignment: .leading, spacing: 20) {
                        Button { Task { await model.choose(profile) } } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "server.rack").font(.title2).foregroundStyle(ReaderTheme.accent)
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(profile.origin.host ?? "Uchiyomi").font(.headline).foregroundStyle(ReaderTheme.foreground)
                                    Text(profile.origin.absoluteString).font(.caption).foregroundStyle(ReaderTheme.muted)
                                        .lineLimit(2).multilineTextAlignment(.leading)
                                    ServerStatusView(status: model.serverStatuses[profile.id] ?? .unknown)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(ReaderTheme.muted)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("selectServer-\(profile.id)")
                        HStack {
                            if model.selectedID == profile.id {
                                Label("Selected", systemImage: "checkmark.circle.fill")
                                    .font(.caption.weight(.medium)).foregroundStyle(ReaderTheme.accent)
                            }
                            Spacer()
                            Button("Remove", systemImage: "trash", role: .destructive) { removing = profile }
                                .font(.caption).frame(minHeight: 44).accessibilityLabel("Remove \(profile.origin.host ?? "server")")
                        }
                    }.modifier(ReaderCard()).disabled(model.busy)
                }
                Button { Task { await model.addServer() } } label: { Label("Add server", systemImage: "plus") }
                    .buttonStyle(ReaderPrimaryButton()).disabled(model.busy)
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red) }
            }.frame(maxWidth: 560).padding(24).frame(maxWidth: .infinity)
        }
        .background { ReaderBackground() }
        .navigationTitle("Servers").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
        .task { await model.refreshServerStatuses() }
        .refreshable { await model.refreshServerStatuses() }
        .confirmationDialog("Remove this server from this device?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { profile in
            Button("Remove server", role: .destructive) { Task { await model.forget(profile) } }
            Button("Cancel", role: .cancel) {}
        } message: { profile in
            Text("This removes the saved session, downloads, and unsynced progress for \(profile.origin.absoluteString) from this device. The server library is kept.")
        }
    }
}

private struct ServerStatusView: View {
    let status: ServerAvailability
    private var symbol: String {
        switch status {
        case .unknown: return "circle.dotted"
        case .checking: return "arrow.triangle.2.circlepath"
        case .available: return "checkmark.circle.fill"
        case .unavailable: return "wifi.slash"
        case .needsAttention: return "exclamationmark.circle.fill"
        }
    }
    private var color: Color {
        switch status {
        case .available: return .green
        case .unavailable, .needsAttention: return .orange
        case .unknown, .checking: return ReaderTheme.muted
        }
    }
    var body: some View {
        Label(status.label, systemImage: symbol).font(.caption.weight(.medium))
            .foregroundStyle(color).accessibilityElement(children: .ignore)
            .accessibilityLabel("Server status: \(status.label)")
    }
}

private struct ServerConnectionView: View {
    @ObservedObject var model: ReaderModel
    @FocusState private var addressFocused: Bool
    private func connect() {
        addressFocused = false
        Task { await model.connect() }
    }
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 32) {
                    VStack(spacing: 16) {
                        ReaderBrand()
                        Text("Your library, your way.").font(.subheadline).foregroundStyle(ReaderTheme.muted)
                    }
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("SERVER ADDRESS").font(.caption.weight(.medium)).tracking(1.2).foregroundStyle(ReaderTheme.muted)
                            TextField("https://books.example.com", text: $model.address)
                                .font(.body).foregroundStyle(ReaderTheme.foreground)
                                .textContentType(.URL).keyboardType(.URL)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .submitLabel(.go).focused($addressFocused).onSubmit(connect)
                                .padding(16).background(.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 16))
                                .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(addressFocused ? ReaderTheme.accent : .white.opacity(0.12), lineWidth: 1) }
                                .accessibilityLabel("Server address").accessibilityIdentifier("serverAddress")
                        }
                        Button(action: connect) { Label("Connect to server", systemImage: "arrow.right") }
                            .buttonStyle(ReaderPrimaryButton())
                            .disabled(model.busy || model.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .opacity(model.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.5 : 1)
                            .accessibilityIdentifier("prepareUI")
                        if let error = model.error {
                            Label(error, systemImage: "exclamationmark.circle").font(.footnote)
                                .foregroundStyle(Color(red: 1, green: 0.6, blue: 0.6))
                                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("connectionError")
                            if model.canRecover {
                                Button("Restore previous version") { Task { await model.recover() } }.font(.footnote).disabled(model.busy)
                            }
                        }
                    }.modifier(ReaderCard())
                    if !model.profiles.isEmpty {
                        Button("Saved servers") { addressFocused = false; model.showingServers = true }.disabled(model.busy)
                    }
                }.frame(maxWidth: 420).padding(.horizontal, 24).padding(.vertical, 32)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }.background { ReaderBackground() }
    }
}

private struct ReaderWebView: UIViewRepresentable {
    let view: WKWebView
    let model: ReaderModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> WKWebView {
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: ReaderModel
        init(model: ReaderModel) { self.model = model }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard model.webView === webView, navigationAction.targetFrame == nil, let url = navigationAction.request.url else { return nil }
            if model.isLocal(url) { webView.load(navigationAction.request) }
            else if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            return nil
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard model.webView === webView, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if model.isLocal(url) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") {
                    UIApplication.shared.open(url)
                }
            }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { model.navigationFailed(webView, error: error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard model.webView === webView else { return }
            Task { await model.reload() }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { model.navigationFailed(webView, error: error) }
    }
}
