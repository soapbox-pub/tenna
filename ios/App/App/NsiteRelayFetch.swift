import Foundation

/**
 One event, by id, off whichever relay answers first.

 A push is about four kilobytes on every transport, so an event longer than
 that arrives as an id and the relays it was seen on — which is exactly what
 `NAPP.md` tells a site's worker to go and fetch it with. The difference on iOS
 is that the *host* has to fetch it too, and before the worker runs: the
 extension cannot tell whose push this is without the event to match against
 the sites' filters.

 Deliberately the smallest thing that can do it. One `REQ` per relay, raced,
 first `EVENT` wins, everything cancelled after. No `AUTH`, no reconnection, no
 subscription management: there is one question, it is asked once, and a few
 seconds later the answer either came or the notification goes out with the
 push server's own text.
 */
enum NsiteRelayFetch {

    /// How long the whole race gets. Spent out of the same twenty seconds the
    /// worker needs, so it is short on purpose.
    static let budget: TimeInterval = 5

    static func event(id: String, relays: [String], timeout: TimeInterval = budget) async -> [String: Any]? {
        let urls = relays.compactMap { text -> URL? in
            guard let url = URL(string: text),
                  url.scheme == "wss" || url.scheme == "ws" else { return nil }
            return url
        }
        guard !urls.isEmpty, id.count == 64 else { return nil }

        return await withTaskGroup(of: [String: Any]?.self) { group in
            for url in urls.prefix(4) {
                group.addTask { await ask(url, for: id, timeout: timeout) }
            }

            for await answer in group {
                if let answer {
                    group.cancelAll()
                    return answer
                }
            }
            return nil
        }
    }

    private static func ask(_ url: URL, for id: String, timeout: TimeInterval) async -> [String: Any]? {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)
        let socket = session.webSocketTask(with: url)
        socket.resume()

        defer {
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }

        let subscription = UUID().uuidString.prefix(8)
        let request = #"["REQ","\#(subscription)",{"ids":["\#(id)"]}]"#

        do {
            try await socket.send(.string(request))

            // A relay may send NOTICE, AUTH or anything else first, so this
            // reads until it sees the event, the end of stored events, or the
            // deadline — whichever comes first.
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                let message = try await socket.receive()
                guard case let .string(text) = message,
                      let data = text.data(using: .utf8),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [Any],
                      let kind = frame.first as? String else { continue }

                if kind == "EVENT", frame.count >= 3,
                   let event = frame[2] as? [String: Any],
                   event["id"] as? String == id {
                    return event
                }
                if kind == "EOSE" || kind == "CLOSED" { return nil }
            }
        } catch {
            return nil
        }

        return nil
    }
}
