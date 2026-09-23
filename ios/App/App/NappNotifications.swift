import Foundation
import UserNotifications

/**
 One site's row in the shade, and everything that puts something in it.

 The iOS counterpart of `NappNotifications.java`, and the meeting point the same
 way: a notification posted from a site's own window and one written by its
 service worker inside `NotificationService` are the same kind of thing, land in
 the same place, and are tagged, replaced, listed and closed by the same rules.
 There is no second kind.

 ## What a site gets, and what it does not

 A `UNNotificationRequest` identifier is what `tag` becomes, so a later
 notification with the same tag replaces the earlier one exactly as the standard
 says. `threadIdentifier` is the site, which is how iOS groups a site's
 notifications together and how `unread` and `getNotifications` find a site's own
 without seeing anybody else's.

 Android goes much further — the conversation layout, the site's icon, the
 badge, pictures, buttons, replies. None of that has an iOS equivalent worth
 pretending to: `UNNotificationAttachment` wants a file on disk and reads
 nothing from a URL, and an action category has to be registered before the
 notification is posted rather than named by it. So `icon`, `badge`, `image`,
 `actions`, `vibrate` and `renotify` are accepted and ignored here, and
 `NAPP.md` says so.
 */
enum NappNotifications {

    /// The identifier a notification is filed under: the site, then its tag.
    ///
    /// A site id is a DNS label, so it can never contain the separator and the
    /// split is unambiguous however strange the tag is.
    static func key(siteId: String, tag: String) -> String {
        "\(siteId)|\(tag.isEmpty ? "#" + UUID().uuidString : tag)"
    }

    static func siteId(ofKey key: String) -> String? {
        guard let index = key.firstIndex(of: "|") else { return nil }
        return String(key[key.startIndex..<index])
    }

    // MARK: - Whether anything could be shown at all

    private static let lock = NSLock()
    private static var cachedEnabled = true

    /**
     Whether the OS will show a notification from Tenna, as last asked.

     Cached because it is needed **synchronously**: it is half of what
     `Notification.permission` reads, and that is a getter a site calls at the
     top of its own file, before anything of Tenna's could have gone and asked.
     See `NSITE_NOTIFY_DEVICE_PLACEHOLDER`.

     Optimistic until asked, which is the safer wrong answer: a site told
     `default` goes on and asks, and is corrected; one told `denied` gives up on
     a permission it could have had.
     */
    static var enabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cachedEnabled
    }

    /// Ask the system and remember. Cheap, and the answer changes behind our
    /// back whenever the user visits Settings.
    static func refresh(_ completion: ((Bool) -> Void)? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let granted = settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional
            lock.lock()
            cachedEnabled = granted
            lock.unlock()
            completion?(granted)
        }
    }

    // MARK: - Posting

    static func show(
        siteId: String,
        label: String,
        title: String,
        options: [String: Any],
        completion: @escaping (Bool) -> Void
    ) {
        refresh { granted in
            guard granted else {
                completion(false)
                return
            }

            let tag = options["tag"] as? String ?? ""
            let content = self.content(
                siteId: siteId, label: label, title: title, options: options)

            let request = UNNotificationRequest(
                identifier: key(siteId: siteId, tag: tag),
                content: content,
                trigger: nil
            )

            UNUserNotificationCenter.current().add(request) { error in
                if let error { NSLog("[NappPush] could not post: %@", error.localizedDescription) }
                completion(error == nil)
            }
        }
    }

    /**
     The content, which the extension builds too.

     Shared so that a notification a worker wrote is byte for byte the kind a
     window writes: the same `userInfo` keys, so a tap routes the same way, and
     the same thread, so it lands in the same row.
     */
    static func content(
        siteId: String,
        label: String,
        title: String,
        options: [String: Any]
    ) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        apply(to: content, siteId: siteId, label: label, title: title, options: options)
        return content
    }

    static func apply(
        to content: UNMutableNotificationContent,
        siteId: String,
        label: String,
        title: String,
        options: [String: Any]
    ) {
        // A notification with no body has only its title to give, so the site
        // speaks and the title is the words — the same reading Android takes.
        let body = options["body"] as? String ?? ""
        content.title = title.isEmpty ? label : title
        content.body = body
        content.threadIdentifier = siteId
        if !((options["silent"] as? Bool) ?? false) {
            content.sound = .default
        }

        var info: [String: Any] = [
            "site": siteId,
            "tag": options["tag"] as? String ?? "",
            // As text, because `userInfo` takes property-list values only and
            // a site's `data` is whatever JSON it liked.
            "options": NappSubscriptions.text(options),
        ]
        // The convention every push service worker on Nostr already writes, and
        // the only thing that can route a tap with no worker alive to route it.
        if let data = options["data"] as? [String: Any],
           let url = data["url"] as? String, url.hasPrefix("/") {
            info["url"] = url
        }
        content.userInfo = info
    }

    // MARK: - Reading back

    static func list(siteId: String, tag: String?, completion: @escaping ([[String: Any]]) -> Void) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let records = delivered
                .filter { $0.request.content.threadIdentifier == siteId }
                .compactMap { record($0) }
                .filter { tag == nil || $0["tag"] as? String == tag }
            completion(records)
        }
    }

    /// Which sites have anything in the shade right now.
    static func sites(completion: @escaping (Set<String>) -> Void) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            completion(Set(delivered.map { $0.request.content.threadIdentifier }
                .filter { !$0.isEmpty }))
        }
    }

    /// The shape `NappNotification` in the provider script reads.
    private static func record(_ notification: UNNotification) -> [String: Any]? {
        let content = notification.request.content
        let options = (content.userInfo["options"] as? String)
            .flatMap { NappSubscriptions.object($0) } ?? ["body": content.body]

        return [
            "key": notification.request.identifier,
            "title": content.title,
            "tag": content.userInfo["tag"] as? String ?? "",
            "options": options,
        ]
    }

    // MARK: - Taking them down

    static func close(siteId: String, key: String) {
        // Its own only. The key came from the site, and a site must not be able
        // to clear a neighbour's row by guessing one.
        guard self.siteId(ofKey: key) == siteId else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
    }

    static func closeAll(siteId: String) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let keys = delivered
                .filter { $0.request.content.threadIdentifier == siteId }
                .map { $0.request.identifier }
            guard !keys.isEmpty else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: keys)
        }
    }
}

/**
 The APNs device token, and which host minted it.

 The token is what the push service registers a client against, so it is the one
 thing that has to travel from `AppDelegate` to the web layer. It arrives
 asynchronously and may never arrive at all — a refusal, airplane mode, a
 simulator — so `whenAvailable` is bounded and answers nil rather than leaving a
 promise open forever.
 */
enum NappTokens {

    private static let lock = NSLock()
    private static var token: String?
    private static var waiting: [(String?) -> Void] = []

    /// How long a caller waits for a token that has not landed yet.
    private static let patience: TimeInterval = 15

    static var current: String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    /// Registration answered, one way or the other.
    static func resolve(_ value: String?) {
        lock.lock()
        if let value { token = value }
        let callbacks = waiting
        waiting = []
        lock.unlock()

        for callback in callbacks { callback(value) }
    }

    static func whenAvailable(_ callback: @escaping (String?) -> Void) {
        lock.lock()
        if let token {
            lock.unlock()
            callback(token)
            return
        }
        var answered = false
        let once: (String?) -> Void = { value in
            guard !answered else { return }
            answered = true
            callback(value)
        }
        waiting.append(once)
        lock.unlock()

        DispatchQueue.main.asyncAfter(deadline: .now() + patience) { once(current) }
    }

    /**
     `"sandbox"` or `"production"`, read off the provisioning profile.

     A token is minted against one APNs host and rejected by the other, and the
     push service is told which at registration. What decides it is the
     `aps-environment` entitlement the build was signed with — `development`
     for anything run from Xcode, `production` for TestFlight and the App
     Store — and the profile embedded in the bundle is where that is written
     down. An App Store build has no embedded profile at all, and those are
     production.
     */
    static let environment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let key = text.range(of: "<key>aps-environment</key>") else {
            return "production"
        }

        let tail = text[key.upperBound...]
        guard let open = tail.range(of: "<string>"),
              let close = tail.range(of: "</string>"),
              open.upperBound <= close.lowerBound else {
            return "production"
        }

        return tail[open.upperBound..<close.lowerBound] == "development" ? "sandbox" : "production"
    }()
}
