import Foundation
import UserNotifications

/**
 `notificationclick` and `notificationclose`, raised in a site's worker.

 The iOS counterpart of `NappPushService.dispatchNotificationEvent`. A tap, a
 button, a reply or a swipe reaches the app rather than the notification
 extension — iOS starts one of those only to change a push on its way in — so
 the worker is run here instead, by the same `NsiteWorkerHost` the extension
 and a periodic sync run use, with the notification handed over as the event's
 `notification`, the button's name as its `action` and the text typed as its
 `reply`.

 A tap on the body has already opened the site at `data.url` by the time the
 worker hears about it, as on Android, and for the next minute the worker may
 move that window with `clients.openWindow`. A button or a swipe opens
 nothing: the buttons are registered without `.foreground`, so Tenna is
 started in the background, the worker answers, and whatever it asks to show
 is posted.
 */
@MainActor
enum NappNotificationEvents {

    /// As long as a push gets, which is what a site is told to write for.
    private static let budget: TimeInterval = 20

    /// How long after a tap the worker may still open its window.
    private static let openWindow: TimeInterval = 60

    static func handle(_ response: UNNotificationResponse) async {
        let request = response.notification.request
        let content = request.content
        let info = content.userInfo
        let siteId = info["site"] as? String ?? content.threadIdentifier

        guard NsiteOrigins.isSiteId(siteId), let site = NsiteStore.load(siteId),
              site.files[site.worker ?? "/sw.js"] != nil else { return }

        let kind: String
        var action = ""
        var reply: String?
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier:
            kind = "notificationclick"
        case UNNotificationDismissActionIdentifier:
            kind = "notificationclose"
        default:
            guard let name = NappActions.action(fromIdentifier: response.actionIdentifier) else { return }
            kind = "notificationclick"
            action = name
            reply = (response as? UNTextInputNotificationResponse)?.userText
        }

        // The shape the shim's `NappNotification` is built from — the same
        // record `getNotifications` answers with.
        var record: [String: Any] = [
            "key": request.identifier,
            "tag": info["tag"] as? String ?? "",
            "title": info["title"] as? String ?? content.title,
            "options": (info["options"] as? String).flatMap { NappSubscriptions.object($0) } ?? [:],
            "action": action,
        ]
        if let reply { record["reply"] = reply }

        let host = NsiteWorkerHost(site: site)
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            let until = Date().addingTimeInterval(openWindow)
            host.opener = { path in
                guard Date() < until, let plugin = NappPushPlugin.current else { return false }
                plugin.opened(siteId: siteId, path: path)
                return true
            }
        }

        NSLog("[NappNotificationEvents] %@ for %@", kind, siteId)
        let notifications = await host.deliver(
            kind: kind, data: NappSubscriptions.text(record), timeout: budget)
        NsiteIndexedDB.closeIdle()

        guard !notifications.isEmpty else { return }
        guard NappNotifyGrants.allowed(siteId), !(NsiteStore.load(siteId)?.muted ?? false) else {
            NSLog("[NappNotificationEvents] %@ may not notify; dropped %d", siteId, notifications.count)
            return
        }
        for notification in notifications {
            _ = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                NappNotifications.show(
                    siteId: siteId, label: site.label,
                    title: notification.title, options: notification.options
                ) { continuation.resume(returning: $0) }
            }
        }
        NappPushPlugin.current?.delivered(siteId: siteId)
    }
}
