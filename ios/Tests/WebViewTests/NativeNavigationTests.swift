import XCTest
import SwiftUI
import WebKit
@testable import Uchiyomi

@MainActor
final class NativeNavigationTests: XCTestCase {
    private func waitFor(file: StaticString = #filePath, line: UInt = #line, _ condition: () async throws -> Bool) async throws {
        for _ in 0..<300 {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTFail("Navigation condition did not settle", file: file, line: line)
        throw ClientError.invalid("Navigation condition did not settle")
    }

    func testReaderScreenServersNoticesAndReplacementPreserveNavigationOwnership() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let first = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        let second = try store.profile(for: URL(string: "https://127.0.0.1:10")!, in: .init(profiles: [first]))
        try store.save(.init(profiles: [first, second], selectedID: first.id))
        for profile in [first, second] {
            let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
            let ui = try await cache.prepare(client: NavigationPage()) { _, _ in }
            try await cache.confirm(ui)
        }
        let model = ReaderModel(root: root, assetClient: { _ in NavigationPage() }, serverProbe: { _ in .available })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UIHostingController(rootView: ReaderView(model: model))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; try? FileManager.default.removeItem(at: root) }
        do {
            await model.restore()
            try await waitFor { model.navigation?.auth == .authed }
            func findContainer(_ parent: UIViewController) -> ReaderNavigationController? {
                if let result = parent as? ReaderNavigationController { return result }
                return parent.children.lazy.compactMap(findContainer).first
            }
            let container = try XCTUnwrap(findContainer(window.rootViewController!))
            let vertical: Bool
            if #available(iOS 27.1, *) { vertical = window.traitCollection.verticalBarEdge != .unspecified }
            else { vertical = false }
            // Fresh simulators may omit accessibility IDs on rendered toolbar
            // views. Inspect public controls and verify their destinations by action.
            func nativeButtons() -> [UIControl] {
                func collect(_ view: UIView) -> [UIControl] {
                    guard !view.isHidden, view.alpha > 0, !(view is WKWebView) else { return [] }
                    if let button = view as? UIControl, !button.bounds.isEmpty { return [button] }
                    return view.subviews.flatMap(collect)
                }
                return collect(window).sorted {
                    $0.convert($0.bounds, to: window).midY < $1.convert($1.bounds, to: window).midY
                }
            }
            try await waitFor { vertical ? nativeButtons().count == 7 : container.showsNavigation }
            let web = try XCTUnwrap(model.webView)
            let store = web.configuration.websiteDataStore
            let token = try await web.evaluateJavaScript("uchiyomiNative.navigation.documentID") as? String
            let delegate = web.navigationDelegate
            if vertical {
                for (index, destination) in ReaderDestination.allCases.enumerated() {
                    let button = nativeButtons()[index]
                    let previous = try await web.evaluateJavaScript("fixture.actions.length") as? Int
                    let event: UIControl.Event = button.allControlEvents.contains(.primaryActionTriggered) ? .primaryActionTriggered : .touchUpInside
                    print("Navigation milestone: native action \(destination.rawValue)")
                    button.sendActions(for: event)
                    try await waitFor {
                        let count = (try? await web.evaluateJavaScript("fixture.actions.length")) as? Int
                        return count == (previous ?? 0) + 1 && model.navigation?.selected == destination
                    }
                    let action = try await web.evaluateJavaScript("fixture.actions.at(-1)") as? String
                    XCTAssertEqual(action, destination.rawValue, "Native destinations are out of order")
                    XCTAssertEqual(model.navigation?.selected, destination)
                }
            }
            model.navigationBridge?.request(.library)
            try await waitFor { model.navigation?.selected == .library && container.selected == .library }
            for size in [CGSize(width: 390, height: 844), CGSize(width: 844, height: 390), scene.coordinateSpace.bounds.size] {
                window.frame.size = size
                window.layoutIfNeeded()
                model.status = "Test notice"
                model.showingServers = true
                try await Task.sleep(nanoseconds: 350_000_000)
                model.showingServers = false
                try await Task.sleep(nanoseconds: 350_000_000)
                model.dismissStatus()
                try await waitFor {
                    window.layoutIfNeeded()
                    return web.bounds.width > 0 && web.bounds.height > 0
                }
                XCTAssertTrue(model.webView === web)
                XCTAssertTrue(web.configuration.websiteDataStore === store)
                XCTAssertTrue(web.navigationDelegate === delegate)
                let retained = try await web.evaluateJavaScript("uchiyomiNative.navigation.documentID") as? String
                XCTAssertEqual(retained, token, "Servers/resize reloaded the page")
                XCTAssertGreaterThan(web.bounds.width, 0)
                XCTAssertGreaterThan(web.bounds.height, 0)
            }
            _ = try await web.evaluateJavaScript("fixture.state.immersive=true; fixture.message.revision++; uchiyomiNative.navigation.send(fixture.message); true")
            try await waitFor { model.navigation?.immersive == true }
            try await waitFor { !container.showsNavigation }
            try await waitFor { nativeButtons().count == 1 }
            try await Task.sleep(nanoseconds: 350_000_000)
            let immersive = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            immersive.name = "Reader menu while immersive"; immersive.lifetime = .keepAlways; add(immersive)
            let topAnchor: CGFloat?
            if vertical {
                let menu = try XCTUnwrap(nativeButtons().first)
                topAnchor = menu.convert(menu.bounds, to: window).midY
                XCTAssertLessThan(try XCTUnwrap(topAnchor), window.bounds.midY, "Keep the menu at the top while reading")
            } else { topAnchor = nil }
            _ = try await web.evaluateJavaScript("fixture.state.immersive=false; fixture.message.revision++; uchiyomiNative.navigation.send(fixture.message); true")
            try await waitFor { model.navigation?.immersive == false }
            try await waitFor { vertical ? nativeButtons().count == 7 : container.showsNavigation }
            try await Task.sleep(nanoseconds: 350_000_000)
            XCTAssertTrue(web.window === window)
            let bar = container.tabs.tabBar.convert(container.tabs.tabBar.bounds, to: window)
            let content = web.convert(web.bounds, to: window)
            if vertical {
                XCTAssertFalse(container.showsNavigation, "Do not duplicate the vertical toolbar with native tabs")
                var first: CGRect?
                var previous: CGRect?
                let buttons = nativeButtons()
                XCTAssertEqual(buttons.count, 7, "Keep six destinations followed by the menu")
                for button in buttons {
                    let frame = button.convert(button.bounds, to: window)
                    if first == nil { first = frame }
                    XCTAssertFalse(content.insetBy(dx: 1, dy: 1).intersects(frame), "Native action overlaps web content")
                    if let previous {
                        XCTAssertEqual(frame.midX, previous.midX, accuracy: 1, "Keep all actions on the same vertical axis")
                        XCTAssertGreaterThan(frame.midY, previous.midY, "Menu must follow the primary destinations")
                        XCTAssertLessThanOrEqual(frame.midY - previous.midY, max(frame.height, previous.height) * 1.5,
                                                "Do not separate the menu from the primary group with a large gap")
                    }
                    previous = frame
                }
                // Compare against the menu-only top anchor: the system status
                // region is not part of the window's ordinary safe-area inset.
                XCTAssertEqual(try XCTUnwrap(first).midY, try XCTUnwrap(topAnchor), accuracy: 1,
                               "Grow the group downward from its top anchor when primary actions return")
                XCTAssertGreaterThanOrEqual(content.maxY, window.safeAreaLayoutGuide.layoutFrame.maxY - 1,
                                            "Do not reserve an empty horizontal bar below the web content")
            } else {
                XCTAssertGreaterThan(bar.width, bar.height, "Keep ordinary horizontal tabs when no vertical bar is available")
                XCTAssertFalse(content.insetBy(dx: 1, dy: 1).intersects(bar), "Native tabs overlap web content")
            }
            let screenshot = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            screenshot.name = "Reader screen with native navigation"; screenshot.lifetime = .keepAlways; add(screenshot)

            let retiredBridge = try XCTUnwrap(model.navigationBridge)
            await model.choose(second)
            try await waitFor { model.navigation?.auth == .authed }
            XCTAssertFalse(model.webView === web)
            XCTAssertFalse(model.webView?.configuration.websiteDataStore === store)
            XCTAssertNil(retiredBridge.presentation)
            _ = try await web.evaluateJavaScript("fixture.state.selected='search'; fixture.message.revision++; uchiyomiNative.navigation.send(fixture.message); true")
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(model.navigation?.selected, .home, "The previous server altered current navigation")
            await model.addServer()
        } catch {
            let screenshot = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            screenshot.name = "Reader navigation failure"; screenshot.lifetime = .keepAlways; add(screenshot)
            await model.addServer(); throw error
        }
    }

    func testRealFrontendNegotiatesOfflineReadingAndLegacyFallback() async throws {
        let directory = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: directory.appendingPathComponent("mobile-assets.json")))
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let client = try RemoteClient(origin: profile.origin, vault: NavigationEmptyVault())
        let gateway = Gateway(profile: profile, ui: PreparedUI(directory: directory, manifest: manifest), client: client)
        try await gateway.start()
        var container: ReaderNavigationController?
        let bridge = NativeNavigationBridge(origin: profile.localOrigin) { state in
            container?.update(items: state?.items ?? [], selected: state?.selected ?? .home, visible: state?.showsTabs == true)
        }
        let web = try await NativeWebView.make(profile: profile, policy: gateway.policy, navigation: bridge)
        container = ReaderNavigationController(webView: web)
        container?.onSelect = { bridge.request(ReaderNavigationAction(rawValue: $0.rawValue)!) }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UIHostingController(rootView: ContainerFixture(controller: container!))
        window.makeKeyAndVisible()
        defer { bridge.retire(); web.stopLoading(); web.removeFromSuperview(); window.isHidden = true; window.rootViewController = nil; container = nil; client.cancel() }
        do {
            web.load(URLRequest(url: profile.localOrigin))
            try await waitFor { bridge.presentation?.auth == .anon }
            XCTAssertFalse(container!.showsNavigation)
            _ = try await web.callAsyncJavaScript(CachedWebViewTests.seed, arguments: [:], in: nil, contentWorld: .page)
            bridge.reset(); web.reload()
            try await waitFor { bridge.presentation?.auth == .offline && bridge.presentation?.selected == .offline }
            XCTAssertTrue(container!.showsNavigation)
            XCTAssertEqual(bridge.presentation?.items.filter(\.enabled).map(\.id), [.offline])
            for host in container!.tabs.viewControllers ?? [] {
                XCTAssertEqual(host.tabBarItem.isEnabled, host.tabBarItem.accessibilityIdentifier == "destination-offline", "Native tab availability must match offline state")
            }
            let ownsChrome = try await web.evaluateJavaScript("document.documentElement.hasAttribute('data-host-navigation') && !document.querySelector('nav.fixed.bottom-0')") as? Bool
            XCTAssertEqual(ownsChrome, true)
            let offlineURL = web.url
            bridge.request(.home)
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(web.url, offlineURL)
            try await waitFor { (try? await web.evaluateJavaScript("document.querySelector('a[href*=\"/reader/\"]') !== null")) as? Bool == true }
            _ = try await web.evaluateJavaScript("document.querySelector('a[href*=\"/reader/\"]').click()")
            try await waitFor { bridge.presentation?.immersive == true }
            XCTAssertFalse(container!.showsNavigation)
            try await waitFor { (try? await web.evaluateJavaScript("Array.from(document.images).some(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)")) as? Bool == true }
            web.goBack()
            try await waitFor { bridge.presentation?.selected == .offline && bridge.presentation?.immersive == false }
            XCTAssertTrue(container!.showsNavigation)
            try await waitFor { (try? await web.evaluateJavaScript("document.body.innerText.includes('Offline fixture')")) as? Bool == true }
            try await Task.sleep(nanoseconds: 350_000_000)
            let screenshot = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            screenshot.name = "Native navigation with offline downloads"; screenshot.lifetime = .keepAlways; add(screenshot)

            // A legacy wrapper with the new frontend retains ordinary web navigation.
            bridge.reset()
            // Remove navigation support for the next load through a separate legacy configuration.
            let legacy = try await NativeWebView.make(profile: profile, policy: gateway.policy)
            let legacyContainer = ReaderNavigationController(webView: legacy)
            window.rootViewController = UIHostingController(rootView: ContainerFixture(controller: legacyContainer))
            legacy.load(URLRequest(url: profile.localOrigin))
            try await waitFor { (try? await legacy.evaluateJavaScript("!!document.querySelector('nav.fixed.bottom-0') && !document.documentElement.hasAttribute('data-host-navigation')")) as? Bool == true }
            XCTAssertFalse(legacyContainer.showsNavigation)
            legacy.stopLoading(); legacy.removeFromSuperview()
            await gateway.stop()
        } catch {
            let body = try? await web.evaluateJavaScript("document.body.innerText")
            XCTFail("Native frontend integration failed: \(error); page: \(String(describing: body))")
            await gateway.stop()
            throw error
        }
    }

    func testOneDocumentAcrossTabsOverflowReaderAndResize() async throws {
        let web = WKWebView()
        let observer = NavigationObserver()
        web.navigationDelegate = observer
        web.uiDelegate = observer
        let store = web.configuration.websiteDataStore
        let controller = ReaderNavigationController(webView: web)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UIHostingController(rootView: ContainerFixture(controller: controller))
        window.makeKeyAndVisible()
        defer { web.stopLoading(); web.removeFromSuperview(); window.isHidden = true; window.rootViewController = nil }
        let items = ReaderDestination.allCases.map { ReaderNavigationItem(id: $0, label: $0.rawValue, enabled: true) }
        controller.onSelect = { [weak controller] in controller?.update(items: items, selected: $0, visible: true) }
        controller.update(items: items, selected: .home, visible: true)
        web.loadHTMLString("<html><body><input value='retained'><script>window.pageToken = crypto.randomUUID()</script></body></html>", baseURL: URL(string: "https://localhost"))
        try await waitFor { observer.loads > 0 }
        XCTAssertEqual(observer.loads, 1)
        print("Navigation milestone: initial document loaded")
        let tokenValue = try await web.evaluateJavaScript("window.pageToken") as? String
        let token = try XCTUnwrap(tokenValue)

        for destination in ReaderDestination.allCases {
            print("Navigation milestone: selecting \(destination)")
            controller.update(items: items, selected: destination, visible: true)
            try await waitFor {
                window.layoutIfNeeded()
                let host = controller.tabs.selectedViewController === controller.tabs.moreNavigationController
                    ? controller.tabs.moreNavigationController.topViewController : controller.tabs.selectedViewController
                return host.map { web.isDescendant(of: $0.view) } == true
                    && web.bounds.width > 0 && web.bounds.height > 0
            }
            window.layoutIfNeeded()
            XCTAssertTrue(web.isDescendant(of: controller.tabs.view))
            XCTAssertGreaterThan(web.bounds.width, 0)
            XCTAssertGreaterThan(web.bounds.height, 0)
            XCTAssertEqual(controller.selected, destination)
        }

        // Exercise UIKit's real More table when this layout provides overflow.
        let more = controller.tabs.moreNavigationController
        if controller.tabs.tabBar.items?.contains(more.tabBarItem) == true {
            print("Navigation milestone: More list")
            controller.tabs.selectedViewController = more
            more.popToRootViewController(animated: false)
            try await Task.sleep(nanoseconds: 100_000_000)
            func table(in view: UIView) -> UITableView? {
                if let table = view as? UITableView { return table }
                return view.subviews.lazy.compactMap { table(in: $0) }.first
            }
            let list = try XCTUnwrap(table(in: more.view))
            XCTAssertGreaterThanOrEqual(list.numberOfRows(inSection: 0), 2)
            for row in 0..<list.numberOfRows(inSection: 0) {
                print("Navigation milestone: More row \(row)")
                let index = IndexPath(row: row, section: 0)
                list.selectRow(at: index, animated: false, scrollPosition: .none)
                list.delegate?.tableView?(list, didSelectRowAt: index)
                for _ in 0..<100 {
                    if web.isDescendant(of: more.view) { break }
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
                XCTAssertTrue(web.isDescendant(of: more.view))
                XCTAssertEqual(controller.selected, row == 0 ? .offline : .profile)
                window.layoutIfNeeded()
                let frame = web.convert(web.bounds, to: more.view)
                let bar = more.navigationBar.convert(more.navigationBar.bounds, to: more.view)
                XCTAssertGreaterThanOrEqual(frame.minY + 1, bar.maxY, "More's header overlaps web content")
                more.popToRootViewController(animated: false)
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }

        for size in [CGSize(width: 390, height: 844), CGSize(width: 844, height: 390), scene.coordinateSpace.bounds.size] {
            print("Navigation milestone: resize \(size)")
            controller.update(items: items, selected: .offline, visible: false)
            window.frame.size = size
            window.layoutIfNeeded()
            XCTAssertFalse(web.isDescendant(of: controller.tabs.view))
            controller.update(items: items, selected: .library, visible: true)
            window.layoutIfNeeded()
            XCTAssertTrue(web.isDescendant(of: controller.tabs.view))
            let frame = web.convert(web.bounds, to: window)
            XCTAssertGreaterThanOrEqual(frame.minX, -1)
            XCTAssertGreaterThanOrEqual(frame.minY, -1)
            XCTAssertLessThanOrEqual(frame.maxX, window.bounds.width + 1)
            XCTAssertLessThanOrEqual(frame.maxY, window.bounds.height + 1)
        }
        XCTAssertTrue(web.configuration.websiteDataStore === store)
        XCTAssertTrue(web.navigationDelegate === observer)
        XCTAssertTrue(web.uiDelegate === observer)
        XCTAssertEqual(observer.loads, 1)
        let retained = try await web.evaluateJavaScript("window.pageToken") as? String
        XCTAssertEqual(retained, token)
        let value = try await web.evaluateJavaScript("document.querySelector('input').value") as? String
        XCTAssertEqual(value, "retained")
        var translated = items.filter { $0.id != .discover }
        let library = try XCTUnwrap(translated.firstIndex { $0.id == .library })
        translated[library] = ReaderNavigationItem(id: .library, label: "Bibliothèque", enabled: true, badge: "23", status: "23 téléchargements")
        controller.update(items: translated, selected: .library, visible: true)
        let tab = try XCTUnwrap(controller.tabs.viewControllers?.first { $0.tabBarItem.accessibilityIdentifier == "destination-library" }?.tabBarItem)
        XCTAssertEqual(tab.title, "Bibliothèque")
        XCTAssertEqual(tab.badgeValue, "23")
        XCTAssertEqual(tab.accessibilityValue, "23 téléchargements")
        XCTAssertEqual(controller.tabs.viewControllers?.count, 5)
        controller.update(items: [], selected: .home, visible: false)
        XCTAssertFalse(controller.showsNavigation)
        XCTAssertEqual(controller.tabs.viewControllers?.count, 0)
    }
}

private struct ContainerFixture: UIViewControllerRepresentable {
    let controller: ReaderNavigationController
    func makeUIViewController(context: Context) -> ReaderNavigationController { controller }
    func updateUIViewController(_ controller: ReaderNavigationController, context: Context) {}
}

@MainActor
private final class NavigationObserver: NSObject, WKNavigationDelegate, WKUIDelegate {
    var loads = 0
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loads += 1 }
}

private struct NavigationEmptyVault: CookieVault {
    func read() -> Data? { nil }
    func write(_ data: Data) {}
}
