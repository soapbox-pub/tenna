import Foundation

/**
 A Nostr filter, and whether an event answers it.

 The extension has to decide **which site a push is for**, and nothing in the
 push says. The push service deliberately does not name one: a host running
 several sites behind one device token registers as a single client with every
 site's subscriptions merged, so that an event two sites both care about costs
 one push and one wake-up rather than two. Which means the split is the host's
 to make, here, against the same filters the site set. See the nostr-push NIP.

 Only what a relay indexes and what `normalizeNappSubscriptions` lets through:
 `ids`, `authors`, `kinds`, `since`, `until` and single-letter tag keys. A key
 this does not understand is treated as unsatisfiable rather than ignored —
 a filter narrowed by something we cannot check must not be widened by our not
 checking it.
 */
struct NsiteFilter {

    private let ids: Set<String>?
    private let authors: Set<String>?
    private let kinds: Set<Int>?
    private let since: Int?
    private let until: Int?
    /// Single-letter tag name to the values any one of which satisfies it.
    private let tags: [String: Set<String>]
    /// Set when the filter carried something we cannot evaluate.
    private let unsatisfiable: Bool

    // MARK: - Reading one

    init?(_ any: Any) {
        guard let object = any as? [String: Any] else { return nil }

        var ids: Set<String>?
        var authors: Set<String>?
        var kinds: Set<Int>?
        var since: Int?
        var until: Int?
        var tags: [String: Set<String>] = [:]
        var unsatisfiable = false
        var named = false

        for (key, value) in object {
            switch key {
            case "ids":
                ids = Self.strings(value)
                named = true
            case "authors":
                authors = Self.strings(value)
                named = true
            case "kinds":
                kinds = Set((value as? [Any] ?? []).compactMap { $0 as? Int })
                named = true
            case "since":
                since = (value as? NSNumber)?.intValue
            case "until":
                until = (value as? NSNumber)?.intValue
            case "limit":
                break
            default:
                if key.count == 2, key.hasPrefix("#") {
                    tags[String(key.dropFirst())] = Self.strings(value)
                    named = true
                } else {
                    // `search`, or anything a future Tenna lets a site write.
                    // A filter we only half understand is one we must not
                    // claim an event for.
                    unsatisfiable = true
                }
            }
        }

        // The same rule the web layer enforces: a filter naming nothing would
        // be every event the service sees.
        guard named else { return nil }

        self.ids = ids
        self.authors = authors
        self.kinds = kinds
        self.since = since
        self.until = until
        self.tags = tags
        self.unsatisfiable = unsatisfiable
    }

    private static func strings(_ value: Any) -> Set<String> {
        Set((value as? [Any] ?? []).compactMap { $0 as? String })
    }

    /// Every filter in a `NappSubscription[]`, flattened — which subscription a
    /// filter came from says nothing about whose event it is.
    static func all(in subscriptions: [Any]) -> [NsiteFilter] {
        subscriptions.flatMap { subscription -> [NsiteFilter] in
            guard let object = subscription as? [String: Any],
                  let filters = object["filters"] as? [Any] else { return [] }
            return filters.compactMap { NsiteFilter($0) }
        }
    }

    // MARK: - Matching

    func matches(_ event: NsiteEvent) -> Bool {
        if unsatisfiable { return false }
        if let ids, !ids.contains(event.id) { return false }
        if let authors, !authors.contains(event.pubkey) { return false }
        if let kinds, !kinds.contains(event.kind) { return false }
        if let since, event.createdAt < since { return false }
        if let until, event.createdAt > until { return false }

        for (name, wanted) in tags {
            var found = false
            for tag in event.tags where tag.count >= 2 && tag[0] == name {
                if wanted.contains(tag[1]) {
                    found = true
                    break
                }
            }
            if !found { return false }
        }

        return true
    }
}

/**
 A Nostr event, as much of one as matching needs.

 Deliberately not a full model: the extension never signs, never stores and
 never re-serializes an event, it only decides whether one is a given site's
 and then hands the original JSON to that site's worker. So the parsed form is
 the five fields a filter can ask about, and `json` is the object it came from.
 */
struct NsiteEvent {
    let id: String
    let pubkey: String
    let kind: Int
    let createdAt: Int
    let tags: [[String]]
    /// What the worker is given, unchanged.
    let json: [String: Any]

    init?(_ any: Any?) {
        guard let object = any as? [String: Any],
              let id = object["id"] as? String,
              let pubkey = object["pubkey"] as? String,
              let kind = (object["kind"] as? NSNumber)?.intValue,
              let createdAt = (object["created_at"] as? NSNumber)?.intValue else { return nil }

        self.id = id
        self.pubkey = pubkey
        self.kind = kind
        self.createdAt = createdAt
        self.tags = (object["tags"] as? [Any] ?? []).map { row in
            (row as? [Any] ?? []).compactMap { $0 as? String }
        }
        self.json = object
    }
}
