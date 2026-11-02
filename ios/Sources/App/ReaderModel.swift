import SwiftUI
import WebKit

@MainActor
final class ReaderModel: ObservableObject {
    @Published var address = ""
    @Published var progress: String?
    @Published var error: String?
    @Published var status: String?
    @Published var webView: WKWebView?
    @Published var serverName = "Uchiyomi"
    @Published var busy = false
    @Published var downloadProgress: Double?
    @Published var awaitingConfirmation = false
    @Published var canRecover = false
    @Published var profiles: [ServerProfile] = []
    @Published var serverStatuses: [UUID: ServerAvailability] = [:]
    @Published var selectedID: UUID?
    @Published var showingServers = false
    @Published var addingServer = false
    private var profile: ServerProfile?
    private var gateway: Gateway?
    private var client: RemoteClient?
    private var cache: AssetCache?
    private var activeUI: PreparedUI?
    private var startupTask: Task<Void, Never>?
    private var readerID = UUID()
    private var restored = false
    private let root: URL
    private let assetClient: ((RemoteClient) -> any AssetFetching)?
    private let startupTimeout: UInt64
    private let serverProbe: @Sendable (URL) async -> ServerAvailability
    private let outageRetryInterval: UInt64
    private var statusChecks: [UUID: UUID] = [:]
    private var observedServerStatuses: [UUID: ServerAvailability] = [:]
    private var outageProfileID: UUID?
    private var outageMonitorTask: Task<Void, Never>?
    private var foreground = true
    private lazy var store = ProfileStore(root: root)
    private var catalog = ProfileStore.Catalog()

    init(root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Uchiyomi", isDirectory: true),
         startupTimeout: UInt64 = 30_000_000_000,
         assetClient: ((RemoteClient) -> any AssetFetching)? = nil,
         outageRetryInterval: UInt64 = 30_000_000_000,
         serverProbe: @escaping @Sendable (URL) async -> ServerAvailability = { await ServerAvailability.check($0) }) {
        self.root = root
        self.startupTimeout = startupTimeout
        self.assetClient = assetClient
        self.serverProbe = serverProbe
        self.outageRetryInterval = outageRetryInterval
    }

    private func setServerStatus(_ status: ServerAvailability, for id: UUID) {
        statusChecks[id] = nil
        serverStatuses[id] = status
        if status != .checking { observedServerStatuses[id] = status }
        if status == .available && outageProfileID == id { dismissStatus() }
    }

    func refreshServerStatuses() async {
        await refreshServerStatuses(profiles)
    }

    private func refreshServerStatuses(_ targets: [ServerProfile]) async {
        let pending = targets.map { ($0, UUID(), observedServerStatuses[$0.id] ?? .unknown) }
        for (profile, token, _) in pending {
            statusChecks[profile.id] = token
            serverStatuses[profile.id] = .checking
        }
        defer {
            // Leaving the page cancels its probes. Retain the previous observation;
            // never overwrite a newer connection result or a removed profile.
            for (profile, token, previous) in pending where statusChecks[profile.id] == token {
                statusChecks[profile.id] = nil
                serverStatuses[profile.id] = previous
            }
        }
        let probe = serverProbe
        await withTaskGroup(of: (UUID, UUID, ServerAvailability).self) { group in
            for (profile, token, _) in pending {
                group.addTask { (profile.id, token, await probe(profile.origin)) }
            }
            for await (id, token, result) in group {
                guard !Task.isCancelled else { group.cancelAll(); break }
                if statusChecks[id] == token && profiles.contains(where: { $0.id == id }) {
                    setServerStatus(result, for: id)
                }
            }
        }
    }

    func dismissStatus() {
        status = nil
        outageProfileID = nil
        outageMonitorTask?.cancel(); outageMonitorTask = nil
    }

    func suspend() {
        foreground = false
        outageMonitorTask?.cancel(); outageMonitorTask = nil
    }

    private func startOutageMonitor(checkImmediately: Bool = false) {
        guard foreground, outageProfileID != nil, webView != nil else { return }
        outageMonitorTask?.cancel()
        let interval = outageRetryInterval
        outageMonitorTask = Task { [weak self] in
            var immediate = checkImmediately
            while !Task.isCancelled {
                if !immediate {
                    do { try await Task.sleep(nanoseconds: interval) } catch { return }
                }
                immediate = false
                guard await self?.refreshOutageStatus() == true else { return }
            }
        }
    }

    private func refreshOutageStatus() async -> Bool {
        guard foreground, let profile, outageProfileID == profile.id else { return false }
        await refreshServerStatuses([profile])
        return foreground && outageProfileID == profile.id
    }

    private func save(_ updated: ProfileStore.Catalog) throws {
        try store.save(updated)
        catalog = updated; profiles = updated.profiles; selectedID = updated.selectedID
    }

    func restore() async {
        guard !restored else { return }
        restored = true
        do {
            catalog = try store.load(); profiles = catalog.profiles; selectedID = catalog.selectedID
            if let saved = catalog.profiles.first(where: { $0.id == catalog.selectedID }) {
                profile = saved; address = saved.origin.absoluteString
                await open(saved, prepare: false)
            }
        } catch { self.error = error.localizedDescription }
    }
    func connect() async {
        guard !busy else { return }
        do {
            let origin = try ServerProfile.parse(address)
            let selected = try store.profile(for: origin, in: catalog)
            if !catalog.profiles.contains(where: { $0.id == selected.id }) {
                var updated = catalog
                updated.profiles.append(selected)
                try save(updated)
            }
            await open(selected, prepare: true)
        } catch { self.error = error.localizedDescription }
    }
    @discardableResult
    private func stopReader() async -> Bool {
        readerID = UUID(); activeUI = nil
        dismissStatus()
        startupTask?.cancel(); startupTask = nil
        weak var retired = webView
        webView?.stopLoading(); webView?.navigationDelegate = nil; webView?.uiDelegate = nil; webView = nil
        client?.cancel()
        await gateway?.stop(); gateway = nil
        client = nil
        // SwiftUI and pending WebKit callbacks may retain the view until the next run-loop turn.
        // WebKit requires it to be released before its persistent store can be removed.
        for _ in 0..<50 {
            if retired == nil { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return retired == nil
    }
    private func open(_ selected: ServerProfile, prepare: Bool, checkForUpdates: Bool = true) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await replaceReader(selected, prepare: prepare, checkForUpdates: checkForUpdates)
    }
    // Callers hold busy across the entire transition, including cache activation/rollback.
    private func replaceReader(_ selected: ServerProfile, prepare: Bool, checkForUpdates: Bool = true) async {
        precondition(busy)
        error = nil; status = nil; progress = "Checking for updates…"; downloadProgress = nil
        serverName = selected.origin.host ?? "Uchiyomi"
        showingServers = false
        defer { progress = nil; downloadProgress = nil }
        await stopReader()
        profile = selected; address = selected.origin.absoluteString
        if checkForUpdates { setServerStatus(.checking, for: selected.id) }
        awaitingConfirmation = false
        let cache = AssetCache(root: store.directory(for: selected).appendingPathComponent("ui"))
        self.cache = cache
        canRecover = (try? await cache.previous()) != nil
        do {
            let remote = try RemoteClient(origin: selected.origin, vault: KeychainCookieVault(profileID: selected.id))
            client = remote
            let savedUI = try? await cache.load()
            let previousUI = savedUI == nil ? try? await cache.previous() : nil
            if prepare || (savedUI == nil && previousUI == nil) {
                progress = "Connecting to server…"
                let response = try await remote.fetch("/auth/config", maxBytes: 64 * 1024)
                try ServerCompatibility.validate(response)
            }
            progress = "Checking for updates…"
            let launch = try await cache.prepareForLaunch(client: assetClient?(remote) ?? remote,
                                                         checkForUpdates: checkForUpdates) { [weak self] count, total in
                await MainActor.run {
                    self?.progress = "Loading Uchiyomi…"
                    self?.downloadProgress = Double(count) / Double(max(total, 1))
                }
            }
            let ui = launch.ui
            if let failure = launch.fallbackError {
                status = ClientError.savedReaderMessage(failure)
                if ClientError.isUnavailable(failure) { outageProfileID = selected.id }
                setServerStatus(.failure(failure), for: selected.id)
            } else if checkForUpdates { setServerStatus(.available, for: selected.id) }
            progress = "Opening your library…"
            let gateway = Gateway(profile: selected, ui: ui, client: remote)
            try await gateway.start()
            self.gateway = gateway; profile = selected; activeUI = ui
            var updated = catalog
            updated.selectedID = selected.id
            try save(updated)
            canRecover = (try? await cache.previous()) != nil
            let pending = try await cache.needsConfirmation()
            awaitingConfirmation = pending && ui.manifest.startupCheckVersion != 1
            let readerID = self.readerID
            let view = try await NativeWebView.make(profile: selected, policy: gateway.policy) { [weak self] in
                Task { await self?.confirmUI(readerID: readerID) }
            }
            serverName = selected.origin.host ?? "Uchiyomi"
            webView = view
            addingServer = false; showingServers = false
            // Start at the web app's home page; its auth state handles offline fallback.
            view.load(URLRequest(url: selected.localOrigin))
            startOutageMonitor()
            if pending && ui.manifest.startupCheckVersion == 1 {
                startupTask = Task { [weak self, weak view] in
                    do { try await Task.sleep(nanoseconds: self?.startupTimeout ?? 30_000_000_000) } catch { return }
                    guard let self, self.webView === view else { return }
                    if self.canRecover {
                        self.startupTask = nil
                        await self.recover()
                        if self.error == nil { self.status = "The update couldn’t start. Your previous version has been restored." }
                    } else {
                        self.error = "The app couldn’t finish starting. Check your connection and try again."
                    }
                }
            }
        } catch {
            await stopReader()
            setServerStatus(.failure(error), for: selected.id)
            self.error = ClientError.connectionMessage(error)
        }
    }
    func confirmUI() async {
        guard !busy else { return }
        await confirmUI(readerID: readerID)
    }
    private func confirmUI(readerID: UUID) async {
        guard self.readerID == readerID, let cache, let ui = activeUI else { return }
        do {
            try await cache.confirm(ui)
            guard self.readerID == readerID else { return }
            startupTask?.cancel(); startupTask = nil
            awaitingConfirmation = false; error = nil
        } catch {
            guard self.readerID == readerID else { return }
            self.error = "Could not confirm this app version: \(error.localizedDescription)"
        }
    }
    func recover() async {
        guard !busy, let profile, let cache else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await cache.rollback(rejectingCurrent: true)
            await replaceReader(profile, prepare: false, checkForUpdates: false)
        } catch { self.error = error.localizedDescription }
    }
    func retry() async {
        guard let profile else { await connect(); return }
        await open(profile, prepare: false)
    }
    func choose(_ selected: ServerProfile) async {
        guard !busy, profiles.contains(selected) else { return }
        showingServers = false; addingServer = false
        await open(selected, prepare: false)
    }
    func addServer() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await stopReader()
        profile = nil; activeUI = nil; cache = nil
        address = ""; error = nil; status = nil; canRecover = false
        awaitingConfirmation = false
        showingServers = false; addingServer = true
    }
    /// Call only after the user confirms deletion in the server list.
    func forget(_ forgotten: ServerProfile) async {
        guard !busy, profiles.contains(forgotten) else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            if profile?.id == forgotten.id {
                guard await stopReader() else { throw ClientError.invalid("The reader is still closing. Please try again.") }
                profile = nil; cache = nil; activeUI = nil
                canRecover = false; awaitingConfirmation = false
                address = ""; status = nil
            }
            // Remove credentials before files; keep a failed removal listed so it can be retried.
            try KeychainCookieVault(profileID: forgotten.id).remove()
            try await NativeWebView.removeStore(for: forgotten.id)
            let directory = store.directory(for: forgotten)
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            var updated = catalog
            updated.profiles.removeAll { $0.id == forgotten.id }
            if updated.selectedID == forgotten.id { updated.selectedID = nil }
            try save(updated)
            statusChecks[forgotten.id] = nil
            serverStatuses[forgotten.id] = nil
            observedServerStatuses[forgotten.id] = nil
        } catch { self.error = "Could not finish removing this server. Retry to remove its remaining local data. \(error.localizedDescription)" }
    }
    func resume() async {
        foreground = true
        guard !busy, let gateway else { return }
        let readerID = self.readerID
        do { try await gateway.start() } catch {
            guard self.readerID == readerID else { return }
            self.error = "Cannot restart the reader: \(error.localizedDescription)"
        }
        guard self.readerID == readerID else { return }
        startOutageMonitor(checkImmediately: true)
    }
    func reload() async {
        guard !busy, let view = webView else { return }
        error = nil
        await resume()
        guard !busy, webView === view else { return }
        view.reload()
    }
    func isLocal(_ url: URL) -> Bool {
        guard let profile else { return false }
        return url.scheme == "http" && url.host == "localhost" && url.port == Int(profile.port)
    }
    func navigationFailed(_ view: WKWebView, error: Error) {
        guard webView === view, (error as NSError).code != NSURLErrorCancelled else { return }
        self.error = error.localizedDescription
    }
}
