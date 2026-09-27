import Foundation
import ImageIO
import Intents
import UniformTypeIdentifiers
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

 Every one is drawn as a message in the site's conversation, so the picture
 beside it is the notification's `icon`, or the site's own when it names none,
 rather than Tenna's. See `speaking`.

 Android goes further — the badge, pictures, buttons, replies. None of that has
 an iOS equivalent worth pretending to: `UNNotificationAttachment` wants a file
 on disk and reads nothing from a URL, and an action category has to be
 registered before the notification is posted rather than named by it. So
 `badge`, `image`, `actions`, `vibrate` and `renotify` are accepted and ignored
 here, and `NAPP.md` says so.
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

            Task {
                let face = await NappFaces.face(options["icon"] as? String, siteId: siteId)
                let spoken = await speaking(content, label: label, face: face)

                let request = UNNotificationRequest(
                    identifier: key(siteId: siteId, tag: tag),
                    content: spoken,
                    trigger: nil
                )

                UNUserNotificationCenter.current().add(request) { error in
                    if let error { NSLog("[NappPush] could not post: %@", error.localizedDescription) }
                    completion(error == nil)
                }
            }
        }
    }

    /**
     The content as a message in the site's conversation.

     This is about the picture on the left. An ordinary notification there is
     always the app's icon — Tenna's, whichever site it came from — and nothing
     set on the content changes that. A *communication* notification is the one
     layout that puts somebody else's face there, with the app's icon shrunk
     into its corner: the same bargain Android's conversation shortcut strikes.
     So the site is the conversation, named by its label, and the notification
     is a message in it, spoken by whoever its title names and wearing the
     notification's `icon` — or, lacking one, the site's own.

     The same reading of title and body as Android's: a notification with no
     body has only the one line to give, so the site says it rather than a name
     repeated twice.

     Anything that goes wrong leaves the content as it was, which is still the
     site's words, only under Tenna's face.
     */
    static func speaking(
        _ content: UNMutableNotificationContent,
        label: String,
        face: Data?
    ) async -> UNNotificationContent {
        let spoken = !content.body.isEmpty
        let name = spoken && !content.title.isEmpty ? content.title : label
        if !spoken { content.body = content.title }

        let image = face.map { INImage(imageData: $0) }
        let sender = INPerson(
            personHandle: INPersonHandle(value: "napp.sender.\(name)", type: .unknown),
            nameComponents: nil,
            displayName: name,
            image: image,
            contactIdentifier: nil,
            // By name, so the same sender across two notifications is the same
            // person to the system.
            customIdentifier: "napp.sender.\(name)"
        )

        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: INSpeakableString(spokenPhrase: label),
            conversationIdentifier: content.threadIdentifier,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        // The conversation's picture is the one drawn large; the sender's
        // alone would be drawn only in a conversation of one.
        if let image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        do {
            try await interaction.donate()
        } catch {
            NSLog("[NappPush] could not donate the conversation: %@", error.localizedDescription)
        }

        do {
            return try content.updating(from: intent)
        } catch {
            NSLog("[NappPush] not drawn as a conversation: %@", error.localizedDescription)
            return content
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
 The picture beside a notification.

 The iOS counterpart of `NappImages.java`, and the same three kinds of
 reference, in the order a site should reach for them:

 - A **site-absolute path** — `/icon-192.png` — served out of the site's own
   manifest and the shared blob cache, so it reaches no network this process
   did not already trust.
 - An **https URL**, unavoidable for a user's avatar. Fetched with as little of
   the device as possible: no cookies, no cache, an image content type, a size
   ceiling and a short timeout.
 - A **`data:` URL**, for a site that would rather do its own fetching.

 Whatever it is, it is decoded and redrawn small before it goes anywhere, so a
 reference that is not a picture is found out here and the site's own icon is
 drawn instead. Nothing ever falls back to Tenna's.
 */
enum NappFaces {

    private static let maxBytes = 2 * 1024 * 1024

    /// The notification's own picture takes this long at most. A face is worth
    /// a moment; it is not worth a notification that arrives late or not at all.
    private static let patience: TimeInterval = 5

    /// Faces are drawn small, and an extension is short of memory.
    private static let size = 256

    /// The notification's `icon`, or the site's own, or nothing.
    static func face(_ reference: String?, siteId: String) async -> Data? {
        if let reference, !reference.isEmpty,
           let bytes = await within(patience, { await picture(reference, siteId: siteId) }),
           let face = redrawn(bytes) {
            return face
        }
        return NsiteStore.icon(siteId)
    }

    private static func picture(_ reference: String, siteId: String) async -> Data? {
        if reference.hasPrefix("/"), !reference.hasPrefix("//") {
            // A query or fragment means nothing to a manifest.
            let path = String(reference.prefix { $0 != "?" && $0 != "#" })
            guard NsiteBlobs.isPath(path), let record = NsiteStore.load(siteId) else { return nil }
            let server = NsiteFileServer(files: record.files, servers: record.servers)
            return await server.file(path)?.0
        }

        if reference.hasPrefix("data:") {
            guard let comma = reference.firstIndex(of: ","),
                  reference[..<comma].hasSuffix(";base64") else { return nil }
            let data = Data(base64Encoded: String(reference[reference.index(after: comma)...]))
            return data.flatMap { $0.count <= maxBytes ? $0 : nil }
        }

        guard let url = URL(string: reference), url.scheme?.lowercased() == "https" else { return nil }
        guard let (data, response) = try? await session.data(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              // Redirects are followed, but only ever to https.
              http.url?.scheme?.lowercased() == "https",
              http.mimeType?.hasPrefix("image/") == true,
              data.count <= maxBytes else { return nil }
        return data
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = patience
        config.timeoutIntervalForResource = patience
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }()

    /// Decoded and drawn again at `size`, as a PNG, or nil if it is no picture.
    private static func redrawn(_ bytes: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: size,
              ] as CFDictionary) else { return nil }

        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    /// Whatever `work` answers within `seconds`, or nil.
    private static func within(
        _ seconds: TimeInterval,
        _ work: @escaping @Sendable () async -> Data?
    ) async -> Data? {
        await withTaskGroup(of: Data?.self) { group in
            group.addTask { await work() }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
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
