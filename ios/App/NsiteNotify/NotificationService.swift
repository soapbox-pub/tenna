import UserNotifications

/**
 Lets an nsite's own code say what its notification says.

 A push arrives for a site the user subscribed to, carrying a nostr event.
 Tenna does not know what the event means — only the site does, and the site's
 opinion lives in its service worker, the same worker that would be woken on
 Android. So this extension starts that worker, hands it the event as a `push`,
 and shows whatever it asked for.

 ## Why the fallback matters

 iOS will not let an extension modify a silent notification, and if this one
 does not answer in time "the system displays the original content". So the
 push always arrives as a complete, showable notification written by the push
 server — a placeholder the app chose when the site was subscribed, along the
 lines of "New activity on Foo" — and what happens here is an *override*. A
 worker that is slow, that throws, that has no `push` listener, or that runs
 out of memory costs the user a vaguer notification rather than no notification.

 That is also what keeps the push server ignorant: it never has to understand a
 nostr event, because it never has to write the text that a reader actually
 wants.

 ## What has been measured

 This has now run on a real iPhone, twice, out of real APNs pushes — which the
 simulator could never show. (`simctl push` never enters `didReceive`, and an
 app carrying `aps-environment` will not launch there at all, so the whole
 thing was unexercised until a device could be signed for push.)

 What SpringBoard says about it, both times:

 ```
 Received remote notification request … hasMutableContent: 1 pushType: Alert
 Will deliver mutated notification content; … runtime: 0.187876
 Delivered user visible push notification …
 ```

 — 0.188 seconds of it the first time and 0.197 the second, wake to shade.

 **Mutated** is the word that matters: what reached the shade was the worker's
 sentence and not the server's. Inside the extension, `Request replacement
 content` to `Received replacement content [ hasContent: 1 ]` took **110 ms**
 in one run and **117 ms** in the other, starting from a process spawned forty
 milliseconds earlier — everything cold, against a budget of twenty seconds
 here and about thirty from the system. `importScripts` from a dedicated worker
 does route through `WKURLSchemeHandler`, which is the assumption the whole
 shape rests on.

 The second run served **Ditto's own `sw.js`**, the file the nsite publishes,
 byte for byte, in place of `TestWorker.js` — and the banner read what Ditto's
 worker composes for a `push`, down to the `Someone` it falls back to when it
 cannot resolve a profile. A service worker written against the standard, for
 Android, renders here unchanged. It wants the same payload it gets there —
 `{ event, relay, subscription }`, see NAPP.md — which is what the push must
 carry in `event` for a site's own code to understand it.

 ## What it costs

 RunningBoard gives this extension a **hard 65 MB**, not the ~24 MB an app
 extension is usually said to get:

 ```
 pub.soapbox.tenna.notify Memory Limits: active 65 inactive 65
 pub.soapbox.tenna.notify set Memory Limits to Hard Inactive (65)
 ```

 And the WebKit processes the extension spawns are not squeezed for being an
 extension's: `WebContent` is given 1536 MB soft, `Networking` 840, `GPU` 300,
 the ordinary numbers. So both of the questions this could not answer before
 are answered — an extension may spawn them, and being their client costs them
 nothing. The renderer's own footprint was never the binding constraint.

 ## What is still missing

 Nobody can subscribe. The app asks for an APNs token in a `#if DEBUG` block
 and writes it to the log, because there is no push server to send it to and no
 per-site consent to attach it to. And the worker above is still the fixture in
 this bundle rather than the site's own file out of a shared container.
 */
class NotificationService: UNNotificationServiceExtension {

    /// How long the worker gets. The system's own budget is around thirty
    /// seconds and `serviceExtensionTimeWillExpire()` is the last word; this
    /// stops short of it so that a worker that hangs still loses to a
    /// deliberate hand-off rather than to the watchdog.
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
        NSLog("[NsiteNotify] didReceive site=%@", String(describing: info["site"]))

        // The site whose worker is to be asked, and what to ask it about.
        // Anything missing or malformed means this push was not one of ours,
        // and the server's own text is already the right answer.
        guard let content,
              let siteId = info["site"] as? String,
              NsiteOrigins.isSiteId(siteId),
              let event = info["event"] as? String else {
            contentHandler(request.content)
            return
        }

        work = Task { @MainActor [weak self] in
            guard let self else { return }

            let host = NsiteWorkerHost(siteId: siteId) { path, _ in
                Self.serve(siteId: siteId, path: path)
            }

            let notifications = await host.deliver(push: event, timeout: Self.budget)
            guard !Task.isCancelled else { return }
            NSLog("[NsiteNotify] worker returned %d notification(s)", notifications.count)

            // A worker with nothing to say is a worker that agrees with the
            // server. More than one is a worker asking for more notifications
            // than an extension is given: the first is shown and the rest are
            // dropped, which is a gap this has in common with nothing on
            // Android and will need `UNUserNotificationCenter.add`.
            if let first = notifications.first {
                content.title = first.title
                content.body = first.body
                if !first.tag.isEmpty { content.threadIdentifier = first.tag }
            }
            if notifications.count > 1 {
                NSLog("[NsiteNotify] worker asked for %d notifications; showing the first",
                      notifications.count)
            }

            self.deliver(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        if let fallback {
            deliver(fallback)
        }
    }

    /// Answer iOS exactly once, whichever of the two paths above gets here.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        handler(content)
    }

    // MARK: - Files

    /**
     The site's files.

     A placeholder while the renderer is being proved out: the worker script is
     a fixture in this bundle rather than the site's own, so that what is being
     tested is whether a worker can run here at all. The real one reads the
     manifest and the content-addressed blobs `NsiteFileServer` has already
     cached, out of a shared app group container — which is why the extension
     must never need the network to answer a push.
     */
    private static func serve(siteId: String, path: String) -> (Data, String)? {
        guard path == "/sw.js",
              let url = Bundle.main.url(forResource: "TestWorker", withExtension: "js"),
              let data = try? Data(contentsOf: url) else {
            return nil
        }
        return (data, "text/javascript; charset=utf-8")
    }
}
