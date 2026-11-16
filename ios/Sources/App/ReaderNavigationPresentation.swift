import UIKit
import ImageIO

enum ReaderDestination: String, Codable, CaseIterable {
    case home, library, search, discover, offline, profile
}
enum ReaderNavigationAction: String, Codable, CaseIterable {
    case home, library, search, discover, offline, profile
    case lists, history, moments, updates, admin
}
struct ReaderNavigationItem: Equatable, Codable, Identifiable {
    let id: ReaderNavigationAction
    let label: String
    let enabled: Bool
    var badge: String? = nil
    var status: String? = nil
    var valid: Bool { !label.isEmpty && label.utf16.count <= 120 && (badge?.utf16.count ?? 0) <= 8 && (status?.utf16.count ?? 0) <= 240 }
}

struct ReaderNavigationAppearance: Equatable, Codable {
    let accent: String
    let foreground: String
    let muted: String
    let background: String
    let moreLabel: String
    let icons: [String: String]

    static func color(_ hex: String) -> UIColor {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
                       blue: CGFloat(value & 255) / 255, alpha: 1)
    }
    func image(_ id: String) -> UIImage? {
        guard let encoded = icons[id], encoded.utf8.count <= 12_288,
              let data = Data(base64Encoded: encoded), data.count <= 9_216,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == "public.png", CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              properties[kCGImagePropertyPixelWidth] as? Int == 72,
              properties[kCGImagePropertyPixelHeight] as? Int == 72,
              let image = UIImage(data: data, scale: 3) else { return nil }
        return image.withRenderingMode(.alwaysTemplate)
    }
    var valid: Bool {
        let keys = Set(ReaderNavigationAction.allCases.map(\.rawValue) + ["more"])
        return [accent, foreground, muted, background].allSatisfy { $0.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil }
            && !moreLabel.isEmpty && moreLabel.utf16.count <= 120
            && icons.count <= keys.count && Set(icons.keys).isSubset(of: keys)
            && icons.keys.allSatisfy { image($0) != nil }
    }
}

struct ReaderNavigationPresentation: Equatable, Codable {
    enum Auth: String, Codable { case loading, anon, authed, offline }
    let auth: Auth
    let immersive: Bool
    let blocked: Bool
    let selected: ReaderDestination
    let items: [ReaderNavigationItem]
    let secondary: [ReaderNavigationItem]
    let appearance: ReaderNavigationAppearance?
    var showsNavigation: Bool { (auth == .authed || auth == .offline) && !immersive }
    func allows(_ action: ReaderNavigationAction) -> Bool {
        showsNavigation && !blocked && (items + secondary).contains { $0.id == action && $0.enabled }
    }
    var valid: Bool {
        guard items.count <= 6, secondary.count <= 5,
              Set((items + secondary).map(\.id)).count == items.count + secondary.count,
              (items + secondary).allSatisfy(\.valid),
              items.allSatisfy({ ReaderDestination(rawValue: $0.id.rawValue) != nil }),
              secondary.allSatisfy({ ReaderDestination(rawValue: $0.id.rawValue) == nil }),
              let appearance, appearance.valid else { return false }
        if auth == .anon || auth == .loading { return items.isEmpty && secondary.isEmpty }
        let required: Set<ReaderNavigationAction> = [.home, .library, .search, .offline, .profile]
        guard required.isSubset(of: Set(items.map(\.id))), items.contains(where: { $0.id.rawValue == selected.rawValue }),
              (items + secondary).allSatisfy({ appearance.icons[$0.id.rawValue] != nil }), appearance.icons["more"] != nil else { return false }
        if auth == .offline {
            return items.allSatisfy { $0.enabled == ($0.id == .offline) } && secondary.allSatisfy { !$0.enabled }
        }
        return true
    }
}
