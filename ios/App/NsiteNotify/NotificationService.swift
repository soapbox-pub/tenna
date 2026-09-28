import UserNotifications

/**
 Lets an nsite's own code say what its notification says.

 A push arrives carrying a nostr event. Tenna does not know what the event
 means — only the site does, and the site's opinion lives in its service worker,
 the same worker that would be woken on Android. So this extension works out
 whose event it is, starts that site's worker, hands it the event as a `push`,
 and shows whatever it asked for.

 ## Why the fallback matters

 iOS will not let an extension modify a silent notification, and if this one
 does not answer in time "the system displays the original content". So the
 push always arrives as a complete, showable notification written by the push
 server — a placeholder along the lines of "New notification" — and what happens
 here is an *override*. A worker that is slow, that throws, that has no `push`
 listener, or that runs out of memory costs the user a vaguer notification
 rather than no notification.

 That is also what keeps the push server ignorant: it never has to understand a
 nostr event, because it never has to write the text that a reader actually
 wants.

 ## Whose push is it?

 **The push does not say, and that is on purpose.** Tenna registers with the
 push service as *one client* with every site's subscriptions merged into one
 list, because the service pushes an event to a client at most once: an event
 two sites both care about then costs one push and one wake-up instead of two,
 and a client per site would cost one of each per site. The price is that the
 routing is the host's job, done here — see `NsiteFilter` — against the same
 filters the sites set, read out of the shared container `NsiteStore` keeps.

 Which is also why the event has to be in hand before anything else happens.
 When it does not fit the four kilobytes a push gets, what arrives is its id and
 the relays it was seen on, and `NsiteRelayFetch` goes and gets it. A worker
 would have had to do that anyway; here the host does it first, once, because it
 cannot even tell which worker to start until it has.

 ## What has been measured

 This has run on a real iPhone out of real APNs pushes — which the simulator
 could never show. (`simctl push` never enters `didReceive`, and an app carrying
 `aps-environment` will not launch there at all.)

 What SpringBoard says about it:

 ```
 Received remote notification request … hasMutableContent: 1 pushType: Alert
 Will deliver mutated notification content; … runtime: 0.187876
 Delivered user visible push notification …
 ```

 **Mutated** is the word that matters: what reached the shade was the worker's
 sentence and not the server's. Inside the extension, `Request replacement
 content` to `Received replacement content` took **110 ms**, everything cold,
 against a budget of twenty seconds here and about thirty from the system.
 `importScripts` from a dedicated worker does route through
 `WKURLSchemeHandler`, which is the assumption the whole shape rests on.

 One of those runs served **Ditto's own `sw.js`**, byte for byte, and the banner
 read what Ditto's worker composes for a `push`, down to the `Someone` it falls
 back to when it cannot resolve a profile. A service worker written against the
 standard, for Android, renders here unchanged.

 ## What it costs

 RunningBoard gives this extension a **hard 65 MB**, not the ~24 MB an app
 extension is usually said to get. The WebKit processes it spawns are not
 squeezed for being an extension's: `WebContent` is given 1536 MB soft,
 `Networking` 840, `GPU` 300, the ordinary numbers.

 ## More than one

 An extension is handed one piece of content to replace, so the first
 notification a worker asks for becomes the push's own, and every one after it
 — from the same worker, or from the next site's — is posted beside it with
 `UNUserNotificationCenter.add`, all before the handler is called.

 ## What is still missing

 - **A push no site claims** keeps Tenna's face, and so does one the worker
   ran out of time on: there is no site to show, or no time left to show it.
 - **A tap is not handled here.** It reaches the app, which runs the worker
   again for `notificationclick`. See `NappNotificationEvents`.
 */
class NotificationService: UNNotificationServiceExtension {

    /// How long the whole thing gets. The system's own budget is around thirty
    /// seconds and `serviceExtensionTimeWillExpire()` is the last word; this
    /// stops short of it so that a worker that hangs still loses to a
    /// deliberate hand-off rather than to the watchdog.
    ///
    /// Android gives a worker sixty seconds, and this deliberately does not
    /// follow it. There delivery runs inside a foreground service and the
    /// number is a choice about queue fairness; here it is most of a hard limit
    /// somebody else set. See NAPP.md.
    private static let budget: TimeInterval = 20

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler

        let content = (request.content.mutableCopy() as? UNMutableNotificationContent)
        self.fallback = content

        let info = request.content.userInfo

        // Anything missing or malformed means this push was not one of ours,
        // and the server's own text is already the right answer.
        guard let content,
              let eventId = info["event_id"] as? String,
              eventId.count == 64 else {
            contentHandler(request.content)
            return
        }

        let relays = (info["relays"] as? [Any] ?? []).compactMap { $0 as? String }
        let carried = NsiteEvent(info["event"])

        work = Task { @MainActor [weak self] in
            guard let self else { return }
            let started = Date()

            // The event first, because nothing can be decided without it.
            var event = carried
            if event == nil, !relays.isEmpty {
                event = NsiteEvent(await NsiteRelayFetch.event(id: eventId, relays: relays))
            }

            guard !Task.isCancelled else { return }

            let sites = event.map { Self.sites(for: $0) } ?? []
            guard let event, let first = sites.first else {
                NSLog("[NsiteNotify] no site claims %@", String(eventId.prefix(8)))
                self.deliver(content)
                return
            }

            guard let push = Self.payload(eventId: eventId, event: event.json, relays: relays) else {
                self.deliver(content)
                return
            }

            // Every site that asked for this event hears about it, one worker
            // after another, for as long as the budget lasts. The first
            // notification any of them asks for replaces the push's own
            // content; everything after it is posted beside it.
            var primary: UNNotificationContent?
            for (index, site) in sites.enumerated() {
                let left = Self.budget - Date().timeIntervalSince(started)
                if index > 0, left < 3 {
                    NSLog("[NsiteNotify] no time left for %d more site(s)", sites.count - index)
                    break
                }

                let host = NsiteWorkerHost(site: site)
                let notifications = await host.deliver(push: push, timeout: max(left, 2))
                guard !Task.isCancelled else { return }
                NSLog("[NsiteNotify] %@ returned %d notification(s)", site.siteId, notifications.count)

                for notification in notifications {
                    guard !Task.isCancelled else { return }
                    if primary == nil {
                        NappNotifications.apply(
                            to: content, siteId: site.siteId, label: site.label,
                            title: notification.title, options: notification.options)
                        primary = await NappNotifications.finished(
                            content, siteId: site.siteId, label: site.label, options: notification.options)
                    } else {
                        let extra = NappNotifications.content(
                            siteId: site.siteId, label: site.label,
                            title: notification.title, options: notification.options)
                        let finished = await NappNotifications.finished(
                            extra, siteId: site.siteId, label: site.label, options: notification.options)
                        _ = await NappNotifications.post(finished, siteId: site.siteId, tag: notification.tag)
                    }
                }
            }
            guard !Task.isCancelled else { return }

            // No worker had anything to say: the server's words stand, but in
            // the first site's row and wearing its face, so the row it lands
            // in and the tap that opens it are that site's.
            if primary == nil {
                content.threadIdentifier = first.siteId
                content.userInfo["site"] = first.siteId
                content.categoryIdentifier = await NappActions.category(for: [:])
                let face = await NappFaces.face(nil, siteId: first.siteId)
                primary = await NappNotifications.speaking(content, label: first.label, face: face)
            }
            guard !Task.isCancelled, let primary else { return }

            self.deliver(primary)
        }
    }

    // MARK: - Routing

    /**
     Which sites this event is for, in the order their workers are run.

     Every listening site whose own filters claim it. The push arrives once
     however many sites asked — that is what the merged registration is for —
     and is shared out here. Oldest record first, so the site that is run
     first, and gets the most of the budget, does not move around as sites are
     opened.
     */
    private static func sites(for event: NsiteEvent) -> [NsiteRecord] {
        NsiteStore.all()
            .filter { $0.listening }
            .sorted { $0.updatedAt < $1.updatedAt }
            .filter { site in site.filters.contains(where: { $0.matches(event) }) }
    }

    // MARK: - The payload

    /**
     The JSON a site's worker reads out of `event.data`.

     Assembled here rather than sent whole, so that the shape lives in one place
     on the device and the push server sends only the parts. See NAPP.md.
     */
    private static func payload(eventId: String,
                                event: [String: Any]?,
                                relays: [String]) -> String? {
        var message: [String: Any] = [
            "$type": "napp.push.payload",
            "event_id": eventId,
            "relays": relays,
        ]
        if let event, JSONSerialization.isValidJSONObject(event) {
            message["event"] = event
        }

        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        if let fallback {
            deliver(fallback)
        }
    }

    /// Answer iOS exactly once, whichever of the paths above gets here.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        // The process is about to be suspended or ended, and a suspended one
        // holding a lock on a file in the App Group is killed.
        NsiteIndexedDB.closeIdle()
        handler(content)
    }
}
