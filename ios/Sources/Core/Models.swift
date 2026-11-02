import Foundation
import CryptoKit

enum ClientError: LocalizedError {
    case invalid(String)
    case serverUnavailable(Int)
    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .serverUnavailable:
            return "The server is unavailable right now. Try again when it is back online."
        }
    }

    static func checkAvailability(_ response: HTTPResponse) throws {
        if (500...599).contains(response.status) { throw ClientError.serverUnavailable(response.status) }
    }

    static func isUnavailable(_ error: Error) -> Bool {
        if case .serverUnavailable = error as? ClientError { return true }
        guard let network = error as? URLError else { return false }
        return [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
                .timedOut, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff].contains(network.code)
    }

    static func savedReaderMessage(_ error: Error) -> String {
        if isUnavailable(error) { return "Server unavailable. You’re using the saved offline reader." }
        if (error as? CocoaError)?.code == .fileWriteOutOfSpace {
            return "Not enough storage to save the update. Free some space and try again. Your saved reader is still available."
        }
        if error is URLError { return connectionMessage(error) + " Your saved reader is still available." }
        return "The reader update couldn’t be completed. Your saved reader is still available."
    }

    static func connectionMessage(_ error: Error) -> String {
        guard let network = error as? URLError else { return error.localizedDescription }
        switch network.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .secureConnectionFailed:
            return "A secure connection could not be established. Check the HTTPS address and make sure this device trusts the server's certificate."
        case .clientCertificateRejected, .clientCertificateRequired:
            return "This server requires a client certificate. Choose a server that supports password sign-in without a client certificate."
        case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .timedOut, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return "The server could not be reached. Check its address and your connection, then try again. Saved downloads are kept."
        default: return error.localizedDescription
        }
    }
}

enum ServerAvailability: Equatable, Sendable {
    case unknown, checking, available, unavailable, needsAttention

    var label: String {
        switch self {
        case .unknown: return "Not checked"
        case .checking: return "Checking…"
        case .available: return "Available"
        case .unavailable: return "Unavailable"
        case .needsAttention: return "Needs attention"
        }
    }

    static func failure(_ error: Error) -> Self {
        ClientError.isUnavailable(error) ? .unavailable : .needsAttention
    }
}

struct ServerProfile: Codable, Identifiable, Equatable {
    let id: UUID
    let origin: URL
    let port: UInt16

    static func parse(_ input: String, allowLoopbackHTTP: Bool = false) throws -> URL {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(where: { $0.isWhitespace }),
              var url = URLComponents(string: text.contains("://") ? text : "https://" + text),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              url.port == nil || (1...65535).contains(url.port!) else {
            throw ClientError.invalid("Enter the server address, without a path, password, or query.")
        }
        let local = ["localhost", "127.0.0.1", "[::1]"].contains(host.lowercased())
        guard url.scheme?.lowercased() == "https" || (allowLoopbackHTTP && local && url.scheme == "http") else {
            throw ClientError.invalid("Use an HTTPS server with a certificate trusted by this device.")
        }
        url.scheme = url.scheme?.lowercased()
        url.host = host.lowercased()
        url.path = ""
        if url.port == 443 && url.scheme == "https" { url.port = nil }
        guard let result = url.url else { throw ClientError.invalid("Invalid server address.") }
        return result
    }

    var localOrigin: URL { URL(string: "http://localhost:\(port)")! }
    var localHost: String { "localhost:\(port)" }
}

enum ServerCompatibility {
    static func validate(_ response: HTTPResponse) throws {
        try ClientError.checkAvailability(response)
        guard response.status == 200,
              response.headers["Content-Type"]?.lowercased().split(separator: ";").first == "application/json",
              let config = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any] else {
            throw ClientError.invalid("The server did not return its Uchiyomi configuration. Check that this is the server's main HTTPS address.")
        }
        guard config["mode"] as? String == "local", config["desktop"] as? Bool != true else {
            throw ClientError.invalid("This server needs password sign-in enabled. External sign-in and desktop servers are not supported.")
        }
    }
}

struct AssetManifest: Codable, Equatable {
    struct Asset: Codable, Equatable {
        let path: String
        let size: Int
        let sha256: String
        let contentType: String
    }
    let schemaVersion: Int
    let protocolVersion: Int
    let offlineSchemaVersion: Int
    let buildId: String
    let files: [Asset]
    var startupCheckVersion: Int? = nil
    var version: String? = nil

    var displayVersion: String { version ?? String(buildId.prefix(8)) }

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validHash(_ text: String) -> Bool { text.count == 64 && text.allSatisfy { "0123456789abcdef".contains($0) } }
    static func decodeResponse(_ response: HTTPResponse) throws -> AssetManifest {
        try ClientError.checkAvailability(response)
        guard response.status == 200,
              response.headers["Content-Type"]?.lowercased().split(separator: ";").first == "application/json",
              let manifest = try? JSONDecoder().decode(AssetManifest.self, from: response.body) else {
            throw ClientError.invalid("This server does not support offline preparation yet. Update it to a compatible Uchiyomi build, then try again.")
        }
        try manifest.validate()
        return manifest
    }
    static func safePath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains(where: { $0.asciiValue.map { $0 < 32 || $0 == 127 } ?? false }),
              !path.contains("\\"), !path.contains("%"), !path.contains("?"), !path.contains("#") else { return false }
        return path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && !$0.hasPrefix(".") }
    }
    func validate() throws {
        if let version {
            guard version.count <= 80, version.range(of: #"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else {
                throw ClientError.invalid("The server published an invalid app version.")
            }
        }
        guard schemaVersion == 1, protocolVersion == 1, offlineSchemaVersion == 2,
              (0...1).contains(startupCheckVersion ?? 0), Self.validHash(buildId) else {
            throw ClientError.invalid("This server's UI needs a different wrapper or offline storage version.")
        }
        guard !files.isEmpty, files.count <= 10_000 else { throw ClientError.invalid("Invalid UI file inventory.") }
        var paths = Set<String>()
        var total = 0
        for file in files {
            guard Self.safePath(file.path), paths.insert(file.path).inserted,
                  (0...64 * 1024 * 1024).contains(file.size), Self.validHash(file.sha256),
                  !file.contentType.isEmpty, !file.contentType.contains("\r"), !file.contentType.contains("\n") else {
                throw ClientError.invalid("The server supplied an invalid UI asset.")
            }
            total += file.size
        }
        guard total <= 256 * 1024 * 1024 else { throw ClientError.invalid("The reader app exceeds the 256 MB preparation limit.") }
        let required = ["/index.html", "/downloads/index.html", "/reader/index.html", "/index.txt", "/downloads/index.txt", "/reader/index.txt"]
        guard required.allSatisfy(paths.contains) else { throw ClientError.invalid("The UI is missing offline reader files.") }
    }
}

struct PreparedUI {
    let directory: URL
    let manifest: AssetManifest

    func asset(for requestPath: String) -> AssetManifest.Asset? {
        if let exact = manifest.files.first(where: { $0.path == requestPath }) { return exact }
        let route = requestPath.hasSuffix("/") ? requestPath + "index.html" : requestPath + "/index.html"
        return manifest.files.first { $0.path == route }
    }
}
