import Foundation

/**
 A `share_target` POST, delivered on iOS.

 On Android the site's own window submits the form and the site's service
 worker claims the navigation. Neither half exists here — a site under a
 custom scheme has no service worker to claim anything — so the site's worker
 is run the way a push runs it, and handed the form as a `fetch` event (see
 `sharePost` in `NsiteWorkerShim.js`). What it answers is then put in the
 site's window: a redirect is followed, and anything else is shown at the
 action, served once by the site's scheme handler.

 A site whose worker does not answer gets the page Android gives it, saying
 it cannot receive shares.
 */
@MainActor
enum NsiteShareDelivery {

    /// As long as a push gets.
    private static let budget: TimeInterval = 20

    /// A response waiting for the site's window to ask for it.
    struct Answer {
        let status: Int
        let headers: [String: String]
        let body: Data
    }

    private static var waiting: [String: (target: String, answer: Answer)] = [:]

    /// Run the site's worker on the share and say which URL to load.
    static func deliver(siteId: String, token: String, plan: String) async -> URL? {
        defer { NsiteShares.release(token) }

        guard let origin = NsiteOrigins.originFor(siteId),
              let object = NappSubscriptions.object(plan),
              let action = object["action"] as? String, action.hasPrefix("/"), !action.hasPrefix("//"),
              let target = URL(string: origin + action) else { return nil }

        var answer: Answer?
        if let site = NsiteStore.load(siteId), site.files[site.worker ?? "/sw.js"] != nil {
            let host = NsiteWorkerHost(site: site)
            host.shareToken = token
            _ = await host.deliver(kind: "sharepost", data: plan, timeout: budget)
            NsiteIndexedDB.closeIdle()

            if let response = host.response, response["none"] == nil,
               let status = (response["status"] as? NSNumber)?.intValue {
                let headers = (response["headers"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
                let body = (response["body"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()

                // A redirect is followed, as a browser would, if it stays on the site.
                if (300...399).contains(status),
                   let location = headers.first(where: { $0.key.lowercased() == "location" })?.value,
                   let next = URL(string: location, relativeTo: target)?.absoluteURL,
                   next.scheme == target.scheme, next.host == target.host {
                    return next
                }
                answer = Answer(status: status, headers: headers, body: body)
            } else if let error = host.response?["error"] as? String {
                NSLog("[NsiteShareDelivery] %@ did not answer the share: %@", siteId, error)
            }
        }

        waiting[siteId] = (target.absoluteString, answer ?? refusal)
        return target
    }

    /// What the site's window should be shown at `url`, once, if anything.
    static func take(siteId: String, url: URL) -> Answer? {
        guard let entry = waiting[siteId], entry.target == url.absoluteString else { return nil }
        waiting.removeValue(forKey: siteId)
        return entry.answer
    }

    private static let refusal = Answer(
        status: 200,
        headers: ["Content-Type": "text/html; charset=utf-8"],
        body: Data("""
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Sharing</title>
        <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
        padding:2rem;box-sizing:border-box;background:#150609;color:#7CFC9B;font:1rem/1.6 system-ui,sans-serif;\
        text-align:center"><p>This site can’t receive shares.</p></body>
        """.utf8)
    )
}
