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

 ## What is still missing

 - **One notification per push.** A worker asking for several gets the first
   shown and the rest dropped, because an extension is given one piece of
   content to replace. `UNUserNotificationCenter.add` would lift that.
 - **`notificationclick` in the worker.** A tap gets the app, not an extension,
   so routing is `data.url` and nothing else. See `AppDelegate`.
 - **Pictures and buttons.** An attachment wants a file on disk and an action
   category has to be registered in advance; neither is a thing a worker can ask
   for on the way past. See NAPP.md. The `icon` is the exception: it is drawn as
   the face of a communication notification, not attached. See
   `NappNotifications.speaking`.
 - **A push no site claims** keeps Tenna's face, and so does one the worker
   ran out of time on: there is no site to show, or no time left to show it.
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

            guard let event, let site = Self.site(for: event) else {
                NSLog("[NsiteNotify] no site claims %@", String(eventId.prefix(8)))
                self.deliver(content)
                return
            }

            guard let push = Self.payload(eventId: eventId, event: event.json, relays: relays) else {
                self.deliver(content)
                return
            }

            let server = NsiteFileServer(files: site.files, servers: site.servers)
            let host = NsiteWorkerHost(
                siteId: site.siteId,
                worker: site.worker ?? "/sw.js",
                periodicTags: site.periodicSync.map(\.tag)
            ) { path in
                await server.file(path)
            }

            let left = Self.budget - Date().timeIntervalSince(started)
            let notifications = await host.deliver(push: push, timeout: max(left, 2))
            guard !Task.isCancelled else { return }
            NSLog("[NsiteNotify] %@ returned %d notification(s)", site.siteId, notifications.count)

            // A worker with nothing to say is a worker that agrees with the
            // server. More than one is a worker asking for more notifications
            // than an extension is given: the first is shown and the rest are
            // dropped.
            if let first = notifications.first {
                NappNotifications.apply(
                    to: content,
                    siteId: site.siteId,
                    label: site.label,
                    title: first.title,
                    options: first.options
                )
            } else {
                // Even without a sentence of its own, the notification is this
                // site's: the row it lands in and the tap that opens it both
                // need saying so.
                content.threadIdentifier = site.siteId
                content.userInfo["site"] = site.siteId
            }

            if notifications.count > 1 {
                NSLog("[NsiteNotify] worker asked for %d notifications; showing the first",
                      notifications.count)
            }

            // Whoever wrote the words, the notification is this site's, and it
            // wears the site's face rather than Tenna's. See `speaking`.
            let face = await NappFaces.face(
                notifications.first?.options["icon"] as? String, siteId: site.siteId)
            guard !Task.isCancelled else { return }
            let spoken = await NappNotifications.speaking(content, label: site.label, face: face)
            guard !Task.isCancelled else { return }

            self.deliver(spoken)
        }
    }

    // MARK: - Routing

    /**
     Which site this event is for, or none.

     The first listening site whose own filters claim it. An event two sites
     both subscribed to is shown once, for the first of them — a second
     notification would need a second push, which is the cost the merged
     registration exists to avoid. Oldest record first, so the answer does not
     move around as sites are opened.
     */
    private static func site(for event: NsiteEvent) -> NsiteRecord? {
        let sites = NsiteStore.all()
            .filter { $0.listening }
            .sorted { $0.updatedAt < $1.updatedAt }

        for site in sites where site.filters.contains(where: { $0.matches(event) }) {
            return site
        }
        return nil
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
