import Capacitor
import UIKit
import UserNotifications
import WebKit

/**
 Gives an nsite a WebView of its own.

 The iOS half of `NsiteWebViewPlugin.java`, and it exists for the same reason:
 a site held as its own top-level document gets its own origin and real
 safe-area insets, and its files never round-trip through the Capacitor bridge
 to reach it. `NsiteFileServer` does the serving; this is the lifecycle around
 it, and the layering.

 ## How this differs from Android, and why

 On Android a site opened from the wall is launched into a task of its own, so
 the native WebView fills the window and nothing of Tenna's is drawn over it.
 iOS has no per-site windows — `supportsNsiteWindows()` is false here — so the
 site opens over the wall with `NsiteTopBar` above it, and a WebView filling
 the window would bury the bar. So this one is given a frame by the web layer:
 the same box the iframe implementation draws into, measured there and passed
 across on `open` and again whenever it changes.

 The site still gets honest insets from that box. With
 `contentInsetAdjustmentBehavior = .never`, a WebView that does not reach the
 top of the screen correctly reports a top inset of zero — which is the truth,
 because Tenna's bar is what is up there.
 */
@objc(NsiteWebViewPlugin)
public class NsiteWebViewPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NsiteWebViewPlugin"
    public let jsName = "NsiteWebView"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConcealed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respondCapability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStorageUsage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearStorage", returnType: CAPPluginReturnPromise),
    ]

    /// The site on screen, if there is one. Only ever one at a time.
    private var site: NsiteSession?

    // MARK: - open

    @objc func open(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        guard let front = NsiteOrigins.indexURL(siteId) else {
            call.reject("Not a site id")
            return
        }
        // Where the window opens: the front page, or where a notification or
        // a share pointed. See `entry`.
        let share = call.getObject("share")

        // Re-filtered on this side of the bridge as well as the other: the
        // manifest is a stranger's event either way, and this is the process
        // that turns it into paths. See NsiteBlobs.
        var files: [String: String] = [:]
        for (path, value) in call.getObject("files") ?? [:] {
            guard let sha256 = value as? String,
                  NsiteBlobs.isPath(path), NsiteBlobs.isName(sha256) else { continue }
            files[path] = sha256
        }

        let servers = (call.getArray("servers") as? [String] ?? []).filter {
            guard let url = URL(string: $0) else { return false }
            return url.scheme == "https"
        }

        let frame = rect(from: call.getObject("frame"))
        let name = call.getString("name") ?? siteId

        // What the site is made of, written where the notification extension
        // can read it. A push arrives with no app running and no relay dialled,
        // so the manifest has to already be on disk for the site's worker to be
        // served at all. See `NsiteStore`.
        NsiteStore.update(siteId) { record in
            if !files.isEmpty { record.files = files }
            if !servers.isEmpty { record.servers = servers }
            record.label = name
        }

        // The device's half of `Notification.permission`, which the web layer
        // cannot know and the site reads synchronously. See the placeholder.
        let couldNotify = NappNotifications.enabled && !(NsiteStore.load(siteId)?.muted ?? false)
        let script = call.getString("providerScript").map { source in
            source
                // A script message carries text, so a `napp.fetch` body is
                // handed over as base64url. See `NappFetch`.
                .replacingOccurrences(of: "%%NAPP_BINARY%%", with: "false")
                .replacingOccurrences(of: "%%NAPP_NOTIFY_DEVICE%%",
                                      with: couldNotify ? "true" : "false")
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let container = self.bridge?.webView?.superview else {
                call.reject("No view to add the site to")
                return
            }

            self.site?.tearDown()

            let session = NsiteSession(
                siteId: siteId,
                name: name,
                files: files,
                servers: servers,
                providerScript: script,
                onLoad: { [weak self] in self?.notifyListeners("nsiteLoad", data: [:]) },
                onRpc: { [weak self] id, method, params in
                    self?.notifyListeners("nsiteRpc", data: [
                        "id": id, "method": method, "params": params,
                    ])
                },
                onCapability: { [weak self] id, kinds in
                    self?.notifyListeners("nsiteCapability", data: ["id": id, "kinds": kinds])
                },
                onLink: { [weak self] url in
                    self?.notifyListeners("nsiteLink", data: ["url": url])
                }
            )
            self.site = session

            session.attach(to: container, frame: frame ?? container.bounds)
            call.resolve()
            Task { @MainActor [weak self] in
                let url = await Self.entry(share, siteId: siteId) ?? front
                // Closed, or replaced, while a share's worker ran.
                guard self?.site === session else { return }
                session.load(url)
            }
        }
    }

    // MARK: - navigate

    @objc func navigate(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        guard let share = call.getObject("share") else {
            call.reject("Not a path inside the site")
            return
        }
        Task { @MainActor [weak self] in
            guard let url = await Self.entry(share, siteId: siteId) else {
                call.reject("Not a path inside the site")
                return
            }
            self?.site?.load(url)
            call.resolve()
        }
    }

    /**
     The URL a delivery opens the site at: a `get` is a path inside the site —
     a notification's `data.url`, or a GET share — and a `post` is a share the
     site's worker is handed first. See `NsiteShareDelivery`.
     */
    @MainActor
    private static func entry(_ share: JSObject?, siteId: String) async -> URL? {
        guard let share, let origin = NsiteOrigins.originFor(siteId) else { return nil }
        switch share["kind"] as? String {
        case "get":
            guard let path = share["path"] as? String, path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
            return URL(string: origin + path)
        case "post":
            guard let token = share["token"] as? String, NsiteShares.isToken(token),
                  let plan = share["plan"] as? String else { return nil }
            return await NsiteShareDelivery.deliver(siteId: siteId, token: token, plan: plan)
        default:
            return nil
        }
    }

    // MARK: - close

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.site?.tearDown()
            self?.site = nil
            call.resolve()
        }
    }

    // MARK: - goBack

    @objc func goBack(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            call.resolve(["moved": self?.site?.goBack() ?? false])
        }
    }

    // MARK: - updateFrame

    @objc func updateFrame(_ call: CAPPluginCall) {
        guard let frame = rect(from: call.getObject("frame")) else {
            call.reject("Not a frame")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.site?.setFrame(frame)
            call.resolve()
        }
    }

    // MARK: - setConcealed

    /**
     Hide the site's pixels without unloading it, handing back a picture of the
     last frame.

     The picture is the whole point, and the reason this can't simply hide the
     view. The site's WebView is above the Capacitor one, so a prompt drawn by
     React is invisible until the site is gone — and a sheet over a blank
     screen doesn't read as a sheet over the app the user is in. So React draws
     the still where the site was, and what is behind the sheet is an image,
     incapable of reacting to anything.

     Android captures synchronously, because a backdrop that arrives late is
     one the user watches pop in. WebKit has no supported synchronous read-back
     of an out-of-process renderer, so this snapshots first and hides only once
     the image is in hand. The site therefore stays up a few milliseconds
     longer than on Android, and there is no window in which it is neither
     drawn nor photographed.
     */
    @objc func setConcealed(_ call: CAPPluginCall) {
        let concealed = call.getBool("concealed") ?? false
        let wantsStill = call.getBool("still") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let session = self?.site else {
                call.resolve([:])
                return
            }

            guard concealed else {
                session.setConcealed(false)
                call.resolve([:])
                return
            }

            guard wantsStill else {
                session.setConcealed(true)
                call.resolve([:])
                return
            }

            session.snapshot { dataURL in
                session.setConcealed(true)
                // A site that couldn't be photographed is still a site that
                // has to get out of the way; neither half is worth failing a
                // permission prompt over.
                call.resolve(dataURL.map { ["still": $0] } ?? [:])
            }
        }
    }

    // MARK: - RPC

    // MARK: - setIcon

    /// The site's tile, kept for its notifications. See `NsiteStore.setIcon`.
    @objc func setIcon(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId),
              let text = call.getString("icon"),
              let png = Data(base64Encoded: text) else {
            call.reject("Not an icon")
            return
        }

        DispatchQueue.global(qos: .utility).async {
            if NsiteStore.setIcon(siteId, png: png) {
                call.resolve()
            } else {
                call.reject("Could not store the icon")
            }
        }
    }

    /**
     Forget everything Tenna keeps for a site: its IndexedDB, its WebKit data
     store — cookies, localStorage, cache — its record in the App Group, and
     with the record its subscriptions, its periodic syncs and whether it was
     muted, and whatever it has in Notification Centre. What
     `NsiteShortcutsPlugin.forgetSite` does on Android when a site leaves the
     wall.

     A site open on screen is closed first: WebKit will not remove a data
     store a WebView is using.
     */
    @objc func forget(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site")
            return
        }
        DispatchQueue.main.async { [weak self] in
            if let self, self.site?.siteId == siteId {
                self.site?.tearDown()
                self.site = nil
            }
            NsiteIndexedDB.forget(siteId)
            NsiteStore.remove(siteId)
            let center = UNUserNotificationCenter.current()
            center.getDeliveredNotifications { delivered in
                let ids = delivered.filter { $0.request.content.threadIdentifier == siteId }.map(\.request.identifier)
                center.removeDeliveredNotifications(withIdentifiers: ids)
            }
            WKWebsiteDataStore.remove(forIdentifier: NsiteSession.storeIdentifier(for: siteId)) { error in
                if let error { NSLog("[NsiteWebView] could not remove %@'s data store: %@", siteId, error.localizedDescription) }
                call.resolve()
            }
        }
    }

    /**
     How much a site has stored, in bytes: its IndexedDB and its WebKit data
     store, measured on disk. The store is WebKit's to lay out, and its
     directory is found where WebKit puts an identified store — a WebKit that
     puts it somewhere else is counted as the IndexedDB alone.
     */
    @objc func getStorageUsage(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site")
            return
        }
        DispatchQueue.main.async {
            // Lowercase, as WebKit names the directory, on a filesystem that
            // tells the two apart.
            let store = NsiteSession.storeIdentifier(for: siteId).uuidString.lowercased()
            DispatchQueue.global(qos: .utility).async {
                call.resolve(["bytes": Self.usage(siteId, store: store)])
            }
        }
    }

    /// What `getStorageUsage` measures, off the main thread.
    private static func usage(_ siteId: String, store: String) -> Int {
        let manager = FileManager.default
        var places = [NsiteIndexedDB.location(siteId)]
        for base in [manager.urls(for: .libraryDirectory, in: .userDomainMask)[0],
                     manager.urls(for: .cachesDirectory, in: .userDomainMask)[0]] {
            places.append(base.appendingPathComponent("WebKit/WebsiteDataStore/\(store)", isDirectory: true))
        }
        return places.reduce(0) { $0 + size(of: $1) }
    }

    /**
     Wipe what a site stored for itself, and keep the site: its IndexedDB, and
     everything in its WebKit data store — cookies, localStorage, caches. What
     Tenna holds about it — its record, its permissions, whether it is muted —
     is left alone. `forget` is the one that takes those.

     A site open on screen is closed first, as it is for `forget`: a page left
     running would go on holding what it had read, and write it back.
     */
    @objc func clearStorage(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site")
            return
        }
        DispatchQueue.main.async { [weak self] in
            if let self, self.site?.siteId == siteId {
                self.site?.tearDown()
                self.site = nil
            }
            NsiteIndexedDB.forget(siteId)
            let store = WKWebsiteDataStore(forIdentifier: NsiteSession.storeIdentifier(for: siteId))
            store.removeData(
                ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                modifiedSince: .distantPast
            ) {
                call.resolve()
            }
        }
    }

    /// Everything under a directory, in bytes, as allocated on disk.
    private static func size(of url: URL) -> Int {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .isRegularFileKey]
        guard let files = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true }
        ) else { return 0 }
        var total = 0
        for case let file as URL in files {
            guard let values = try? file.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true else { continue }
            total += values.totalFileAllocatedSize ?? 0
        }
        return total
    }

    /// Deliver a JSON-RPC response for a call previously raised as `nsiteRpc`.
    ///
    /// Either it went or the site has gone and there was nobody to tell.
    /// Neither is the caller's fault and neither is recoverable, so this
    /// resolves regardless.
    @objc func respond(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.resolve()
            return
        }
        let result = call.getString("result")
        let error = call.getString("error")

        DispatchQueue.main.async { [weak self] in
            self?.site?.respond(id: id, result: result, error: error)
            call.resolve()
        }
    }

    @objc func respondCapability(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.resolve()
            return
        }
        let granted = call.getBool("granted") ?? false

        DispatchQueue.main.async { [weak self] in
            self?.site?.respondCapability(id: id, granted: granted)
            call.resolve()
        }
    }

    // MARK: -

    /// A frame from the web layer. CSS pixels and points are the same unit in
    /// a `WKWebView` at standard zoom, so the rect crosses unconverted.
    private func rect(from object: JSObject?) -> CGRect? {
        guard let object,
              let x = object["x"] as? Double,
              let y = object["y"] as? Double,
              let width = object["width"] as? Double,
              let height = object["height"] as? Double else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
