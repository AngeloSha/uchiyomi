import SwiftUI

/// Native placement, with glyphs and colours supplied by the current web document.
struct ReaderNavigationToolbar: ViewModifier {
    @ObservedObject var model: ReaderModel
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.modifier(AdaptiveReaderNavigationToolbar(model: model))
        } else {
            content.modifier(PlacedReaderNavigationToolbar(model: model, vertical: false))
        }
    }
}

@available(iOS 27.1, *)
private struct AdaptiveReaderNavigationToolbar: ViewModifier {
    @ObservedObject var model: ReaderModel
    @Environment(\.toolbarVerticalEdge) private var edge
    func body(content: Content) -> some View {
        content.modifier(PlacedReaderNavigationToolbar(model: model, vertical: edge != nil))
    }
}

private struct PlacedReaderNavigationToolbar: ViewModifier {
    @ObservedObject var model: ReaderModel
    let vertical: Bool
    private var shown: Bool { model.navigation?.showsNavigation == true && model.webView != nil && model.progress == nil && !model.showingServers }
    func body(content: Content) -> some View {
        content
            .toolbar(shown && vertical ? .visible : .hidden, for: .navigationBar)
            .toolbar(shown && !vertical ? .visible : .hidden, for: .bottomBar)
            .toolbar {
                if shown, let state = model.navigation, let appearance = state.appearance {
                    if vertical {
                        // One group at the top of the Duo rail, with More after the destinations.
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            ForEach(state.items) { item in destination(item, state: state, appearance: appearance) }
                            more(state: state, appearance: appearance)
                        }.readerNavigationAxis()
                    } else {
                        // A native row keeps the same six primary icons as the web phone bar. Separate
                        // ToolbarItems otherwise move You and our More menu into a second system More.
                        ToolbarItem(placement: .bottomBar) {
                            ViewThatFits(in: .horizontal) {
                                phoneRow(state: state, appearance: appearance, includesMore: true)
                                // On the smallest phones secondary routes remain in the web Profile menu.
                                phoneRow(state: state, appearance: appearance, includesMore: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .toolbarBackground(Color(uiColor: ReaderNavigationAppearance.color(model.navigation?.appearance?.background ?? "#0b0b0f")), for: .navigationBar, .bottomBar)
    }

    private func destination(_ item: ReaderNavigationItem, state: ReaderNavigationPresentation, appearance: ReaderNavigationAppearance) -> some View {
        let selected = state.selected.rawValue == item.id.rawValue
        return Button { model.navigationBridge?.request(item.id) } label: {
            Label { Text(item.label) } icon: { NavigationGlyph(appearance: appearance, id: item.id.rawValue, badge: item.badge) }
        }
        .labelStyle(.iconOnly)
        .tint(Color(uiColor: ReaderNavigationAppearance.color(selected ? appearance.accent : appearance.muted)))
        .foregroundStyle(Color(uiColor: ReaderNavigationAppearance.color(selected ? appearance.accent : appearance.muted)))
        .disabled(model.busy || state.blocked || !item.enabled)
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
            Label { Text(appearance.moreLabel) } icon: { NavigationGlyph(appearance: appearance, id: "more") }
        }
        .labelStyle(.iconOnly)
        .tint(Color(uiColor: ReaderNavigationAppearance.color(appearance.muted)))
        .foregroundStyle(Color(uiColor: ReaderNavigationAppearance.color(appearance.muted)))
        .disabled(model.busy || state.blocked)
        .accessibilityIdentifier("navigation-more")
    }

    private func phoneRow(state: ReaderNavigationPresentation, appearance: ReaderNavigationAppearance, includesMore: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(state.items) { item in
                destination(item, state: state, appearance: appearance)
                    .frame(width: 44, height: 44)
                    .background(state.selected.rawValue == item.id.rawValue ? Color(uiColor: ReaderNavigationAppearance.color(appearance.accent)).opacity(0.14) : .clear,
                                in: RoundedRectangle(cornerRadius: 12))
            }
            if includesMore { more(state: state, appearance: appearance).frame(width: 44, height: 44) }
        }.fixedSize()
    }
}

private extension ToolbarContent {
    @ToolbarContentBuilder
    func readerNavigationAxis() -> some ToolbarContent {
        if #available(iOS 27.1, *) { self.axisBehavior(.verticalPreferred) }
        else { self }
    }
}

private struct NavigationGlyph: View {
    let appearance: ReaderNavigationAppearance
    let id: String
    var badge: String? = nil
    var body: some View {
        if let image = appearance.image(id) {
            Image(uiImage: image).renderingMode(.template).resizable().scaledToFit().frame(width: 24, height: 24)
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
