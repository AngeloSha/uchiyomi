import Foundation

protocol AssetFetching {
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse
}
extension RemoteClient: AssetFetching {
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        try await fetch(path, maxBytes: maxBytes, timeout: path == "/mobile-assets.json" ? 5 : 15)
    }
}

actor AssetCache {
    struct Selection: Codable, Equatable {
        var active: String
        var previous: String?
        var confirmed: Bool
    }
    let root: URL
    private var preparing = false
    private var stagedKeys = Set<String>()
    // Injectable to exercise disk-full errors at the file and atomic pointer write boundaries.
    private let write: (Data, URL) throws -> Void
    init(root: URL, write: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        // A newly created profile may supply a URL without a trailing directory slash.
        // Foundation URL equality includes that representation even when the filesystem path is identical.
        self.root = URL(fileURLWithPath: root.path, isDirectory: true).standardizedFileURL
        self.write = write
    }
    private func selection() throws -> Selection? {
        let pointer = root.appendingPathComponent("selection.json")
        if FileManager.default.fileExists(atPath: pointer.path) {
            return try JSONDecoder().decode(Selection.self, from: Data(contentsOf: pointer))
        }
        // Preserve prototype installations, including their origin, cookies and chapter data.
        let legacy = root.appendingPathComponent("active.json")
        guard FileManager.default.fileExists(atPath: legacy.path) else { return nil }
        return Selection(active: try JSONDecoder().decode(String.self, from: Data(contentsOf: legacy)), confirmed: true)
    }
    private func save(_ selection: Selection) throws {
        try write(JSONEncoder().encode(selection), root.appendingPathComponent("selection.json"))
    }
    private func generation(_ key: String) throws -> PreparedUI {
        let parts = key.split(separator: "_", omittingEmptySubsequences: false)
        guard (parts.count == 1 || parts.count == 2), AssetManifest.validHash(String(parts[0])),
              parts.count == 1 || UUID(uuidString: String(parts[1])) != nil else {
            throw ClientError.invalid("Invalid saved app version.")
        }
        let directory = root.appendingPathComponent(key, isDirectory: true)
        let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: directory.appendingPathComponent("mobile-assets.json")))
        try manifest.validate()
        guard manifest.buildId == String(parts[0]) else { throw ClientError.invalid("Saved app files do not match their inventory.") }
        for asset in manifest.files {
            let bytes = try Data(contentsOf: directory.appendingPathComponent(String(asset.path.dropFirst())))
            guard bytes.count == asset.size, AssetManifest.digest(bytes) == asset.sha256 else {
                throw ClientError.invalid("Saved app files are incomplete. Restore the previous version or download them again.")
            }
        }
        return PreparedUI(directory: directory, manifest: manifest)
    }
    func load() throws -> PreparedUI? {
        guard let selected = try selection() else { return nil }
        return try generation(selected.active)
    }
    func previous() throws -> PreparedUI? {
        guard let key = try selection()?.previous else { return nil }
        return try generation(key)
    }
    func needsConfirmation() throws -> Bool { try selection()?.confirmed == false }

    struct LaunchResult {
        let ui: PreparedUI
        let fallbackError: Error?
    }

    /// Called only at startup/server selection, before a reader uses the generation.
    func prepareForLaunch(client: any AssetFetching, checkForUpdates: Bool = true,
                          progress: @escaping (Int, Int) async -> Void) async throws -> LaunchResult {
        var saved = try? load()
        if saved == nil || (checkForUpdates && (try? needsConfirmation()) == true && saved?.manifest.startupCheckVersion == 1) {
            if (try? previous()) != nil { saved = try rollback(rejectingCurrent: true) }
        }
        if !checkForUpdates, let saved { return LaunchResult(ui: saved, fallbackError: nil) }
        do {
            let reply = try await client.assetResponse("/mobile-assets.json", maxBytes: 4 * 1024 * 1024)
            let manifest = try AssetManifest.decodeResponse(reply)
            let rejected = try? String(contentsOf: root.appendingPathComponent("rejected-build.txt"), encoding: .utf8)
            if let saved, manifest == saved.manifest || manifest.buildId == rejected {
                return LaunchResult(ui: saved, fallbackError: nil)
            }
            let ui = try await stage(client: client, progress: progress, initialResponse: reply)
            try activate(ui)
            return LaunchResult(ui: ui, fallbackError: nil)
        } catch {
            if error is CancellationError || Task.isCancelled { throw error }
            guard let saved else { throw error }
            return LaunchResult(ui: saved, fallbackError: error)
        }
    }

    /// Stage without changing the selected version or files used by an open reader.
    func stage(client: any AssetFetching, progress: @escaping (Int, Int) async -> Void, initialResponse: HTTPResponse? = nil) async throws -> PreparedUI {
        guard !preparing else { throw ClientError.invalid("An app download is already in progress.") }
        preparing = true
        defer { preparing = false }
        let reply: HTTPResponse
        if let initialResponse { reply = initialResponse }
        else { reply = try await client.assetResponse("/mobile-assets.json", maxBytes: 4 * 1024 * 1024) }
        let manifest = try AssetManifest.decodeResponse(reply)
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let stage = root.appendingPathComponent("stage-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: stage) }
        await progress(0, manifest.files.count)
        for (index, asset) in manifest.files.enumerated() {
            try Task.checkCancellation()
            let response = try await client.assetResponse(asset.path, maxBytes: asset.size)
            try ClientError.checkAvailability(response)
            guard response.status == 200, response.body.count == asset.size, AssetManifest.digest(response.body) == asset.sha256 else {
                throw ClientError.invalid("An app file changed during download. Retry when the server has finished updating.")
            }
            let destination = stage.appendingPathComponent(String(asset.path.dropFirst()))
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try write(response.body, destination)
            await progress(index + 1, manifest.files.count)
        }
        let confirmation = try await client.assetResponse("/mobile-assets.json", maxBytes: 4 * 1024 * 1024)
        guard try AssetManifest.decodeResponse(confirmation) == manifest else {
            throw ClientError.invalid("The server updated during download. Please retry.")
        }
        try Task.checkCancellation()
        try write(reply.body, stage.appendingPathComponent("mobile-assets.json"))
        // A unique immutable directory permits repairing a damaged copy of the same build ID.
        let destination = root.appendingPathComponent(manifest.buildId + "_" + UUID().uuidString, isDirectory: true)
        try fm.moveItem(at: stage, to: destination)
        stagedKeys.insert(destination.lastPathComponent)
        return PreparedUI(directory: destination, manifest: manifest)
    }
    func activate(_ ui: PreparedUI) throws {
        // Resolve both paths after staging has created the directory. iOS can expose
        // the same container through /var and /private/var, including temporary roots.
        guard ui.directory.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL.path
                == root.resolvingSymlinksInPath().standardizedFileURL.path else {
            throw ClientError.invalid("The app download does not belong to this server.")
        }
        let key = ui.directory.lastPathComponent
        _ = try generation(key)
        let current = try selection()
        if current?.active == key { return }
        // Another unconfirmed version must never replace the last confirmed fallback.
        let fallback = current.flatMap { $0.confirmed ? $0.active : $0.previous }
        try save(Selection(active: key, previous: fallback, confirmed: false))
        stagedKeys.remove(key)
    }
    func prepare(client: any AssetFetching, progress: @escaping (Int, Int) async -> Void) async throws -> PreparedUI {
        let ui = try await stage(client: client, progress: progress)
        try activate(ui)
        return ui
    }
    func confirm(_ ui: PreparedUI) throws {
        guard var current = try selection(), current.active == ui.directory.lastPathComponent else { return }
        current.confirmed = true
        try save(current)
        // Cookie and WebKit stores are outside this UI-only root.
        let keep = Set([current.active, current.previous].compactMap { $0 })
        for directory in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) {
            let name = directory.lastPathComponent
            guard !keep.contains(name), !stagedKeys.contains(name), !name.hasPrefix("stage-"),
                  AssetManifest.validHash(String(name.prefix(64))),
                  (try? directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            try? FileManager.default.removeItem(at: directory)
        }
    }
    func rollback(rejectingCurrent: Bool = false) throws -> PreparedUI {
        guard let ui = try previous() else { throw ClientError.invalid("No previous app version is available. Connect to download the app again.") }
        if rejectingCurrent, let current = try selection() {
            let build = String(current.active.prefix(64))
            if AssetManifest.validHash(build) { try write(Data(build.utf8), root.appendingPathComponent("rejected-build.txt")) }
        }
        try save(Selection(active: ui.directory.lastPathComponent, confirmed: true))
        return ui
    }
}
