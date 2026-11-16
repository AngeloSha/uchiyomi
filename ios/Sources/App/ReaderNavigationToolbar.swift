import SwiftUI

/// Uchiyomi's sidebar styling in the Duo's system rail. Phones keep web navigation.
struct ReaderNavigationToolbar: ViewModifier {
    @ObservedObject var model: ReaderModel
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.modifier(DuoReaderNavigationToolbar(model: model))
        } else {
            content.toolbar(.hidden, for: .navigationBar)
        }
    }
}

@available(iOS 27.1, *)
private struct DuoReaderNavigationToolbar: ViewModifier {
    @ObservedObject var model: ReaderModel
    @Environment(\.toolbarVerticalEdge) private var edge
    private var shown: Bool {
        edge != nil && model.navigation?.showsNavigation == true && model.webView != nil && model.progress == nil && !model.showingServers
    }
    func body(content: Content) -> some View {
        content
            .toolbar(shown ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                if shown, let state = model.navigation, let appearance = state.appearance {
                    ToolbarItem(placement: .topBarTrailing) {
                        // Match Sidebar.tsx: 48pt tiles, 22pt glyphs, 12pt corners, 4pt gaps.
                        // One custom stack keeps More next to the destinations, at the top.
                        VStack(spacing: 4) {
                            ForEach(state.items) { item in destination(item, state: state, appearance: appearance) }
                            more(state: state, appearance: appearance)
                        }
                        .buttonStyle(.plain)
                        .fixedSize()
                        .opacity(state.blocked ? 0.4 : 1)
                    }
                    .sharedBackgroundVisibility(.hidden)
                    .axisBehavior(.verticalPreferred)
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
    }

    private func tile(_ id: String, appearance: ReaderNavigationAppearance, selected: Bool = false, badge: String? = nil) -> some View {
        NavigationGlyph(appearance: appearance, id: id, badge: badge)
            .foregroundStyle(Color(uiColor: ReaderNavigationAppearance.color(selected ? appearance.accent : appearance.muted)))
            .frame(width: 48, height: 48)
            .background(selected ? Color(uiColor: ReaderNavigationAppearance.color(appearance.selection)) : .clear,
                        in: RoundedRectangle(cornerRadius: 12, style: .circular))
            .overlay(alignment: .leading) {
                if selected {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color(uiColor: ReaderNavigationAppearance.color(appearance.accent)))
                        .frame(width: 2, height: 32).offset(x: -6)
                }
            }
            .contentShape(Rectangle())
    }

    private func destination(_ item: ReaderNavigationItem, state: ReaderNavigationPresentation, appearance: ReaderNavigationAppearance) -> some View {
        let selected = state.selected.rawValue == item.id.rawValue
        return Button { model.navigationBridge?.request(item.id) } label: {
            tile(item.id.rawValue, appearance: appearance, selected: selected, badge: item.badge)
        }
        .opacity(item.enabled ? 1 : 0.35)
        .disabled(model.busy || state.blocked || !item.enabled)
        .accessibilityLabel(item.label)
        .accessibilityIdentifier("destination-\(item.id.rawValue)")
        .accessibilityValue(item.status ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func more(state: ReaderNavigationPresentation, appearance: ReaderNavigationAppearance) -> some View {
        Menu {
            ForEach(state.secondary) { item in
                Button { model.navigationBridge?.request(item.id) } label: {
                    Label { Text(item.label) } icon: { NavigationGlyph(appearance: appearance, id: item.id.rawValue) }
                }.disabled(!item.enabled)
            }
        } label: {
            tile("more", appearance: appearance)
        }
        .tint(Color(uiColor: ReaderNavigationAppearance.color(appearance.accent)))
        .disabled(model.busy || state.blocked)
        .accessibilityLabel(appearance.moreLabel)
        .accessibilityIdentifier("navigation-more")
    }
}

private struct NavigationGlyph: View {
    let appearance: ReaderNavigationAppearance
    let id: String
    var badge: String? = nil
    var body: some View {
        if let image = appearance.image(id) {
            Image(uiImage: image).renderingMode(.template).resizable().scaledToFit().frame(width: 22, height: 22)
                .overlay(alignment: .topTrailing) {
                    if let badge {
                        Text(badge).font(.system(size: 9, weight: .bold)).monospacedDigit()
                            .foregroundStyle(.black).padding(.horizontal, 3).padding(.vertical, 1)
                            .background(Color(uiColor: ReaderNavigationAppearance.color(appearance.accent)), in: RoundedRectangle(cornerRadius: 3))
                            .offset(x: 8, y: -8).accessibilityHidden(true)
                    }
                }
        }
    }
}
