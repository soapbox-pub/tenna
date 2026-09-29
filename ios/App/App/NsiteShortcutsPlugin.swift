import Capacitor
import Foundation

/**
 The share-sheet half of `NsiteShortcuts`, on iOS.

 Android's plugin of the same name does two jobs: a window and a home-screen
 icon per site, which iOS has no equivalent of, and a place in the share sheet
 for every site that declares a `share_target`, which it does. This is the
 second, answering the same interface (`src/lib/nsiteShortcutsPlugin.ts`) so
 the wall and the picker do not branch.

 On iOS Tenna has one entry in the sheet, not one per site: the share
 extension (`TennaShare`) stages what was shared and opens Tenna on its token,
 and the wall's picker asks which site it is for. So the sites that take
 shares are written down here, in their records, for that picker to list.
 */
@objc(NsiteShortcutsPlugin)
public class NsiteShortcutsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NsiteShortcutsPlugin"
    public let jsName = "NsiteShortcuts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncSite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshIcon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listShareTargets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSharePayload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseShare", returnType: CAPPluginReturnPromise),
    ]

    private static let shareEvent = "nsiteShare"

    /// A share the extension opened Tenna with, not yet handed to the wall.
    private static var pending: String?
    private static weak var current: NsiteShortcutsPlugin?

    override public func load() {
        Self.current = self
    }

    /**
     A share has arrived, from `SceneDelegate`.

     Told to the wall at once if it is listening; otherwise kept for
     `getPendingShare`, which is how a cold launch finds it.
     */
    static func received(token: String) {
        guard NsiteShares.payload(token) != nil else { return }
        if let plugin = current, plugin.hasListeners(shareEvent), let share = plugin.share(token) {
            pending = nil
            plugin.notifyListeners(shareEvent, data: share)
        } else {
            pending = token
        }
    }

    private func share(_ token: String) -> JSObject? {
        guard let payload = NsiteShares.payload(token) else { return nil }
        return ["token": token, "payload": JSTypes.coerceDictionaryToJSObject(payload) ?? [:]]
    }

    /// No home-screen icon per site on iOS.
    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": false])
    }

    // MARK: - The wall

    @objc func syncSite(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        let enabled = call.getBool("enabled") ?? false
        let given = call.getString("shareTarget")

        NsiteStore.update(siteId) { record in
            if let label = call.getString("label"), !label.isEmpty { record.label = label }
            if let event = call.getString("event"), !event.isEmpty { record.event = event }
            // Omitted means the manifest was not read, so nothing is known.
            if given != nil || !enabled {
                record.shareTarget = enabled && given?.isEmpty == false ? given : nil
            }
        }
        storeIcon(siteId, call.getString("icon"))
        call.resolve()
    }

    /// The tile, drawn by the wall, as the face of the site's notifications.
    @objc func refreshIcon(_ call: CAPPluginCall) {
        guard let siteId = call.getString("siteId"), NsiteOrigins.isSiteId(siteId) else {
            call.reject("Not a site id")
            return
        }
        storeIcon(siteId, call.getString("icon"))
        call.resolve()
    }

    private func storeIcon(_ siteId: String, _ base64: String?) {
        guard let base64, let png = Data(base64Encoded: base64) else { return }
        NsiteStore.setIcon(siteId, png: png)
    }

    @objc func listShareTargets(_ call: CAPPluginCall) {
        let sites: [JSObject] = NsiteStore.all()
            .filter { $0.shareTarget != nil && $0.event != nil }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            .map { record in
                var site: JSObject = [
                    "siteId": record.siteId,
                    "label": record.label,
                    "event": record.event ?? "",
                    "shareTarget": record.shareTarget ?? "",
                ]
                if let icon = NsiteStore.icon(record.siteId) { site["icon"] = icon.base64EncodedString() }
                return site
            }
        call.resolve(["sites": sites])
    }

    // MARK: - Shares

    @objc func getPendingShare(_ call: CAPPluginCall) {
        guard let token = Self.pending, let share = share(token) else {
            call.resolve([:])
            return
        }
        Self.pending = nil
        call.resolve(share)
    }

    @objc func getSharePayload(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let payload = NsiteShares.payload(token) else {
            call.reject("No such share")
            return
        }
        call.resolve(JSTypes.coerceDictionaryToJSObject(payload) ?? [:])
    }

    @objc func releaseShare(_ call: CAPPluginCall) {
        if let token = call.getString("token") { NsiteShares.release(token) }
        call.resolve()
    }
}
