import UIKit
import WebKit

enum ReaderDestination: String, CaseIterable, Codable {
    case home, library, search, discover, offline, profile

    var symbol: String {
        switch self {
        case .home: return "house"
        case .library: return "books.vertical"
        case .search: return "magnifyingglass"
        case .discover: return "safari"
        case .offline: return "arrow.down.circle"
        case .profile: return "person.crop.circle"
        }
    }
}

struct ReaderNavigationItem: Equatable, Codable {
    let id: ReaderDestination
    let label: String
    let enabled: Bool
    var badge: String? = nil
    var status: String? = nil
}

/// Containers own layout only. ReaderModel owns the single browsing session.
@MainActor
final class ReaderNavigationController: UIViewController, UITabBarControllerDelegate {
    let webView: WKWebView
    let tabs = UITabBarController()
    private let plain = UIViewController()
    private var hosts: [ReaderDestination: ReaderDestinationController] = [:]
    private var items: [ReaderNavigationItem] = []
    private weak var contentHost: UIViewController?
    private var mounted: UIViewController?
    private var applyingPresentation = false
    private(set) var selected: ReaderDestination = .home
    private(set) var showsNavigation = false
    var onSelect: ((ReaderDestination) -> Void)?

    init(webView: WKWebView) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
        tabs.delegate = self
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        mount(plain)
        attach(to: plain)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if showsNavigation, let host = hosts[selected] { attach(to: host) }
        else { attach(to: plain) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutContent()
    }

    func update(items: [ReaderNavigationItem], selected: ReaderDestination, visible: Bool) {
        loadViewIfNeeded()
        applyingPresentation = true
        defer { applyingPresentation = false }
        self.selected = selected
        if self.items.map(\.id) != items.map(\.id) {
            var next: [ReaderDestination: ReaderDestinationController] = [:]
            for item in items {
                let host = hosts[item.id] ?? ReaderDestinationController(destination: item.id)
                host.onAppear = { [weak self, weak host] in
                    guard let self, let host, self.showsNavigation else { return }
                    self.attach(to: host)
                    // UIKit's More list selects a child without asking the tab delegate.
                    if !self.applyingPresentation && self.selected != host.destination { self.request(host.destination) }
                }
                host.onLayout = { [weak self] in self?.layoutContent() }
                next[item.id] = host
            }
            hosts = next
            tabs.setViewControllers(items.compactMap { hosts[$0.id] }, animated: false)
            tabs.customizableViewControllers = []
        }
        self.items = items
        for item in items {
            guard let host = hosts[item.id] else { continue }
            host.title = item.label
            host.tabBarItem.title = item.label
            host.tabBarItem.image = UIImage(systemName: item.id.symbol)
            host.tabBarItem.isEnabled = item.enabled
            host.tabBarItem.badgeValue = item.badge
            host.tabBarItem.accessibilityLabel = item.label
            host.tabBarItem.accessibilityValue = item.status
            host.tabBarItem.accessibilityIdentifier = "destination-\(item.id.rawValue)"
        }
        showsNavigation = visible && hosts[selected] != nil
        if showsNavigation, let host = hosts[selected] {
            mount(tabs)
            let current = tabs.selectedViewController === tabs.moreNavigationController
                ? tabs.moreNavigationController.topViewController : tabs.selectedViewController
            if current !== host { tabs.selectedViewController = host }
            attach(to: host)
        } else {
            mount(plain)
            attach(to: plain)
        }
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        guard let host = viewController as? ReaderDestinationController else { return true }
        request(host.destination)
        // The router's committed state selects the destination, including redirects.
        return false
    }

    private func request(_ destination: ReaderDestination) {
        guard items.contains(where: { $0.id == destination && $0.enabled }) else {
            update(items: items, selected: selected, visible: showsNavigation)
            return
        }
        onSelect?(destination)
    }

    private func mount(_ controller: UIViewController) {
        guard mounted !== controller else { return }
        if let mounted {
            mounted.willMove(toParent: nil)
            mounted.view.removeFromSuperview()
            mounted.removeFromParent()
        }
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: view.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        controller.didMove(toParent: self)
        mounted = controller
    }

    private func attach(to host: UIViewController) {
        host.loadViewIfNeeded()
        // UIKit can announce the new selection before attaching its view (notably
        // during More transitions). Cross-view layout guides need a common ancestor.
        // viewDidAppear completes the attachment once the system has mounted it.
        if host !== plain && !host.view.isDescendant(of: tabs.view) { return }
        if webView.superview !== host.view {
            webView.removeFromSuperview()
            host.view.addSubview(webView)
        }
        contentHost = host
        layoutContent()
    }

    private func layoutContent() {
        guard let host = contentHost, webView.superview === host.view else { return }
        var frame = host.view.safeAreaLayoutGuide.layoutFrame
        if #available(iOS 26, *), showsNavigation, host.view.isDescendant(of: tabs.view) {
            // Resolve both guides in the child's coordinates. The tab guide excludes
            // the system bar/sidebar; the child's safe area also excludes More's
            // header and the surrounding SwiftUI toolbar. Direct layout avoids
            // cross-container constraints surviving UIKit's view reparenting.
            frame = frame.intersection(tabs.view.convert(tabs.contentLayoutGuide.layoutFrame, to: host.view))
        }
        webView.frame = frame.isNull ? .zero : frame
    }
}

@MainActor
private final class ReaderDestinationController: UIViewController {
    let destination: ReaderDestination
    var onAppear: (() -> Void)?
    var onLayout: (() -> Void)?
    init(destination: ReaderDestination) {
        self.destination = destination
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onAppear?()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onLayout?()
    }
}
