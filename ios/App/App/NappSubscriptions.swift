import Foundation

/**
 What a site may ask to be told about, checked again on this side of the bridge.

 The Swift counterpart of `NappSubscriptions.java`, enforcing the same rules as
 `src/lib/nappSubscriptions.ts` for the same reason: what arrives over the
 bridge is whatever the web layer sent, and the web layer is a renderer running
 a stranger's page. Everything stored here ends up in a shared container that a
 notification extension reads with nobody watching, so the shape is settled
 before it is written and not after.

 `search` is kept, as it is on Android and in NAPP.md, even though the push
 service refuses it — see `NsiteFilter`, which treats a filter it cannot
 evaluate as one that claims nothing. A site may say it, and nothing will ever
 match it here.
 */
enum NappSubscriptions {

    /// Ceilings on what one site may ask for. Mirrored in the web layer.
    static let maxSubscriptions = 10
    static let maxFilters = 10
    static let maxRelays = 10
    static let maxList = 500

    struct Invalid: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: - JSON

    /// A JSON array or object, parsed, or nil if it is neither.
    static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func array(_ text: String) -> [Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [Any]
    }

    /// JSON text for anything serializable, or `"[]"` when it is not.
    static func text(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let out = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return out
    }

    // MARK: - Normalization

    static func normalize(_ text: String) throws -> [Any] {
        guard let input = array(text) else {
            throw Invalid(message: "Subscriptions must be a JSON array")
        }
        guard input.count <= maxSubscriptions else {
            throw Invalid(message: "At most \(maxSubscriptions) subscriptions")
        }

        var out: [Any] = []
        for (index, entry) in input.enumerated() {
            guard let subscription = entry as? [String: Any] else {
                throw Invalid(message: "Subscription \(index) is not an object")
            }

            guard let filters = subscription["filters"] as? [Any], !filters.isEmpty else {
                throw Invalid(message: "Each subscription needs at least one filter")
            }
            guard filters.count <= maxFilters else {
                throw Invalid(message: "At most \(maxFilters) filters per subscription")
            }

            guard let relays = subscription["relays"] as? [Any], !relays.isEmpty else {
                throw Invalid(message: "Each subscription needs at least one relay")
            }
            guard relays.count <= maxRelays else {
                throw Invalid(message: "At most \(maxRelays) relays per subscription")
            }

            let clean = try filters.map { try normalizeFilter($0, index) }
            let urls = try normalizeRelays(relays)
            out.append(["filters": clean, "relays": urls])
        }

        return out
    }

    private static func normalizeFilter(_ any: Any, _ index: Int) throws -> [String: Any] {
        guard let filter = any as? [String: Any] else {
            throw Invalid(message: "A filter in subscription \(index) is not an object")
        }

        var clean: [String: Any] = [:]
        var named = false

        for (key, value) in filter {
            switch key {
            case "ids", "authors":
                clean[key] = try strings(value, key)
                named = true
            case "kinds":
                guard let list = value as? [Any] else {
                    throw Invalid(message: "Filter kinds must be an array of integers")
                }
                let kinds = list.compactMap { ($0 as? NSNumber)?.intValue }
                guard kinds.count == list.count else {
                    throw Invalid(message: "Filter kinds must be an array of integers")
                }
                guard kinds.count <= maxList else {
                    throw Invalid(message: "Filter kinds is too long")
                }
                clean[key] = kinds
                named = true
            case "since", "until":
                guard let number = value as? NSNumber else {
                    throw Invalid(message: "Filter \(key) must be a number")
                }
                clean[key] = number.intValue
            case "search":
                guard let search = value as? String else {
                    throw Invalid(message: "Filter search must be a string")
                }
                clean[key] = search
                named = true
            case "limit":
                break
            default:
                guard key.count == 2, key.hasPrefix("#"),
                      let letter = key.last, letter.isLetter, letter.isASCII else {
                    throw Invalid(message: "Filter key \(key) is not supported")
                }
                clean[key] = try strings(value, key)
                named = true
            }
        }

        guard named else {
            throw Invalid(message: "A filter in subscription \(index) matches everything; "
                          + "name ids, authors, kinds, a tag or a search")
        }
        return clean
    }

    private static func strings(_ value: Any, _ key: String) throws -> [String] {
        guard let list = value as? [Any] else {
            throw Invalid(message: "Filter \(key) must be an array of strings")
        }
        let out = list.compactMap { $0 as? String }
        guard out.count == list.count else {
            throw Invalid(message: "Filter \(key) must be an array of strings")
        }
        guard out.count <= maxList else {
            throw Invalid(message: "Filter \(key) is too long")
        }
        return out
    }

    private static func normalizeRelays(_ relays: [Any]) throws -> [String] {
        var seen: Set<String> = []
        var out: [String] = []

        for entry in relays {
            guard let text = (entry as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let url = URL(string: text),
                  url.scheme == "wss" || url.scheme == "ws",
                  !(url.host ?? "").isEmpty else {
                throw Invalid(message: "Relays must be ws:// or wss:// URLs")
            }

            var trimmed = text
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            if seen.insert(trimmed).inserted { out.append(trimmed) }
        }

        return out
    }
}
