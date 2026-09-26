import Capacitor
import UIKit
import UserNotifications

/**
 The native half of `window.napp.push`, and of the Notifications API around it.

 The iOS counterpart of `NappPushPlugin.java`, answering the same interface
 (`src/lib/nappPushPlugin.ts`) so the web layer does not branch. What differs is
 everything underneath: there is no foreground service and no relay socket here,
 because iOS will not let an app hold one. A subscription is written down and
 handed to the **push service** instead — see `src/lib/nostrPush.ts` — which
 holds the relays for every Tenna on every phone and wakes this one through
 APNs. The extension then runs the site's worker. See `NotificationService`.

 So the three methods that do the most work here do almost nothing: `set`
 stores, `getMuted` reads, `status` asks the system. The interesting part is
 that the store is in a shared container, because the process that reads it is
 not this one.

 Two methods have no Android counterpart and are iOS's alone:

 - `deviceToken`, because a token is what the push service registers, and
   there is nothing like it on a platform that holds its own sockets.
 - `registerWorker`, because WebKit will not install a service worker for a
   document under a custom scheme, so the path a site passed to
   `navigator.serviceWorker.register` is the only record there is of which
   script to run. See `NsiteOrigins` and the shim in `nsiteNostrProvider.ts`.
 */
@objc(NappPushPlugin)
public class NappPushPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NappPushPlugin"
    public let jsName = "NappPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unread", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "subscriptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerWorker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "periodicSyncRegister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "periodicSyncUnregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "periodicSyncTags", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "periodicSyncClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNotifyGrants", returnType: CAPPluginReturnPromise),
    ]

    /// Told when a site's row in the shade moves, so the wall can redraw its dots.
    private static let notificationsChanged = "nappNotificationsChanged"
    /// Told when the merged list the push service holds would be different.
    private static let subscriptionsChanged = "nappSubscriptionsChanged"
    /// Told when the user tapped one of a site's notifications.
    static let notificationOpen = "nappNotificationOpen"

    /// The one instance, so `AppDelegate` can hand it a token and a tap.
    private(set) static weak var current: NappPushPlugin?

    override public func load() {
        Self.current = self
    }

    // MARK: - Subscriptions

    @objc func set(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId),
              let label = call.getString("label"), !label.isEmpty,
              let text = call.getString("subscriptions") else {
            call.reject("siteId, label and subscriptions are required")
            return
        }

        let normalized: [Any]
        do {
            normalized = try NappSubscriptions.normalize(text)
        } catch {
            call.reject(error.localizedDescription)
            return
        }

        guard let record = NsiteStore.update(siteId, { record in
            record.label = label
            record.subscriptions = normalized
        }) else {
            call.reject("Could not store the subscriptions")
            return
        }

        // Clearing is how the shield revokes the permission, and a revoked
        // permission that left the site's notifications in the shade would not
        // have revoked much.
        if normalized.isEmpty {
            closeAll(siteId)
        } else {
            // The worker will be wanted inside an extension with no app around
            // it, so fetch it now while there is a network and a main app to
            // use it. See `NsiteFileServer.warm`.
            warmWorker(record)
        }

        notifyListeners(Self.subscriptionsChanged, data: [:])

        call.resolve(["subscriptions": NappSubscriptions.text(normalized)])
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        let stored = NsiteStore.load(siteId)?.subscriptions ?? []
        call.resolve(["subscriptions": NappSubscriptions.text(stored)])
    }

    /// The merged list the push service holds for this device, as JSON text.
    @objc func subscriptions(_ call: CAPPluginCall) {
        call.resolve(["subscriptions": NsiteStore.merged()])
    }

    /**
     Remember which script is this site's service worker.

     There is no registration to read it back off: WebKit refuses service
     workers to a document whose scheme is not http or https, and `WKWebView`
     will not let anybody answer for those two. So the site's own call to
     `navigator.serviceWorker.register` is shimmed in the page and lands here,
     and this record is what the extension runs.
     */
    @objc func registerWorker(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId),
              let path = call.getString("path"), NsiteBlobs.isPath(path) else {
            call.reject("siteId and a site-absolute path are required")
            return
        }

        guard let record = NsiteStore.update(siteId, { record in
            record.worker = path
            if let label = call.getString("label"), !label.isEmpty { record.label = label }
        }) else {
            call.reject("Could not store the worker")
            return
        }

        warmWorker(record)
        call.resolve()
    }

    private func warmWorker(_ record: NsiteRecord) {
        let path = record.worker ?? "/sw.js"
        guard record.files[path] != nil else { return }

        let siteId = record.siteId
        let server = NsiteFileServer(files: record.files, servers: record.servers)
        Task.detached {
            let ok = await server.warm(path)
            if !ok { NSLog("[NappPush] could not cache %@ for %@", path, siteId) }
        }
    }

    // MARK: - Periodic sync

    /// `registration.periodicSync.register`, the user having said yes. See `NappPeriodicSync`.
    @objc func periodicSyncRegister(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId),
              let tag = call.getString("tag"), !tag.isEmpty else {
            call.reject("siteId and tag are required")
            return
        }
        // Milliseconds from the web, seconds here.
        let minInterval = (call.getDouble("minInterval") ?? 0) / 1000

        do {
            try NappPeriodicSync.register(
                siteId: siteId, label: call.getString("label"), tag: tag, minInterval: minInterval)
        } catch {
            call.reject(error.localizedDescription)
            return
        }

        // The worker will be wanted by a background task that may have no
        // network worth the name, so fetch it now, as `set` does.
        if let record = NsiteStore.load(siteId) { warmWorker(record) }
        call.resolve()
    }

    @objc func periodicSyncUnregister(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), let tag = call.getString("tag") else {
            call.reject("siteId and tag are required")
            return
        }
        NappPeriodicSync.unregister(siteId: siteId, tag: tag)
        call.resolve()
    }

    @objc func periodicSyncTags(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        call.resolve(["tags": NappPeriodicSync.tags(siteId: siteId)])
    }

    @objc func periodicSyncClear(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        NappPeriodicSync.forget(siteId: siteId)
        call.resolve()
    }

    /// Every site allowed to notify. See `NappNotifyGrants`.
    @objc func setNotifyGrants(_ call: CAPPluginCall) {
        guard let siteIds = call.getArray("siteIds") else {
            call.reject("siteIds is required")
            return
        }
        NappNotifyGrants.set(siteIds.compactMap { $0 as? String })
        call.resolve()
    }

    // MARK: - Muting

    @objc func setMuted(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        let muted = call.getBool("muted") ?? false

        NsiteStore.update(siteId) { $0.muted = muted }
        if muted { closeAll(siteId) }

        // Muting takes the site out of the merged list, which is what makes it
        // reach past the shade and stop the traffic at the service.
        notifyListeners(Self.subscriptionsChanged, data: [:])
        call.resolve()
    }

    @objc func getMuted(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        call.resolve(["muted": NsiteStore.load(siteId)?.muted ?? false])
    }

    // MARK: - The tray

    @objc func show(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId),
              let label = call.getString("label"),
              let payloadText = call.getString("payload"),
              let payload = NappSubscriptions.object(payloadText) else {
            call.reject("siteId, label and payload are required")
            return
        }

        // A site reached straight from a link may have no record yet: nothing
        // writes one until a tile has been drawn. Write it now so the site is
        // named in the shade and can be muted afterwards.
        NsiteStore.update(siteId) { record in
            if record.label == record.siteId { record.label = label }
        }

        guard !(NsiteStore.load(siteId)?.muted ?? false) else {
            call.resolve(["shown": false])
            return
        }

        let title = payload["title"] as? String ?? ""
        let options = payload["options"] as? [String: Any] ?? [:]

        NappNotifications.show(siteId: siteId, label: label, title: title, options: options) { [weak self] shown in
            if shown { self?.notifyListeners(Self.notificationsChanged, data: ["siteId": siteId]) }
            call.resolve(["shown": shown])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId") else {
            call.reject("siteId is required")
            return
        }
        let tag = call.getString("tag")

        NappNotifications.list(siteId: siteId, tag: tag) { records in
            call.resolve(["notifications": NappSubscriptions.text(records)])
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), let key = call.getString("key") else {
            call.resolve()
            return
        }
        NappNotifications.close(siteId: siteId, key: key)
        notifyListeners(Self.notificationsChanged, data: ["siteId": siteId])
        call.resolve()
    }

    @objc func unread(_ call: CAPPluginCall) {
        let wanted = Set(call.getArray("siteIds") as? [String] ?? [])

        NappNotifications.sites { out in
            call.resolve(["siteIds": Array(out.intersection(wanted))])
        }
    }

    private func closeAll(_ siteId: String) {
        NappNotifications.closeAll(siteId: siteId)
        notifyListeners(Self.notificationsChanged, data: ["siteId": siteId])
    }

    // MARK: - Permission

    @objc func requestPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            NappNotifications.refresh()
            if granted {
                // Nothing can be pushed here without one, and this is the first
                // moment asking for it is honest: the user has just said yes.
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            call.resolve(["granted": granted])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        NappNotifications.refresh { granted in
            call.resolve([
                "granted": granted,
                // "Running" is the push service's business, not this device's.
                // The nearest true thing here is that a token exists to be
                // pushed to; without one nothing can arrive.
                "running": granted && NappTokens.current != nil,
                // A worker can be run here, which is what a site is asking.
                "supported": NsiteGroup.shared,
            ])
        }
    }

    // MARK: - The device token

    @objc func deviceToken(_ call: CAPPluginCall) {
        var result: [String: Any] = ["environment": NappTokens.environment]
        if let token = NappTokens.current { result["token"] = token }

        guard NappTokens.current == nil else {
            call.resolve(result)
            return
        }

        // Nothing has registered yet, or registration is still in flight. Ask
        // for one and answer when it lands, so the web layer's first call on a
        // fresh install does not have to poll.
        NappTokens.whenAvailable { token in
            var out: [String: Any] = ["environment": NappTokens.environment]
            if let token { out["token"] = token }
            call.resolve(out)
        }
    }

    // MARK: - From AppDelegate

    /// A tap on one of a site's notifications. Retained until the web layer is
    /// listening, because a cold launch reaches here before React exists.
    func opened(siteId: String, path: String?) {
        var data: JSObject = ["siteId": siteId]
        if let path { data["path"] = path }
        notifyListeners(Self.notificationOpen, data: data, retainUntilConsumed: true)
        notifyListeners(Self.notificationsChanged, data: ["siteId": siteId])
    }

    /// A push arrived and its extension may have put something in the shade.
    func delivered(siteId: String) {
        notifyListeners(Self.notificationsChanged, data: ["siteId": siteId])
    }
}
