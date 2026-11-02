import XCTest
import WebKit
import SwiftUI
@testable import Uchiyomi

private struct EmptyVault: CookieVault {
    func read() -> Data? { nil }
    func write(_ data: Data) {}
}

// Uses the real exported frontend in a test bundle. These files are never part of Uchiyomi.app.
@MainActor
final class CachedWebViewTests: XCTestCase {
    func testPreparedReaderWithUnavailableServer() async throws {
        let directory = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: directory.appendingPathComponent("mobile-assets.json")))
        try manifest.validate()
        let profile = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: UInt16.random(in: 49152...60999))
        let client = try RemoteClient(origin: profile.origin, vault: EmptyVault())
        let gateway = Gateway(profile: profile, ui: PreparedUI(directory: directory, manifest: manifest), client: client)
        try await gateway.start()
        let host = UIViewController()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        var web: WKWebView? = try await NativeWebView.make(profile: profile, policy: gateway.policy)
        func mount(_ view: WKWebView) { view.frame = host.view.bounds; host.view.addSubview(view) }
        mount(web!)
        defer {
            web?.stopLoading(); web?.removeFromSuperview(); web = nil
            window.isHidden = true; client.cancel()
        }
        do {
            // A non-reader page establishes the real local origin before fixture data is seeded.
            web!.load(URLRequest(url: profile.localOrigin.appendingPathComponent("downloads/")))
            try await waitFor(web!, "document.readyState === 'complete' && !!window.uchiyomiNative")
            try await waitFor(web!, "!!document.querySelector('input[type=password]')")
            let cookieVisible = try await web!.evaluateJavaScript("document.cookie.includes('uchiyomi_gateway')") as? Bool
            XCTAssertEqual(cookieVisible, false, "The local capability must remain HttpOnly")
            _ = try await web!.callAsyncJavaScript(Self.seed, arguments: [:], in: nil, contentWorld: .page)
            // Establish the prepared account before simulating a relaunch. DOM readiness alone
            // can precede React's initial anonymous auth result on a fresh hosted simulator.
            // No reader route has been opened; both chapters must still render after recreation.
            web!.reload()
            try await waitFor(web!, "document.body.innerText.includes('Offline fixture')")
            let fixtureDirectory = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "WebViewFixtures", withExtension: nil))
            _ = try await web!.evaluateJavaScript(String(contentsOf: fixtureDirectory.appendingPathComponent("downloads.js"), encoding: .utf8))
            let downloadFailure = try await web!.callAsyncJavaScript("""
                const dl=window.uchiyomiDownloadFixture;dl.setCurrentUser('ios-fixture');
                const originalFetch=window.fetch;let fail=true;
                window.fetch=async url=>{
                  const path=String(url);
                  if(path.includes('/download-manifest'))return new Response(JSON.stringify({seriesId:'failure-series',seriesTitle:'Failure fixture',title:'Failure chapter',number:'1',pageCount:2,totalBytes:20,pages:[1,2].map(number=>({number,url:'/fixture-page/'+number,width:8,height:12}))}),{headers:{'Content-Type':'application/json'}});
                  if(path.includes('/fixture-page/')){if(fail&&path.endsWith('/2'))throw new TypeError('Injected interrupted transfer');return new Response(new Blob(['fixture page'],{type:'image/png'}))}
                  return new Response('{}',{headers:{'Content-Type':'application/json'}});
                };
                try {
                  let rejected=false;try{await dl.downloadChapter('failed-fixture')}catch{rejected=true}
                  const clean=rejected&&!await dl.getOfflineChapter('failed-fixture')&&!await dl.getPageBlob('failed-fixture',1)&&!!await dl.getOfflineChapter('fixture-1');
                  fail=false;await dl.downloadChapter('failed-fixture');
                  const retry=!!await dl.getOfflineChapter('failed-fixture')&&!!await dl.getPageBlob('failed-fixture',1)&&!!await dl.getPageBlob('failed-fixture',2);
                  await dl.deleteDownload('failed-fixture');return clean&&retry;
                } finally {window.fetch=originalFetch}
                """, arguments: [:], in: nil, contentWorld: .page) as? Bool
            XCTAssertEqual(downloadFailure, true, "Interrupted download left a partial chapter, damaged a completed one, or could not retry")
            // Tear down the web view and listener, then recreate both at the exact saved origin/store.
            web!.stopLoading(); web!.removeFromSuperview(); web = nil
            await gateway.stop()
            try await gateway.start()
            web = try await NativeWebView.make(profile: profile, policy: gateway.policy)
            mount(web!)
            // Cold launches enter through Home. The real frontend must reach downloads
            // itself when the upstream is unavailable and the saved identity is valid.
            web!.load(URLRequest(url: profile.localOrigin))
            try await waitFor(web!, "location.pathname === '/downloads/' && document.body.innerText.includes('Offline fixture')")
            let registrations = try await web!.callAsyncJavaScript("return (await navigator.serviceWorker.getRegistrations()).length", arguments: [:], in: nil, contentWorld: .page) as? Int
            XCTAssertEqual(registrations, 0, "The native host registered a service worker")
            // Both reader routes/chunks have never been visited. The upstream port refuses connections.
            for book in ["fixture-1", "fixture-2"] {
                web!.load(URLRequest(url: URL(string: profile.localOrigin.absoluteString + "/reader/?book=" + book)!))
                try await waitFor(web!, "location.pathname === '/reader/' && new URL(location.href).searchParams.get('book') === '\(book)' && !document.body.innerText.includes('Loading chapter') && Array.from(document.images).some(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)")
                let problem = try await web!.evaluateJavaScript("document.body.innerText.includes('Loading chapter')") as? Bool
                XCTAssertEqual(problem, false)
            }
            let attachment = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            attachment.name = "Cached reader with unavailable server"
            attachment.lifetime = .keepAlways
            add(attachment)
            await gateway.stop()
        } catch {
            let text = try? await web?.evaluateJavaScript("document.body.innerText")
            let identity = try? await web?.evaluateJavaScript("localStorage.getItem('uchiyomi.offlineUser')")
            XCTFail("Web view did not reach the offline reader: \(error). Fixture identity: \(String(describing: identity)). Page: \(String(describing: text))")
            await gateway.stop()
            throw error
        }
    }

    func testAutomaticUIUpdateAndFailedStartupRecoveryPreserveOfflineData() async throws {
        let export = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let profile = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        try store.save(.init(profiles: [profile], selectedID: profile.id))
        let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
        let firstRemote = try ExportFixture(directory: export, revision: "first")
        let first = try await cache.prepare(client: firstRemote) { _, _ in }
        try await cache.confirm(first)
        var remote = firstRemote
        let model = ReaderModel(root: root, startupTimeout: 3_000_000_000, assetClient: { _ in remote })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UIHostingController(rootView: ReaderView(model: model))
        window.makeKeyAndVisible()
        func waitForReader() async throws -> WKWebView {
            let web = try XCTUnwrap(model.webView)
            try await waitFor(web, "document.body.innerText.includes('Offline fixture')")
            return web
        }
        defer { window.isHidden = true; window.rootViewController = nil; try? FileManager.default.removeItem(at: root) }
        do {
            await model.restore()
            var firstWeb: WKWebView? = try XCTUnwrap(model.webView)
            try await waitFor(firstWeb!, "!!document.querySelector('input[type=password]')")
            _ = try await firstWeb!.callAsyncJavaScript(Self.seed, arguments: [:], in: nil, contentWorld: .page)
            firstWeb!.reload()
            _ = try await waitForReader()
            _ = try await firstWeb!.callAsyncJavaScript("""
                const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                const tx=db.transaction('outbox','readwrite');
                tx.objectStore('outbox').put({id:999,userId:'ios-fixture',bookId:'fixture-2',seriesId:'fixture-series',deviceId:'ios-test',page:2,completed:false,ts:1700000000000,tries:0});
                await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return true;
                """, arguments: [:], in: nil, contentWorld: .page)
            let second = try ExportFixture(directory: export, revision: "second")
            second.assetDelay = 5_000_000
            remote = second
            firstWeb!.load(URLRequest(url: URL(string: "/reader/?book=fixture-2", relativeTo: profile.localOrigin)!.absoluteURL))
            try await waitFor(firstWeb!, "location.pathname === '/reader/' && Array.from(document.images).some(i=>i.src.startsWith('blob:') && i.complete && i.naturalWidth>0)")
            _ = try await firstWeb!.evaluateJavaScript("window.updateReadingMarker = 42; true")
            await model.resume()
            XCTAssertEqual(second.manifestReads, 0, "Foregrounding unexpectedly checked for updates")
            XCTAssertTrue(model.webView === firstWeb)
            let marker = try await firstWeb!.evaluateJavaScript("window.updateReadingMarker") as? Int
            XCTAssertEqual(marker, 42, "A host update replaced the active reading document")
            // The test must release the retired reader just as the real UI does.
            // stopLoading() alone leaves its document and JavaScript alive.
            weak var retiredInitialReader = firstWeb
            firstWeb = nil
            let selecting = Task { await model.choose(profile) }
            for _ in 0..<200 {
                if (model.downloadProgress ?? 0) > 0 { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertTrue(model.busy)
            XCTAssertNotNil(model.downloadProgress)
            XCTAssertNil(model.webView, "A partially downloaded UI became visible")
            let loading = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            loading.name = "Automatic update loading page"; loading.lifetime = .keepAlways; add(loading)
            await selecting.value
            XCTAssertNil(retiredInitialReader, "The fixture retained the old reader across a UI update")
            _ = try await waitForReader()
            for _ in 0..<100 {
                if try await cache.needsConfirmation() == false { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            let loaded = try await cache.load()
            let updated = try XCTUnwrap(loaded)
            XCTAssertNotEqual(updated.manifest.buildId, first.manifest.buildId)
            XCTAssertGreaterThan(second.assetReads, 0)
            let reads = second.assetReads
            await model.choose(profile)
            _ = try await waitForReader()
            XCTAssertEqual(second.assetReads, reads, "Unchanged server version downloaded assets again")
            for failure in [ExportFixture.Failure.interrupted, .corrupt, .unsupportedSchema] {
                remote = try ExportFixture(directory: export, revision: "rejected-\(failure)", failure: failure)
                await model.choose(profile)
                XCTAssertNil(model.error, "A failed update hid the saved reader")
                XCTAssertNotNil(model.status)
                let retainedUI = try await cache.load()
                XCTAssertEqual(retainedUI?.manifest.buildId, updated.manifest.buildId)
                if failure == .unsupportedSchema { XCTAssertEqual(remote.assetReads, 0) }
                let retainedWeb = try await waitForReader()
                let retainedData = try await retainedWeb.callAsyncJavaScript("""
                    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const get=(store,key)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const queued=await get('outbox',999),page=await get('pages','ios-fixture:fixture-2:2');db.close();
                    return queued?.page===2 && queued?.userId==='ios-fixture' && queued?.ts===1700000000000 && page?.size>0 && JSON.parse(localStorage.getItem('uchiyomi.offlineUser')).id==='ios-fixture';
                    """, arguments: [:], in: nil, contentWorld: .page) as? Bool
                XCTAssertEqual(retainedData, true, "Rejected \(failure) update changed chapters, identity or queued progress")
            }
            remote = try ExportFixture(directory: export, revision: "broken", broken: true)
            await model.choose(profile)
            // The running model must recover itself after the bootstrap fails, without a manual action.
            for _ in 0..<200 {
                if model.status?.contains("previous version") == true { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            XCTAssertNil(model.error)
            XCTAssertTrue(model.status?.contains("previous version") == true)
            let recovered = try await cache.load()
            XCTAssertEqual(recovered?.directory, updated.directory)
            _ = try await waitForReader()
            let brokenReads = remote.assetReads
            await model.choose(profile)
            XCTAssertEqual(remote.assetReads, brokenReads, "Repeated startup reinstalled the rejected build")
            let web = try await waitForReader()
            for book in ["fixture-1", "fixture-2"] {
                web.load(URLRequest(url: URL(string: profile.localOrigin.absoluteString + "/reader/?book=" + book)!))
                try await waitFor(web, "new URL(location.href).searchParams.get('book') === '\(book)' && !document.body.innerText.includes('Loading chapter') && Array.from(document.images).some(i=>i.src.startsWith('blob:') && i.complete && i.naturalWidth>0)")
            }
            let retained = try await web.callAsyncJavaScript("""
                const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                const value=await new Promise((resolve,reject)=>{const r=db.transaction('outbox').objectStore('outbox').get(999);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                db.close();return value?.userId==='ios-fixture' && value?.page===2 && value?.ts===1700000000000 && JSON.parse(localStorage.getItem('uchiyomi.offlineUser')).id==='ios-fixture';
                """, arguments: [:], in: nil, contentWorld: .page) as? Bool
            XCTAssertEqual(retained, true, "Automatic recovery changed account identity or queued progress")
            let attachment = XCTAttachment(image: window.screen.screenshotForTest(window: window))
            attachment.name = "Reader after automatic update recovery"; attachment.lifetime = .keepAlways; add(attachment)
            await model.addServer()
        } catch { await model.addServer(); throw error }
    }

    func testExpiredIdentityAccountBoundaryAndOfflineLogout() async throws {
        let export = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ProfileStore(root: root)
        let profile = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
        try store.save(.init(profiles: [profile], selectedID: profile.id))
        let remote = try ExportFixture(directory: export, revision: "auth-boundary")
        let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
        let ui = try await cache.prepare(client: remote) { _, _ in }; try await cache.confirm(ui)
        let model = ReaderModel(root: root, assetClient: { _ in remote })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        // Auth assertions exercise the real frontend and model in a plain UIKit host.
        // Mount each WKWebView explicitly across identity changes. Native SwiftUI
        // presentation is covered separately by the automatic-update/UI checks.
        let host = UIViewController()
        window.rootViewController = host; window.makeKeyAndVisible()
        func mountReader() throws -> WKWebView {
            host.view.subviews.forEach { $0.removeFromSuperview() }
            let web = try XCTUnwrap(model.webView)
            web.frame = host.view.bounds; host.view.addSubview(web)
            return web
        }
        defer { window.isHidden = true; window.rootViewController = nil; try? FileManager.default.removeItem(at: root) }
        // Recreate the reader at each identity boundary, matching cold launch and avoiding
        // mutations racing a previous document's React navigation.
        var stage = "initial sign-in page"; NSLog("Auth fixture: %@", stage)
        do {
            await model.restore()
            var web = try mountReader()
            try await waitFor(web, "!!document.querySelector('input[type=password]')")
            _ = try await web.callAsyncJavaScript(Self.seed, arguments: [:], in: nil, contentWorld: .page)
            stage = "valid offline identity"; NSLog("Auth fixture: %@", stage)
            await model.choose(profile); web = try mountReader()
            try await waitFor(web, "document.body.innerText.includes('Offline fixture')")
            _ = try await web.evaluateJavaScript("const u=JSON.parse(localStorage.getItem('uchiyomi.offlineUser'));u.exp=Date.now()-1;localStorage.setItem('uchiyomi.offlineUser',JSON.stringify(u));true")
            stage = "expired offline identity"; NSLog("Auth fixture: %@", stage)
            await model.choose(profile); web = try mountReader()
            try await waitFor(web, "!!document.querySelector('input[type=password]') && localStorage.getItem('uchiyomi.offlineUser') === null")
            stage = "different account"; NSLog("Auth fixture: %@", stage)
            // A different saved account must not see the first account's identically named chapter.
            _ = try await web.evaluateJavaScript("localStorage.setItem('uchiyomi.offlineUser',JSON.stringify({v:1,id:'other-fixture',username:'other',displayName:'Other Tester',role:'admin',exp:Date.now()+86400000}));true")
            await model.choose(profile); web = try mountReader()
            try await waitFor(web, "document.body.innerText.includes('No downloads')")
            let leaked = try await web.evaluateJavaScript("document.body.innerText.includes('Offline fixture')") as? Bool
            XCTAssertEqual(leaked, false)
            _ = try await web.callAsyncJavaScript(Self.seed, arguments: [:], in: nil, contentWorld: .page)
            stage = "sign-out control"; NSLog("Auth fixture: %@", stage)
            await model.choose(profile); web = try mountReader()
            try await waitFor(web, "document.body.innerText.includes('Offline fixture')")
            _ = try await web.evaluateJavaScript("document.querySelector('button[aria-label=You]').click();true")
            try await waitFor(web, "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Sign out')")
            stage = "sign-out and relaunch"; NSLog("Auth fixture: %@", stage)
            _ = try await web.evaluateJavaScript("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Sign out').click();true")
            try await waitFor(web, "localStorage.getItem('uchiyomi.offlineUser') === null && !!document.querySelector('input[type=password]')")
            await model.choose(profile); web = try mountReader()
            try await waitFor(web, "!!document.querySelector('input[type=password]') && localStorage.getItem('uchiyomi.offlineUser') === null")
            await model.addServer()
        } catch {
            NSLog("Auth fixture failed at %@: %@", stage, String(describing: error))
            let text = try? await model.webView?.evaluateJavaScript("document.body.innerText")
            await model.addServer()
            throw ClientError.invalid("\(stage): \(error). Page: \(String(describing: text))")
        }
    }

    func testTwoServerProfilesWithSameAccountAndChapterIDsAndConfirmedRemoval() async throws {
        let export = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: export.appendingPathComponent("mobile-assets.json")))
        let basePort = UInt16.random(in: 49152...59998)
        let a = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:9")!, port: basePort)
        let b = ServerProfile(id: UUID(), origin: URL(string: "https://127.0.0.1:10")!, port: basePort + 1)
        let host = UIViewController()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds; window.rootViewController = host; window.makeKeyAndVisible()
        var web: WKWebView?
        var gateway: Gateway?
        var client: RemoteClient?
        func close() async {
            weak var retired = web
            web?.stopLoading(); web?.removeFromSuperview(); web = nil
            client?.cancel(); client = nil
            await gateway?.stop(); gateway = nil
            for _ in 0..<50 {
                if retired == nil { break }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertNil(retired, "The old profile's WebKit view was not released before store removal")
        }
        func open(_ profile: ServerProfile) async throws {
            await close()
            let remote = try RemoteClient(origin: profile.origin, vault: EmptyVault()); client = remote
            let local = Gateway(profile: profile, ui: PreparedUI(directory: export, manifest: manifest), client: remote)
            try await local.start(); gateway = local
            let view = try await NativeWebView.make(profile: profile, policy: local.policy)
            web = view; view.frame = host.view.bounds; host.view.addSubview(view)
            view.load(URLRequest(url: profile.localOrigin.appendingPathComponent("downloads/")))
            try await waitFor(view, "document.readyState === 'complete' && !!window.uchiyomiNative")
        }
        let queueScript = """
            const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
            const tx=db.transaction('outbox','readwrite');tx.objectStore('outbox').put({id:999,userId:'ios-fixture',bookId:'fixture-2',page,ts:1700000000000,deviceId:'ios-test',tries:0});
            await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return true;
            """
        let inspectScript = """
            const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
            const get=(store,key)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
            const chapter=await get('chapters','ios-fixture:fixture-2');const queued=await get('outbox',999);db.close();return {title:chapter?.seriesTitle,page:queued?.page};
            """
        var stage = "seed and switch profiles"
        do {
            try await open(a)
            _ = try await web!.callAsyncJavaScript(Self.seed.replacingOccurrences(of: "Offline fixture", with: "Server A"), arguments: [:], in: nil, contentWorld: .page)
            _ = try await web!.callAsyncJavaScript(queueScript, arguments: ["page": 11], in: nil, contentWorld: .page)
            try await open(b)
            let empty = try await web!.evaluateJavaScript("localStorage.getItem('uchiyomi.offlineUser') === null") as? Bool
            XCTAssertEqual(empty, true, "A new profile inherited another server's identity")
            _ = try await web!.callAsyncJavaScript(Self.seed.replacingOccurrences(of: "Offline fixture", with: "Server B"), arguments: [:], in: nil, contentWorld: .page)
            _ = try await web!.callAsyncJavaScript(queueScript, arguments: ["page": 22], in: nil, contentWorld: .page)
            for (profile, title, page) in [(a, "Server A", 11), (b, "Server B", 22)] {
                try await open(profile)
                let data = try await web!.callAsyncJavaScript(inspectScript, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
                XCTAssertEqual(data?["title"] as? String, title)
                XCTAssertEqual(data?["page"] as? Int, page)
            }
            await close()
            stage = "remove A"; NSLog("Profile test: %@", stage)
            try await NativeWebView.removeStore(for: a.id)
            stage = "reopen removed A"; NSLog("Profile test: %@", stage)
            try await open(a)
            let removed = try await web!.evaluateJavaScript("localStorage.getItem('uchiyomi.offlineUser') === null") as? Bool
            XCTAssertEqual(removed, true)
            stage = "verify surviving B"; NSLog("Profile test: %@", stage)
            try await open(b)
            let surviving = try await web!.callAsyncJavaScript(inspectScript, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
            XCTAssertEqual(surviving?["title"] as? String, "Server B")
            XCTAssertEqual(surviving?["page"] as? Int, 22)
            await close()
            stage = "cleanup A"; NSLog("Profile test: %@", stage)
            try await NativeWebView.removeStore(for: a.id)
            stage = "cleanup B"; NSLog("Profile test: %@", stage)
            try await NativeWebView.removeStore(for: b.id)
            window.isHidden = true
        } catch { await close(); window.isHidden = true; throw ClientError.invalid("\(stage): \(error)") }
    }

    // Opt-in, disposable simulator workflow: prepare, install an older simulator app,
    // then update in place and verify. Normal CI never modifies the app's default catalog.
    func testNativeUpgradeRetentionFixture() async throws {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let marker = documents.appendingPathComponent("native-upgrade-phase.txt")
        guard let phase = try? String(contentsOf: marker, encoding: .utf8), ["prepare", "verify"].contains(phase) else {
            throw XCTSkip("Opt-in simulator installation workflow; see docs/IOS.md")
        }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Uchiyomi", isDirectory: true)
        let store = ProfileStore(root: root)
        let export = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "out", withExtension: nil))
        let remote = try ExportFixture(directory: export, revision: "native-upgrade")
        if phase == "prepare" {
            XCTAssertTrue(try store.load().profiles.isEmpty, "Use an empty, disposable simulator")
            let first = try store.profile(for: URL(string: "https://127.0.0.1:9")!, in: .init())
            let second = try store.profile(for: URL(string: "https://127.0.0.1:10")!, in: .init(profiles: [first]))
            try store.save(.init(profiles: [first, second], selectedID: first.id))
            for profile in [first, second] {
                let cache = AssetCache(root: store.directory(for: profile).appendingPathComponent("ui"))
                let ui = try await cache.prepare(client: remote) { _, _ in }; try await cache.confirm(ui)
            }
            let cookie = HTTPCookie(properties: [.name: "fixture_session", .value: "simulator-only", .domain: "127.0.0.1", .path: "/", .expires: Date(timeIntervalSince1970: 4_000_000_000)])!
            let record = Dictionary(uniqueKeysWithValues: cookie.properties!.map { ($0.key.rawValue, $0.value) })
            try KeychainCookieVault(profileID: first.id).write(PropertyListSerialization.data(fromPropertyList: [record], format: .binary, options: 0))
        }
        let catalog = try store.load()
        XCTAssertEqual(catalog.profiles.count, 2)
        let profile = try XCTUnwrap(catalog.profiles.first { $0.id == catalog.selectedID })
        let model = ReaderModel(root: root, assetClient: { _ in remote })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene); window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UIHostingController(rootView: ReaderView(model: model)); window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        do {
            await model.restore()
            let web = try XCTUnwrap(model.webView)
            if phase == "prepare" {
                try await waitFor(web, "!!document.querySelector('input[type=password]')")
                _ = try await web.callAsyncJavaScript(Self.seed, arguments: [:], in: nil, contentWorld: .page)
                try await reloadAndWait(web, "document.body.innerText.includes('Offline fixture')")
                _ = try await web.callAsyncJavaScript("""
                    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const tx=db.transaction(['chapters','outbox'],'readwrite');const chapters=tx.objectStore('chapters');
                    const r=chapters.get('ios-fixture:fixture-2');r.onsuccess=()=>chapters.put({...r.result,lastPage:2,lastPageAt:1900000000000,lastCompleted:false});
                    tx.objectStore('outbox').put({id:999,userId:'ios-fixture',bookId:'fixture-2',seriesId:'fixture-series',deviceId:'ios-test',page:2,completed:false,ts:1900000000000,tries:0});
                    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return true;
                    """, arguments: [:], in: nil, contentWorld: .page)
                try JSONEncoder().encode(catalog).write(to: documents.appendingPathComponent("native-upgrade-catalog.json"))
            } else {
                XCTAssertEqual(catalog, try JSONDecoder().decode(ProfileStore.Catalog.self, from: Data(contentsOf: documents.appendingPathComponent("native-upgrade-catalog.json"))))
                try await waitFor(web, "document.body.innerText.includes('Offline fixture')")
                let retained = try await web.callAsyncJavaScript("""
                    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('yomi-offline',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const get=(store,key)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const chapter=await get('chapters','ios-fixture:fixture-2'),queued=await get('outbox',999),page=await get('pages','ios-fixture:fixture-2:2');db.close();
                    return chapter?.lastPage===2 && queued?.page===2 && queued?.userId==='ios-fixture' && page?.size>0 && JSON.parse(localStorage.getItem('uchiyomi.offlineUser')).id==='ios-fixture';
                    """, arguments: [:], in: nil, contentWorld: .page) as? Bool
                XCTAssertEqual(retained, true)
                let cookies = try XCTUnwrap(KeychainCookieVault(profileID: profile.id).read())
                let records = try PropertyListSerialization.propertyList(from: cookies, format: nil) as? [[String: Any]]
                XCTAssertTrue(records?.contains { $0[HTTPCookiePropertyKey.value.rawValue] as? String == "simulator-only" } == true)
                try Data("Verified saved catalog, selected server, Keychain cookie, offline identity, chapter blobs, position 2 and unsynced outbox after in-place simulator installation.".utf8).write(to: documents.appendingPathComponent("native-upgrade-result.txt"))
            }
            await model.addServer()
        } catch { await model.addServer(); throw error }
    }

    private func reloadAndWait(_ web: WKWebView, _ expression: String) async throws {
        _ = try await web.evaluateJavaScript("window.__fixtureReloadMarker = true; true")
        web.reload()
        try await waitFor(web, "!window.__fixtureReloadMarker && document.readyState === 'complete' && (" + expression + ")")
    }

    private func waitFor(_ web: WKWebView, _ expression: String) async throws {
        for _ in 0..<150 {
            if (try? await web.evaluateJavaScript(expression)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        NSLog("WebKit wait timed out: %@", expression)
        if let body = try? await web.evaluateJavaScript("document.body.innerText") { NSLog("WebKit page: %@", String(describing: body)) }
        throw ClientError.invalid("Timed out waiting for: " + expression)
    }

    private static let seed = #"""
    localStorage.setItem('uchiyomi.offlineUser', JSON.stringify({v:1,id:'ios-fixture',username:'fixture',displayName:'Offline Tester',role:'admin',exp:Date.now()+86400000}));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('yomi-offline', 2);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters',{keyPath:'key'}).createIndex('byUser','userId');
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox',{keyPath:'id',autoIncrement:true});
      };
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction(['chapters','pages'], 'readwrite');
    for (const n of [1,2]) {
      const bookId = 'fixture-'+n;
      tx.objectStore('chapters').put({key:'ios-fixture:'+bookId,userId:'ios-fixture',bookId,seriesId:'fixture-series',seriesTitle:'Offline fixture',title:'Chapter '+n,number:String(n),pageCount:2,readingDirection:'VERTICAL',totalBytes:300,savedAt:Date.now(),pages:[1,2].map(number=>({number,width:800,height:1200}))});
      for (const p of [1,2]) {
        const image = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="${n===1?'#a7c7e7':'#c1e1c1'}"/><text x="60" y="150" font-size="48">Chapter ${n} / page ${p}</text></svg>`;
        tx.objectStore('pages').put(new Blob([image],{type:'image/svg+xml'}), 'ios-fixture:'+bookId+':'+p);
      }
    }
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    db.close();
    return true;
    """#
}

private extension UIScreen {
    func screenshotForTest(window: UIWindow) -> UIImage {
        UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    }
}

private final class ExportFixture: AssetFetching {
    enum Failure { case none, interrupted, corrupt, unsupportedSchema }
    var manifestReads = 0
    var assetReads = 0
    var assetDelay: UInt64 = 0
    private let inventory: Data
    private let files: [String: Data]
    private let failure: Failure
    init(directory: URL, revision: String, broken: Bool = false, failure: Failure = .none) throws {
        self.failure = failure
        let original = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: directory.appendingPathComponent("mobile-assets.json")))
        var bytes: [String: Data] = [:]
        for asset in original.files {
            var data = try Data(contentsOf: directory.appendingPathComponent(String(asset.path.dropFirst())))
            if asset.path.hasSuffix(".html") { data.append(Data("<!-- \(revision) -->".utf8)) }
            if broken && asset.path.hasSuffix(".js") { data = Data("throw new Error('Test bootstrap failure');".utf8) }
            bytes[asset.path] = data
        }
        var manifest = AssetManifest(schemaVersion: 1, protocolVersion: 1, offlineSchemaVersion: failure == .unsupportedSchema ? 3 : 2,
            buildId: AssetManifest.digest(Data(revision.utf8)), files: original.files.map {
                .init(path: $0.path, size: bytes[$0.path]!.count, sha256: AssetManifest.digest(bytes[$0.path]!), contentType: $0.contentType)
            })
        manifest.startupCheckVersion = 1
        inventory = try JSONEncoder().encode(manifest); files = bytes
    }
    func assetResponse(_ path: String, maxBytes: Int) async throws -> HTTPResponse {
        if path == "/mobile-assets.json" { manifestReads += 1; return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: inventory) }
        assetReads += 1
        if assetDelay > 0 { try await Task.sleep(nanoseconds: assetDelay) }
        if failure == .interrupted && assetReads == 3 { throw URLError(.networkConnectionLost) }
        guard let data = files[path] else { return .message(404, "missing") }
        if failure == .corrupt && assetReads == 3 { return HTTPResponse(status: 200, body: Data(repeating: 0, count: data.count)) }
        return HTTPResponse(status: 200, body: data)
    }
}
