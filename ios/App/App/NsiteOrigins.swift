import Foundation

/**
 Where an nsite lives, as far as the WebView is concerned.

 The same hostname Android serves a site on, under a different scheme. A
 `.localhost` name is treated as potentially trustworthy whatever the scheme —
 the rule is on the host, not on the scheme — so the document is a secure
 context and can use `crypto.subtle` exactly as it does on Android. Nothing
 resolves the name: every request is answered by `NsiteSchemeHandler` from the
 site's own manifest.

 The one thing this spelling cannot have is service workers, which WebKit
 withholds from any document whose scheme is not literally http or https. That
 is why the scheme is ours rather than `https`: `WKWebView` reserves http and
 https and refuses to install a `WKURLSchemeHandler` for either, so a custom
 scheme is not a preference here but the only option. What it costs is a site's
 own workers; what Android spends to keep them — a process-wide
 `ServiceWorkerClient` — has no WebKit equivalent to spend.

 Unlike the shared, public `iframe.diy` domain the iframe path uses, this
 origin is reachable only from inside this app's WebViews, so the site label
 can be the plain NIP-5A subdomain rather than an HMAC of it.
 */
enum NsiteOrigins {

    /// The scheme a site is served on. Anything but http and https, which
    /// `WKWebViewConfiguration.setURLSchemeHandler` refuses.
    static let scheme = "nsite"

    /// Parent domain for site origins. Shared with `NsiteOrigins.java`.
    static let siteDomain = "nsite.localhost"

    /**
     Whether a string is a site id: a DNS label, or `<dTag>.<npub>` for a named
     site whose `d` tag is too long to share a label with the base36 pubkey.

     The Swift side of `isNsiteId` in `src/lib/nsiteSubdomain.ts`.

     A named site's id carries its `d` tag, which is arbitrary text off a
     stranger's event, and the id is concatenated into a URL here. A tag
     carrying `/`, `\`, `?`, `#` or `@` names a host that is not ours, and the
     load that follows would put somebody else's page in the site's own window.
     */
    static func isSiteId(_ siteId: String?) -> Bool {
        guard let siteId else { return false }
        let labels = siteId.split(separator: ".", omittingEmptySubsequences: false)
        switch labels.count {
        case 1: return isLabel(Substring(siteId))
        case 2: return isLabel(labels[0]) && isNpub(labels[1])
        default: return false
        }
    }

    /// A DNS label: lowercase alphanumerics and inner hyphens, at most 63.
    private static func isLabel(_ label: Substring) -> Bool {
        guard !label.isEmpty, label.utf8.count <= 63 else { return false }

        let bytes = Array(label.utf8)
        func isAlnum(_ b: UInt8) -> Bool {
            (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)
        }
        guard isAlnum(bytes.first!), isAlnum(bytes.last!) else { return false }
        return bytes.allSatisfy { isAlnum($0) || $0 == 0x2d }
    }

    /// An npub's shape: `npub1` and 58 bech32 characters.
    private static func isNpub(_ label: Substring) -> Bool {
        let bech32 = Set("qpzry9x8gf2tvdw0s3jn54khce6mua7l".utf8)
        return label.utf8.count == 63
            && label.hasPrefix("npub1")
            && label.utf8.dropFirst(5).allSatisfy { bech32.contains($0) }
    }

    /**
     The host a site is served on.

     Refuses rather than lowercases anything that is not already a label: every
     id this app holds was produced by the web layer, which builds them
     lowercase, so a value needing the fold is a value from somewhere else.
     */
    static func hostFor(_ siteId: String) -> String? {
        guard isSiteId(siteId) else { return nil }
        return "\(siteId).\(siteDomain)"
    }

    /// The origin a site is served on.
    static func originFor(_ siteId: String) -> String? {
        guard let host = hostFor(siteId) else { return nil }
        return "\(scheme)://\(host)"
    }

    /// The URL a site's front page is served on.
    static func indexURL(_ siteId: String) -> URL? {
        guard let origin = originFor(siteId) else { return nil }
        return URL(string: origin + "/")
    }

    /**
     The site id a host names, or nil if it is not one of ours.

     Site ids are NIP-5A subdomains, which are lowercase by construction —
     bech32 and base36 both are, and a named site's `d` tag is part of a
     hostname — so whatever is left of the host is the id.
     */
    static func siteIdFor(host: String?) -> String? {
        guard let host else { return nil }
        let suffix = ".\(siteDomain)"
        let lower = host.lowercased()
        guard lower.hasSuffix(suffix) else { return nil }
        let label = String(lower.dropLast(suffix.count))
        return isSiteId(label) ? label : nil
    }
}
