import CryptoKit
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

 The `image` is fetched and attached, and drawn when the notification is
 expanded. The `actions` become buttons and reply boxes: a category has to be
 registered before a notification can name it, so one is registered on the way
 past for every distinct set of buttons — see `NappActions`. `renotify` is
 honoured by posting a quiet replacement. `badge` and `vibrate` have nothing to
 map to: iOS draws no per-notification mark in a status bar, and a vibration
 pattern is the system's. `NAPP.md` says so.

 A notification a push put in the shade is filed under the identifier APNs
 gave it, not `site|tag`, because the extension can only replace the content of
 the request it was handed. So everything that finds a site's notifications —
 listing, closing, replacing by tag — goes by the `site` and `tag` in its
 `userInfo`, which every notification of a site's carries whoever posted it.
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
                let spoken = await finished(content, siteId: siteId, label: label, options: options)
                completion(await post(spoken, siteId: siteId, tag: tag))
            }
        }
    }

    /// Put finished content in the shade, filed under the site and its tag.
    static func post(_ content: UNNotificationContent, siteId: String, tag: String) async -> Bool {
        let request = UNNotificationRequest(identifier: key(siteId: siteId, tag: tag), content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            NSLog("[NappPush] could not post: %@", error.localizedDescription)
            return false
        }
    }

    /**
     Everything about a notification that takes a moment: its buttons, its
     picture, its face, and whether it quietly replaces one already there.

     The one path every notification of a site's goes through, from its window,
     from a push, from a background run, so they are the same kind of thing.
     */
    static func finished(
        _ content: UNMutableNotificationContent,
        siteId: String,
        label: String,
        options: [String: Any]
    ) async -> UNNotificationContent {
        content.categoryIdentifier = await NappActions.category(for: options)

        if let image = options["image"] as? String, !image.isEmpty,
           let attachment = await NappFaces.attachment(image, siteId: siteId) {
            content.attachments = [attachment]
        }

        // The standard's `tag`: a later notification replaces the earlier one,
        // and says nothing about it unless it was asked to `renotify`.
        let tag = options["tag"] as? String ?? ""
        if !tag.isEmpty, await replace(siteId: siteId, tag: tag),
           !((options["renotify"] as? Bool) ?? false) {
            content.sound = nil
            content.interruptionLevel = .passive
        }

        let face = await NappFaces.face(options["icon"] as? String, siteId: siteId)
        return await speaking(content, label: label, face: face)
    }

    /**
     Take down the site's notifications with this tag, and say whether there
     were any.

     `show` would replace one it posted itself by identifier anyway; this is
     for the ones it did not, which a push filed under APNs's identifier.
     */
    static func replace(siteId: String, tag: String) async -> Bool {
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        let keys = delivered
            .filter { belongs($0, to: siteId) && $0.request.content.userInfo["tag"] as? String == tag }
            .map { $0.request.identifier }
        guard !keys.isEmpty else { return false }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: keys)
        return true
    }

    private static func belongs(_ notification: UNNotification, to siteId: String) -> Bool {
        let content = notification.request.content
        return content.threadIdentifier == siteId || content.userInfo["site"] as? String == siteId
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
            // As the site gave it. The content's own title is rewritten on the
            // way to the shade — see `speaking` — and a worker handed this
            // notification back on a tap should see what it wrote.
            "title": title,
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
                .filter { belongs($0, to: siteId) }
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
            "title": content.userInfo["title"] as? String ?? content.title,
            "tag": content.userInfo["tag"] as? String ?? "",
            "options": options,
        ]
    }

    // MARK: - Taking them down

    static func close(siteId: String, key: String) {
        // Its own only. The key came from the site, and a site must not be able
        // to clear a neighbour's row by guessing one.
        if self.siteId(ofKey: key) == siteId {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
            return
        }
        // One a push posted, under APNs's identifier: the site's if the
        // notification says so, which is the site's own claim to it.
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            guard delivered.contains(where: { $0.request.identifier == key && belongs($0, to: siteId) }) else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
        }
    }

    static func closeAll(siteId: String) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let keys = delivered
                .filter { belongs($0, to: siteId) }
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
        redrawn(bytes, size: size)?.data
    }

    /**
     Decoded and drawn again no larger than `size` on its longer side: a PNG
     if it has any transparency to keep, a JPEG if it has none.
     */
    private static func redrawn(_ bytes: Data, size: Int) -> (data: Data, type: UTType)? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: size,
              ] as CFDictionary) else { return nil }

        let opaque = [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
        let type: UTType = opaque ? .jpeg : .png
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, opaque
            ? [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary
            : nil)
        return CGImageDestinationFinalize(destination) ? (out as Data, type) : nil
    }

    /// The notification's `image`, drawn larger than a face and shown when
    /// it is expanded.
    private static let pictureSize = 1024

    /**
     The notification's `image`, as a file the system can attach, or nil.

     The same three kinds of reference as a face, fetched the same careful way
     and redrawn the same way, so what reaches the notification is a picture
     Tenna drew and not bytes a stranger chose. The system moves the file into
     its own store when the notification is posted.
     */
    static func attachment(_ reference: String, siteId: String) async -> UNNotificationAttachment? {
        guard let bytes = await within(patience, { await picture(reference, siteId: siteId) }),
              let (data, type) = redrawn(bytes, size: pictureSize),
              let ext = type.preferredFilenameExtension else { return nil }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("napp-\(UUID().uuidString).\(ext)")
        do {
            try data.write(to: url)
            return try UNNotificationAttachment(identifier: "image", url: url, options: [
                UNNotificationAttachmentOptionsTypeHintKey: type.identifier,
            ])
        } catch {
            NSLog("[NappPush] could not attach the image: %@", error.localizedDescription)
            try? FileManager.default.removeItem(at: url)
            return nil
        }
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

/**
 A notification's `actions`, as the buttons under it.

 On Android a button is part of the notification. Here it belongs to a
 *category*, registered with the notification center before the notification
 that names it is posted — and a site's buttons are whatever its worker says
 they are this time. So a category is registered on the way past for each
 distinct set, named by a hash of what is in it, and every later notification
 with the same buttons reuses it.

 Every category also asks for the dismiss action, so a swipe reaches the app
 and the worker gets `notificationclose`. A notification with no buttons gets
 the plain one for that alone.

 A button's `icon` has nowhere to go: `UNNotificationActionIcon` takes an SF
 Symbol or a picture in the app bundle, not one from a site.
 */
enum NappActions {

    /// The category of a notification with no buttons.
    static let plain = "napp"

    /// What a button's identifier starts with, so no site's action can be
    /// mistaken for the system's default and dismiss identifiers.
    static let actionPrefix = "napp.action:"

    private static let categoryPrefix = "napp.buttons."

    /// As many as Android draws.
    private static let maxActions = 3
    private static let maxId = 128
    private static let maxName = 64

    /// Categories of buttons kept registered at once. Past this, the least
    /// recently wanted give way; a notification still in the shade whose
    /// category went keeps its words and loses its buttons.
    private static let maxCategories = 32

    struct Action: Equatable {
        let action: String
        let title: String
        let input: Bool
        let placeholder: String?
    }

    static func actions(in options: [String: Any]) -> [Action] {
        var out: [Action] = []
        for entry in options["actions"] as? [Any] ?? [] {
            guard out.count < maxActions,
                  let entry = entry as? [String: Any],
                  let action = (entry["action"] as? String).map({ String($0.prefix(maxId)) }), !action.isEmpty,
                  let title = (entry["title"] as? String).map({ String($0.prefix(maxName)) }), !title.isEmpty
            else { continue }
            let input = entry["type"] as? String == "text"
            out.append(Action(
                action: action,
                title: title,
                input: input,
                placeholder: input ? (entry["placeholder"] as? String).map { String($0.prefix(maxName)) } : nil
            ))
        }
        return out
    }

    /// The site's own name for a button pressed, or nil for a system action.
    static func action(fromIdentifier identifier: String) -> String? {
        identifier.hasPrefix(actionPrefix) ? String(identifier.dropFirst(actionPrefix.count)) : nil
    }

    /// The category to post a notification with these options under,
    /// registered by the time this returns.
    static func category(for options: [String: Any]) async -> String {
        let actions = actions(in: options)
        guard !actions.isEmpty else {
            await registry.ensure(plain, UNNotificationCategory(
                identifier: plain, actions: [], intentIdentifiers: [], options: [.customDismissAction]))
            return plain
        }

        var fingerprint = ""
        for action in actions {
            fingerprint += "\(action.action)\u{0}\(action.title)\u{0}\(action.input)\u{0}\(action.placeholder ?? "")\u{1}"
        }
        let identifier = categoryPrefix + SHA256.hash(data: Data(fingerprint.utf8))
            .prefix(12).map { String(format: "%02x", $0) }.joined()

        let buttons: [UNNotificationAction] = actions.map { action in
            let id = actionPrefix + action.action
            // No `.foreground`: pressing a button is answered by the worker,
            // as on Android, and does not bring Tenna up over what the user
            // was doing.
            if action.input {
                return UNTextInputNotificationAction(
                    identifier: id, title: action.title, options: [],
                    textInputButtonTitle: "Send",
                    textInputPlaceholder: action.placeholder ?? "")
            }
            return UNNotificationAction(identifier: id, title: action.title, options: [])
        }
        await registry.ensure(identifier, UNNotificationCategory(
            identifier: identifier, actions: buttons, intentIdentifiers: [], options: [.customDismissAction]))
        return identifier
    }

    private static let registry = Registry()

    /// One at a time, because registering is a read and a write of the whole set.
    private actor Registry {
        /// Most recently wanted last.
        private var recent: [String] = []

        func ensure(_ identifier: String, _ category: UNNotificationCategory) async {
            recent.removeAll { $0 == identifier }
            recent.append(identifier)

            let center = UNUserNotificationCenter.current()
            var categories = await center.notificationCategories()
            if categories.contains(where: { $0.identifier == identifier }) { return }

            categories.insert(category)
            let ours = categories.filter { $0.identifier.hasPrefix(categoryPrefix) }
            if ours.count > maxCategories {
                // Oldest first: ones this process has not wanted, then the
                // least recently wanted.
                let order = ours.sorted { (recent.firstIndex(of: $0.identifier) ?? -1) < (recent.firstIndex(of: $1.identifier) ?? -1) }
                for stale in order.prefix(ours.count - maxCategories) where stale.identifier != identifier {
                    categories.remove(stale)
                }
            }
            center.setNotificationCategories(categories)
        }
    }
}
