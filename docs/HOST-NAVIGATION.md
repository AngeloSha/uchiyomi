# Host navigation

The web app owns routes, authentication, offline access, translations and download status. A compatible host can display its navigation model and request fixed actions. The web app keeps its navigation until negotiation succeeds.

## Web abstraction

`web/lib/hostNavigation/model.ts` defines primary and secondary destinations and derives their presentation from current web state. `BottomNav` uses the same primary definitions. `controller.ts` accepts a `NavigationTransport` with two operations:

```ts
interface NavigationTransport {
  send(message: WebNavigationMessage): void;
  subscribe(receive: (message: unknown) => void): () => void;
}
```

The shared controller handles negotiation, revisions, action validation and cleanup. `useHostNavigation` connects it to AppShell's existing router and account state; components read negotiated ownership through `chrome.ts`. Platform detection is confined to adapter discovery in `ios.ts`.

An Android host could supply another adapter implementing this interface and render the same presentation. The in-memory adapter tests exercise the shared contract without WebKit or an iOS marker. No Android host or Android bridge is implemented or verified here.

## Navigation protocol 1

Navigation has its own version. The iOS adapter requires wrapper protocol 2; protocol-1 wrappers are unsupported. Navigation messages use their own version 1. Navigation does not alter manifest schema 1, offline schema 2, `readerReady`, native cache detection or public server URLs.

| Direction | Message | Purpose |
| --- | --- | --- |
| Web → host | `hello` | Request navigation ownership with session, revision and initial presentation. |
| Host → web | `ready` | Accept the supported version and matching session. |
| Web → host | `state` | Confirm negotiation and publish committed presentation changes. |
| Host → web | `action` | Request an allowed action with unique request ID and current revision. |
| Web → host | `result` | Report acceptance or rejection; selection still follows committed `state`. |
| Web → host | `stop` | Release the session when its controller is disposed. |
| Host → web | `reset` | Restore web chrome if the current document remains alive. |

Every message contains `version: 1` and `session`. Web messages also carry a positive, monotonically increasing `revision`. Action requests carry the revision they were made against. Unchanged publications are deduplicated; repeated request IDs are ignored within a bounded recent-request set. Missing acknowledgement after three seconds, unsupported versions and transport exceptions retain/restore web navigation. Disposal cancels its timer and subscription even if the transport has disconnected.

Primary actions are `home`, `library`, `search`, `discover`, `offline` and `profile`. Secondary actions are `lists`, `history`, `moments`, `updates`, `admin` and `quick-settings`. No arbitrary URL, script or native method name is accepted. Root re-taps do not add history; selecting a tab from a child route opens its root. Normal back/forward remains web history.

State contains `auth`, `immersive`, `selected`, primary `items` and `secondary` items. Labels come from the web locale. Items include enabled state; Library may include a bounded badge and accessibility status from the existing download poller. Discover and Admin follow current permissions. Offline disables network destinations, while Offline and Quick settings remain available; the latter preserves local sign-out. Anonymous/loading states expose no authenticated destinations. Reader routes hide the native primary bar.

## iOS adapter and boundary

The wrapper injects an optional `window.uchiyomiNative.navigation` capability at main-document start. It provides `version`, `documentID`, `send`, `subscribe` and `deliver`. The adapter wraps those functions; the rest of the web UI does not inspect WebKit globals.

`NativeNavigationBridge` accepts messages only from its current WKWebView, main frame and exact profile-local origin, including port. It validates payload size (16 KiB), known enums, UUID document/session identity, safe integer revisions, unique item IDs and bounded labels/badges. Before accepting `hello`, it reads the current document's injected identity to reject queued messages from retired documents. Reload, process replacement, server switching and cache generation replacement retire the previous session. Native-to-web calls use structured `callAsyncJavaScript` arguments.

This is a navigation interface for the selected server's trusted web UI, not an authentication boundary against that server. Navigation negotiation cannot confirm a cached UI generation; successful startup still uses the separate existing `readerReady` path.

## Native ownership and geometry

ReaderModel owns one WKWebView and website store. Horizontal layouts use a SwiftUI-hosted `UITabBarController` that moves that view among lightweight destination containers, with UIKit's More overflow. When iOS 27.1 or later supplies a `toolbarVerticalEdge`, the six primary actions and the reader menu share one native top-toolbar group; UIKit tabs are hidden and the same web view uses its plain content host. iOS chooses the edge, spacing and overflow. No device name, folding breakpoint or right-edge coordinate is hard-coded. Both surfaces request the same web actions and reflect committed route selection, labels, permissions and badges.

The vertical group starts at the top of the dock, below the system controls, and ends with a white `ellipsis` menu immediately after You. Spare space stays below the group. Its menu contents are shared with the horizontal layout's top toolbar. Primary actions disappear while reading/loading or when navigation negotiation is unavailable; Servers and Reload remain available. This avoids the large separation of top-menu and bottom-tab placements and the overlapping backgrounds observed when merely moving the separate menu down.

The representable reaches the horizontal display edges. In vertical mode with no native notice, it also avoids SwiftUI's empty top/bottom bar reserves; UIKit's child safe-area guide still protects web content beside the dock. Native notices retain their vertical inset, with zero extra inset spacing. Horizontal content also uses the tab content guide and More's header. Native navigation removes web TopNav, Sidebar and BottomNav only after negotiation. Shared sheets, dialogs, fixed actions and notice offsets consume the active chrome geometry.

## Compatibility and rollback

| Frontend | Host | Navigation |
| --- | --- | --- |
| Protocol-2 frontend without the navigation consumer | Navigation-capable iOS host | Existing web controls. |
| New frontend | Protocol-2 iOS host without navigation/browser/PWA | Existing web controls. |
| New frontend | Compatible iOS host | Native controls after negotiation. |
| New frontend | Unsupported or failed navigation handshake | Existing web controls. |

Deploy a frontend matched to the server's backend through the existing manifest flow. Within the protocol-2 contract, the navigation frontend and native release can be staged independently: activation needs both sides. Protocol-1 frontends and saved generations remain incompatible; navigation does not bypass that refusal. To roll back the experiment, restore a compatible frontend without navigation negotiation; the new host then leaves web navigation in place. Keep the installation identifier/signing account and profile data intact. The wrapper's existing verified-cache fallback remains available for failed UI updates; do not delete profiles or uninstall to roll back navigation.

## Physical acceptance for each candidate

Simulator evidence does not replace these checks:

1. Record the IPA checksum, version/build, effective installation ID and iOS version. Update the existing installation in place.
2. Open every primary/secondary destination, including More overflow; check folding, rotation, keyboard, larger text and VoiceOver. Confirm translated labels and download status remain understandable.
3. Open/close Servers and Quick settings; enter/leave a reader chapter. Confirm one usable navigation surface, readable headers and reachable sheet/footer/selection controls.
4. Retain a new unsynced offline position across the native update, force quit and offline reboot. Reconnect, confirm Home-first cold launch and progress sync. Sign out offline and confirm the previous account's reader is no longer accessible.

This port targets the protocol-2 wrapper merged in #427. Prior experimental releases and simulator/device results do not establish acceptance of this combined build. See [the port verification record](IOS-NAVIGATION-VERIFICATION.md) for current checks and remaining physical acceptance.
