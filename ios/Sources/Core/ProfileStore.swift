import Foundation

/// The stable UUID and port are part of a profile's storage identity. Never regenerate them on update.
final class ProfileStore {
    struct Catalog: Codable, Equatable {
        var profiles: [ServerProfile] = []
        var selectedID: UUID?
    }
    let root: URL
    private let write: (Data, URL) throws -> Void
    private var file: URL { root.appendingPathComponent("profiles.json") }
    private var legacy: URL { root.appendingPathComponent("profile.json") }

    init(root: URL, write: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.root = root; self.write = write
    }
    func load() throws -> Catalog {
        let catalog: Catalog
        if FileManager.default.fileExists(atPath: file.path) {
            catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: file))
        } else if FileManager.default.fileExists(atPath: legacy.path) {
            let profile = try JSONDecoder().decode(ServerProfile.self, from: Data(contentsOf: legacy))
            catalog = Catalog(profiles: [profile], selectedID: profile.id)
            try save(catalog)
        } else { return Catalog() }
        try validate(catalog)
        return catalog
    }
    func save(_ catalog: Catalog) throws {
        try validate(catalog)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try write(JSONEncoder().encode(catalog), file)
        // Only remove the old pointer after the replacement has been committed successfully.
        if FileManager.default.fileExists(atPath: legacy.path) { try? FileManager.default.removeItem(at: legacy) }
    }
    func profile(for origin: URL, in catalog: Catalog) throws -> ServerProfile {
        if let saved = catalog.profiles.first(where: { $0.origin == origin }) { return saved }
        let used = Set(catalog.profiles.map(\.port))
        guard let port = (UInt16(49152)...UInt16(60999)).shuffled().first(where: { !used.contains($0) }) else {
            throw ClientError.invalid("There is no free local address for another server.")
        }
        return ServerProfile(id: UUID(), origin: origin, port: port)
    }
    func directory(for profile: ServerProfile) -> URL { root.appendingPathComponent(profile.id.uuidString, isDirectory: true) }
    private func validate(_ catalog: Catalog) throws {
        guard Set(catalog.profiles.map(\.id)).count == catalog.profiles.count,
              Set(catalog.profiles.map(\.origin)).count == catalog.profiles.count,
              Set(catalog.profiles.map(\.port)).count == catalog.profiles.count,
              catalog.selectedID == nil || catalog.profiles.contains(where: { $0.id == catalog.selectedID }) else {
            throw ClientError.invalid("The saved server list is invalid. Its local data has been left in place.")
        }
        for profile in catalog.profiles {
            guard try ServerProfile.parse(profile.origin.absoluteString, allowLoopbackHTTP: true) == profile.origin,
                  profile.port > 1023 else { throw ClientError.invalid("A saved server has an invalid address.") }
        }
    }
}
