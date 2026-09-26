import Foundation

/**
 What a site needs written down for a push to reach it.

 The iOS counterpart of `NsiteSites.java` and `NappSubscriptions.java`, in one
 file because on this platform they are read by one thing: a notification
 service extension with about twenty seconds, no app around it, and no way to
 ask anybody anything. Everything it needs is either here or lost.

 A record holds the site's **manifest**, so its worker and any picture the
 worker names can be served without a relay; its **worker path**, because a
 document under a custom scheme cannot register a real service worker and the
 one the site asked for is otherwise nowhere (see `NsiteOrigins`); its
 **subscriptions**, which are how the extension works out that a push is this
 site's and not a neighbour's; whether the user has **muted** it; and the
 **periodic sync** tags it registered, which the main app's background refresh
 task reads (see `NappPeriodicSync`).

 Records live in the App Group container as one JSON file per site, named by
 the site id. An id is a DNS label — `NsiteOrigins.isSiteId` — so it is already
 a safe file name, and unlike Android there is no `d` tag to hash around.
 */
struct NsiteRecord {

    var siteId: String
    var label: String
    /// Manifest path (`/index.html`) to sha256.
    var files: [String: String]
    /// Blossom servers to fetch the blobs from.
    var servers: [String]
    /// What the site passed to `navigator.serviceWorker.register`, if it has.
    var worker: String?
    /// `NappSubscription[]` as the site set them, normalized.
    var subscriptions: [Any]
    /// The user's answer, which outlives whatever the site sets.
    var muted: Bool
    /// What the site passed to `registration.periodicSync.register`.
    var periodicSync: [NsitePeriodicTag] = []
    var updatedAt: Double

    /// Every filter the site is listening on, for routing a push.
    var filters: [NsiteFilter] { NsiteFilter.all(in: subscriptions) }

    /// Whether this site would take a push at all right now.
    var listening: Bool { !muted && !subscriptions.isEmpty }
}

/// One `registration.periodicSync` tag.
struct NsitePeriodicTag {
    var tag: String
    /// Seconds, already rounded up to the floor.
    var minInterval: TimeInterval
    /// When it last ran, or was registered if it never has. Seconds since 1970.
    var lastRun: TimeInterval

    init(tag: String, minInterval: TimeInterval, lastRun: TimeInterval) {
        self.tag = tag
        self.minInterval = minInterval
        self.lastRun = lastRun
    }

    init?(_ object: Any) {
        guard let object = object as? [String: Any],
              let tag = object["tag"] as? String, !tag.isEmpty else { return nil }
        self.tag = tag
        self.minInterval = (object["minInterval"] as? NSNumber)?.doubleValue ?? 0
        self.lastRun = (object["lastRun"] as? NSNumber)?.doubleValue ?? 0
    }

    var json: [String: Any] {
        ["tag": tag, "minInterval": minInterval, "lastRun": lastRun]
    }
}

enum NsiteStore {

    /// One file per site, in the shared container.
    private static var directory: URL { NsiteGroup.directory("nsite-sites") }

    private static func url(_ siteId: String) -> URL? {
        guard NsiteOrigins.isSiteId(siteId) else { return nil }
        return directory.appendingPathComponent("\(siteId).json", isDirectory: false)
    }

    // MARK: - Reading

    static func load(_ siteId: String) -> NsiteRecord? {
        guard let url = url(siteId),
              let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return decode(object, siteId: siteId)
    }

    /// Every site with a record, in no particular order.
    static func all() -> [NsiteRecord] {
        let names = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil)) ?? []

        return names.compactMap { url in
            guard url.pathExtension == "json" else { return nil }
            return load(url.deletingPathExtension().lastPathComponent)
        }
    }

    private static func decode(_ object: [String: Any], siteId: String) -> NsiteRecord {
        var files: [String: String] = [:]
        for (path, value) in object["files"] as? [String: Any] ?? [:] {
            // Filtered again on the way out. The manifest is a stranger's
            // event, and this is the process that turns it into a path.
            guard let sha256 = value as? String,
                  NsiteBlobs.isPath(path), NsiteBlobs.isName(sha256) else { continue }
            files[path] = sha256
        }

        return NsiteRecord(
            siteId: siteId,
            label: object["label"] as? String ?? siteId,
            files: files,
            servers: (object["servers"] as? [Any] ?? []).compactMap { value in
                guard let text = value as? String,
                      URL(string: text)?.scheme == "https" else { return nil }
                return text
            },
            worker: (object["worker"] as? String).flatMap { NsiteBlobs.isPath($0) ? $0 : nil },
            subscriptions: object["subscriptions"] as? [Any] ?? [],
            muted: object["muted"] as? Bool ?? false,
            periodicSync: (object["periodicSync"] as? [Any] ?? []).compactMap { NsitePeriodicTag($0) },
            updatedAt: (object["updatedAt"] as? NSNumber)?.doubleValue ?? 0
        )
    }

    // MARK: - Writing

    @discardableResult
    static func save(_ record: NsiteRecord) -> Bool {
        guard let url = url(record.siteId) else { return false }

        var object: [String: Any] = [
            "siteId": record.siteId,
            "label": record.label,
            "files": record.files,
            "servers": record.servers,
            "subscriptions": record.subscriptions,
            "muted": record.muted,
            "periodicSync": record.periodicSync.map(\.json),
            "updatedAt": Date().timeIntervalSince1970,
        ]
        if let worker = record.worker { object["worker"] = worker }

        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return false
        }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /**
     Change one site's record, making it if there isn't one.

     Everything that writes goes through here, so a site that subscribes before
     anything has drawn it — a link followed straight into a window — still ends
     up with a record rather than silently failing to be woken.
     */
    @discardableResult
    static func update(_ siteId: String, _ change: (inout NsiteRecord) -> Void) -> NsiteRecord? {
        guard NsiteOrigins.isSiteId(siteId) else { return nil }

        var record = load(siteId) ?? NsiteRecord(
            siteId: siteId,
            label: siteId,
            files: [:],
            servers: [],
            worker: nil,
            subscriptions: [],
            muted: false,
            updatedAt: 0
        )

        change(&record)
        guard save(record) else { return nil }
        return record
    }

    static func remove(_ siteId: String) {
        guard let url = url(siteId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - The merged list

    /**
     Every listening site's subscriptions, as one list, as JSON text.

     What goes to the push service. A host running several sites behind one
     device token is **one client** there — the service pushes an event to a
     client at most once, so merging is what keeps an event two sites both want
     to one push and one wake-up. Muted sites are left out entirely, which is
     what makes muting reach past the shade and stop the traffic.

     Capped at the service's ceiling of a hundred, oldest sites first, so that
     one site with ten subscriptions cannot silence the rest by arriving late.
     */
    static func merged(limit: Int = 100) -> String {
        var out: [Any] = []

        for record in all().filter({ $0.listening }).sorted(by: { $0.updatedAt < $1.updatedAt }) {
            for subscription in record.subscriptions {
                if out.count >= limit { break }
                out.append(subscription)
            }
        }

        guard JSONSerialization.isValidJSONObject(out),
              let data = try? JSONSerialization.data(withJSONObject: out),
              let text = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return text
    }
}
