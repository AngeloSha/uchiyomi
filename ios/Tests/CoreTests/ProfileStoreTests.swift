import Foundation
import Testing
@testable import UchiyomiCore

final class ProfileStoreTests {
    @Test func testMigrationKeepsIdentityAndFailedWritesKeepPreviousSelection() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = ServerProfile(id: UUID(), origin: try ServerProfile.parse("https://books.example:8443"), port: 53789)
        let legacy = root.appendingPathComponent("profile.json")
        try JSONEncoder().encode(original).write(to: legacy)
        let store = ProfileStore(root: root)
        var catalog = try store.load()
        #expect(catalog.profiles == [original])
        #expect(catalog.selectedID == original.id)
        #expect(!FileManager.default.fileExists(atPath: legacy.path))
        #expect(try store.profile(for: ServerProfile.parse("BOOKS.example:8443/"), in: catalog) == original)
        let other = try store.profile(for: ServerProfile.parse("https://other.example"), in: catalog)
        #expect(other.id != original.id && other.port != original.port)
        catalog.profiles.append(other); catalog.selectedID = other.id
        let failing = ProfileStore(root: root) { _, _ in throw CocoaError(.fileWriteOutOfSpace) }
        #expect(throws: (any Error).self) { try failing.save(catalog) }
        #expect(try store.load().selectedID == original.id)
        try store.save(catalog)
        #expect(try ProfileStore(root: root).load() == catalog)
        #expect(store.directory(for: original) != store.directory(for: other))
        catalog.profiles.removeAll { $0.id == original.id }
        try store.save(catalog)
        #expect(try store.load().profiles == [other])
        try store.save(.init())
        #expect(try store.load().profiles.isEmpty, "Deleting the last profile resurrected the prototype pointer")
    }
    @Test func testCollidingStorageIdentitiesAreRejected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ProfileStore(root: root)
        let a = ServerProfile(id: UUID(), origin: try ServerProfile.parse("https://a.example"), port: 54321)
        let b = ServerProfile(id: UUID(), origin: try ServerProfile.parse("https://b.example"), port: a.port)
        #expect(throws: (any Error).self) { try store.save(.init(profiles: [a,b], selectedID: a.id)) }
        #expect(throws: (any Error).self) { try store.save(.init(profiles: [a], selectedID: b.id)) }
    }
}
