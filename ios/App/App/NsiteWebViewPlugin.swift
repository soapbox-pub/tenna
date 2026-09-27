import Capacitor
import UIKit
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
    ]

    /// The site on screen, if there is one. Only ever one at a time.
    private var site: NsiteSession?

    // MARK: - open

    @objc func open(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        guard let url = NsiteOrigins.indexURL(siteId) else {
            call.reject("Not a site id")
            return
        }

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
                // No `napp.fetch` here, so nothing ever hands this WebView bytes.
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
            session.load(url)
            call.resolve()
        }
    }

    // MARK: - navigate

    @objc func navigate(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        // Only a `get` delivery means anything here. A `post` one is a share
        // target, which needs a service worker to claim the navigation, and a
        // document under a custom scheme has none — so iOS never offers share
        // targets and never receives one. See NsiteOrigins.
        guard let share = call.getObject("share"),
              share["kind"] as? String == "get",
              let path = share["path"] as? String,
              path.hasPrefix("/"), !path.hasPrefix("//"),
              let origin = NsiteOrigins.originFor(siteId),
              let url = URL(string: origin + path) else {
            call.reject("Not a path inside the site")
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.site?.load(url)
            call.resolve()
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
