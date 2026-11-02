import Foundation
import Testing
@testable import UchiyomiCore

private final class AssetFixture: AssetFetching {
    enum Failure { case none, offline, gatewayDown, assetGatewayDown, interrupted, corrupt, changed, schema, cancelled }
    var failure: Failure = .none
    var manifestReads = 0
    var assetReads = 0
    var startupCheckVersion: Int?
    let revision: String
    init(_ revision: String) { self.revision = revision }
    private let paths = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt", "/_next/static/reader.js"]
    func bytes(_ path: String) -> Data { Data("\(revision) \(path)".utf8) }
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        if path == "/mobile-assets.json" {
            manifestReads += 1
            if failure == .offline { throw URLError(.notConnectedToInternet) }
            if failure == .gatewayDown { return HTTPResponse(status: 502, headers: ["Content-Type": "text/html"], body: Data("This App is Down".utf8)) }
            var manifest = AssetManifest(schemaVersion: 1, protocolVersion: 1,
                offlineSchemaVersion: failure == .schema ? 3 : 2,
                buildId: AssetManifest.digest(Data((revision + (failure == .changed && manifestReads > 1 ? "changed" : "")).utf8)),
                files: paths.map { .init(path: $0, size: bytes($0).count, sha256: AssetManifest.digest(bytes($0)), contentType: "text/plain") })
            manifest.startupCheckVersion = startupCheckVersion
            manifest.version = "0.101.0"
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: try JSONEncoder().encode(manifest))
        }
        assetReads += 1
        if failure == .assetGatewayDown { return HTTPResponse(status: 503) }
        if failure == .interrupted && assetReads == 3 { throw URLError(.networkConnectionLost) }
        if failure == .cancelled && assetReads == 3 { throw CancellationError() }
        return HTTPResponse(status: 200, body: failure == .corrupt ? Data("wrong".utf8) : bytes(path))
    }
}

final class CacheUpdateTests {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    deinit { try? FileManager.default.removeItem(at: root) }
    private func baseline() async throws -> (AssetCache, PreparedUI) {
        let cache = AssetCache(root: root)
        let first = try await cache.prepare(client: AssetFixture("first")) { _, _ in }
        try await cache.confirm(first)
        return (cache, first)
    }

    @Test func automaticLaunchChecksWithoutDownloadingUnchangedAssets() async throws {
        let cache = AssetCache(root: root)
        let remote = AssetFixture("first")
        let first = try await cache.prepareForLaunch(client: remote) { _, _ in }
        #expect(remote.assetReads == 7)
        try await cache.confirm(first.ui)
        let unchanged = AssetFixture("first")
        let next = try await cache.prepareForLaunch(client: unchanged) { _, _ in }
        #expect(next.ui.directory == first.ui.directory)
        #expect(unchanged.manifestReads == 1)
        #expect(unchanged.assetReads == 0)
        #expect(next.ui.manifest.displayVersion == "0.101.0")
        let changed = AssetFixture("second")
        let update = try await cache.prepareForLaunch(client: changed) { _, _ in }
        #expect(update.ui.manifest.buildId != first.ui.manifest.buildId)
        #expect(try await cache.previous()?.directory == first.ui.directory)
        #expect(try await cache.needsConfirmation())
    }

    @Test func automaticFailuresUseSavedUIButDoNotHideCancellation() async throws {
        let (cache, first) = try await baseline()
        for failure in [AssetFixture.Failure.offline, .gatewayDown, .assetGatewayDown, .interrupted, .corrupt, .changed, .schema] {
            let remote = AssetFixture("second"); remote.failure = failure
            let result = try await cache.prepareForLaunch(client: remote) { _, _ in }
            #expect(result.ui.directory == first.directory)
            #expect(result.fallbackError != nil)
            let unavailable = [.offline, .gatewayDown, .assetGatewayDown, .interrupted].contains(failure)
            #expect(ClientError.isUnavailable(try #require(result.fallbackError)) == unavailable)
            if unavailable { #expect(ClientError.savedReaderMessage(try #require(result.fallbackError)).contains("Server unavailable")) }
            #expect(try await cache.load()?.directory == first.directory)
        }
        let cancelled = AssetFixture("second"); cancelled.failure = .cancelled
        do { _ = try await cache.prepareForLaunch(client: cancelled) { _, _ in }; Issue.record("Swallowed cancellation") }
        catch is CancellationError {} catch { Issue.record("Unexpected error: \(error)") }
        let freshDown = AssetCache(root: root.appendingPathComponent("fresh-down"))
        let down = AssetFixture("first"); down.failure = .gatewayDown
        do { _ = try await freshDown.prepareForLaunch(client: down) { _, _ in }; Issue.record("Invented an offline cache") }
        catch { #expect(ClientError.isUnavailable(error)); #expect(!ClientError.connectionMessage(error).contains("saved")) }
        let missing = AssetCache(root: root.appendingPathComponent("missing"))
        let offline = AssetFixture("first"); offline.failure = .offline
        do { _ = try await missing.prepareForLaunch(client: offline) { _, _ in }; Issue.record("Invented an offline cache") }
        catch is URLError {} catch { Issue.record("Unexpected error: \(error)") }
    }

    @Test func unconfirmedStartupRollsBackAndSkipsRejectedBuildUntilHostChanges() async throws {
        let (cache, first) = try await baseline()
        let broken = AssetFixture("broken"); broken.startupCheckVersion = 1
        _ = try await cache.prepareForLaunch(client: broken) { _, _ in }
        let restarted = AssetCache(root: root)
        let same = AssetFixture("broken"); same.startupCheckVersion = 1
        let result = try await restarted.prepareForLaunch(client: same) { _, _ in }
        #expect(result.ui.directory == first.directory)
        #expect(same.assetReads == 0)
        #expect(try await restarted.needsConfirmation() == false)
        let fixed = AssetFixture("fixed"); fixed.startupCheckVersion = 1
        let update = try await restarted.prepareForLaunch(client: fixed) { _, _ in }
        #expect(update.ui.manifest.buildId != first.manifest.buildId)
        try await restarted.confirm(update.ui)
        let noCheck = AssetFixture("never-requested"); noCheck.failure = .offline
        let restored = try await restarted.prepareForLaunch(client: noCheck, checkForUpdates: false) { _, _ in }
        #expect(restored.ui.directory == update.ui.directory)
        #expect(noCheck.manifestReads == 0)
    }

    @Test func damagedCacheCanBeRepairedFromSameHostBuild() async throws {
        let (cache, first) = try await baseline()
        try Data("damaged".utf8).write(to: first.directory.appendingPathComponent("index.html"))
        let repaired = try await cache.prepareForLaunch(client: AssetFixture("first")) { _, _ in }
        #expect(repaired.ui.directory != first.directory)
        #expect(repaired.ui.manifest == first.manifest)
        #expect(try await cache.load()?.directory == repaired.ui.directory)
    }

    @Test func freshProfileDirectoryWithoutTrailingSlashCanActivateOnlyItsOwnUI() async throws {
        let path = root.appendingPathComponent("profiles/new/ui").path
        let cache = AssetCache(root: URL(fileURLWithPath: path, isDirectory: false))
        let ui = try await cache.prepare(client: AssetFixture("fresh")) { _, _ in }
        #expect(try await cache.load()?.directory == ui.directory)
        let other = AssetCache(root: root.appendingPathComponent("profiles/other/ui", isDirectory: true))
        do { try await other.activate(ui); Issue.record("Accepted another profile's UI") } catch {}
        let restarted = AssetCache(root: URL(fileURLWithPath: path, isDirectory: true))
        #expect(try await restarted.load()?.directory == ui.directory)
    }

    @Test func cacheDirectoryAliasCanActivateOnlyItsOwnGeneration() async throws {
        let fm = FileManager.default
        let target = root.appendingPathComponent("real", isDirectory: true)
        let alias = root.appendingPathComponent("alias", isDirectory: true)
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: alias, withDestinationURL: target)
        let cache = AssetCache(root: alias.appendingPathComponent("ui", isDirectory: true))
        let staged = try await cache.stage(client: AssetFixture("aliased")) { _, _ in }
        let canonical = PreparedUI(directory: staged.directory.resolvingSymlinksInPath(), manifest: staged.manifest)
        try await cache.activate(canonical)
        try await cache.confirm(canonical)
        #expect(try await cache.load()?.manifest == staged.manifest)
        let other = AssetCache(root: target.appendingPathComponent("another-profile", isDirectory: true))
        do { try await other.activate(canonical); Issue.record("Accepted another profile's UI through an alias") } catch {}
    }

    @Test func updateKeepsEachGenerationCoherentAndRecoversAfterRestart() async throws {
        let (cache, first) = try await baseline()
        let next = try await cache.stage(client: AssetFixture("second")) { _, _ in }
        try await cache.confirm(first) // A late startup callback cannot delete a staged update.
        #expect(FileManager.default.fileExists(atPath: next.directory.path))
        #expect(try await cache.load()?.directory == first.directory)
        #expect(try Data(contentsOf: first.directory.appendingPathComponent("reader/index.html")) == Data("first /reader/index.html".utf8))
        try await cache.activate(next)
        #expect(try await cache.load()?.directory == next.directory)
        #expect(try await cache.previous()?.directory == first.directory)
        #expect(try await cache.needsConfirmation())
        let restarted = AssetCache(root: root)
        #expect(try await restarted.needsConfirmation())
        let restored = try await restarted.rollback()
        #expect(restored.directory == first.directory)
        #expect(try await restarted.needsConfirmation() == false)
    }

    @Test func startupDetectsDamagedUpdateWithoutDamagingPrevious() async throws {
        let (cache, first) = try await baseline()
        let next = try await cache.prepare(client: AssetFixture("second")) { _, _ in }
        try Data("damaged".utf8).write(to: next.directory.appendingPathComponent("reader/index.html"))
        do { _ = try await cache.load(); Issue.record("Started a damaged generation") } catch { }
        #expect(try await cache.rollback().directory == first.directory)
        #expect(try await cache.load()?.manifest == first.manifest)
    }

    @Test func failedTransfersAndUnsupportedSchemaKeepWorkingGeneration() async throws {
        let (cache, first) = try await baseline()
        for failure in [AssetFixture.Failure.interrupted, .corrupt, .changed, .schema, .cancelled] {
            let remote = AssetFixture("second"); remote.failure = failure
            do { _ = try await cache.prepare(client: remote) { _, _ in }; Issue.record("Accepted failed update") } catch { }
            #expect(try await cache.load()?.directory == first.directory)
            if failure == .schema { #expect(remote.assetReads == 0) }
            #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).allSatisfy { !$0.hasPrefix("stage-") })
        }
    }

    @Test func diskFullDuringFileOrPointerWritePreservesActiveGeneration() async throws {
        let (_, first) = try await baseline()
        for component in ["index.html", "selection.json"] {
            let cache = AssetCache(root: root) { data, url in
                if url.lastPathComponent == component { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            }
            do { _ = try await cache.prepare(client: AssetFixture("second")) { _, _ in }; Issue.record("Ignored disk-full failure") } catch { }
            #expect(try await cache.load()?.directory == first.directory)
        }
    }

    @Test func prototypePointerMigratesAndUnconfirmedVersionsNeverReplaceFallback() async throws {
        let (cache, first) = try await baseline()
        let legacyDirectory = root.appendingPathComponent(first.manifest.buildId, isDirectory: true)
        try FileManager.default.moveItem(at: first.directory, to: legacyDirectory)
        try FileManager.default.removeItem(at: root.appendingPathComponent("selection.json"))
        try JSONEncoder().encode(first.manifest.buildId).write(to: root.appendingPathComponent("active.json"))
        #expect(try await cache.load()?.directory == legacyDirectory)
        let second = try await cache.prepare(client: AssetFixture("second")) { _, _ in }
        let third = try await cache.prepare(client: AssetFixture("third")) { _, _ in }
        #expect(try await cache.previous()?.directory == legacyDirectory)
        try await cache.confirm(second) // A late acknowledgement cannot confirm a different active generation.
        #expect(try await cache.needsConfirmation())
        try await cache.confirm(third)
        #expect(try await cache.needsConfirmation() == false)
        #expect(try await cache.previous()?.directory == legacyDirectory)
    }
}
