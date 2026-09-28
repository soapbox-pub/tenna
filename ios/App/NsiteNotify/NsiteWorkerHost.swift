import Foundation
import WebKit

/**
 Runs an nsite's service worker, with no window and no app around it.

 The iOS answer to `NappWakeWebView.java`, and it exists for the same reason:
 nothing native can start a service worker, only a document at the worker's
 origin can. So there is a document — one of Tenna's, at the site's origin,
 whose whole job is to make the worker and carry messages to and from it.

 Where Android's lives in a foreground service that is already running, this
 one is built from nothing inside a `UNNotificationServiceExtension`, which is
 the only code iOS will run before a notification is shown. Everything about
 the shape below follows from that: there are about thirty seconds, a hard
 memory ceiling, and exactly one chance.

 What runs is not a real service worker — WebKit will not register one for a
 document whose scheme is not http or https, and `WKWebView` will not let us
 answer for either. It is a dedicated worker with `registration`, `clients` and
 the push events shimmed around it, which is what `NsiteWorkerShim.js` is. The
 site's own script is what decides what the notification says, which is the
 whole point.
 */
@MainActor
final class NsiteWorkerHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {

    /// What a worker asked to be shown: `showNotification(title, options)`,
    /// with the options kept whole so the tray can read `data.url` off them
    /// and a tap can be routed the way it is on Android. See `NappNotifications`.
    struct Notification {
        let title: String
        let options: [String: Any]

        var body: String { options["body"] as? String ?? "" }
        var tag: String { options["tag"] as? String ?? "" }
    }

    /// The path the host page is served on. Tenna's, not the site's, so it is
    /// under a prefix a site has no business publishing to.
    static let hostPath = "/.tenna/worker-host"

    /// The marker that asks for a worker script wrapped in the shim.
    static let shimQuery = "__tenna_sw"

    /// Answers a path with bytes and a content type, or nil for 404.
    ///
    /// Asynchronous because the answer is a blob cache read and, for a site
    /// that published again since it last subscribed, a Blossom fetch. Blocking
    /// the main thread for either would be blocking the thread every WebKit
    /// callback in this process arrives on.
    typealias Serve = (_ path: String) async -> (Data, String)?

    private let siteId: String
    /// The path the site registered its worker at. The worker is started
    /// there, so that its own URL — and every relative URL it resolves — is
    /// the one the site meant.
    private let worker: String
    private let serve: Serve
    /// The site's periodic sync tags, for `registration.periodicSync.getTags()`
    /// in a worker that has no host to ask.
    private let periodicTags: [String]

    private var webView: WKWebView?
    private var scheme: SchemeHandler?
    /// The worker's connection to the site's IndexedDB, the one the site's
    /// pages use. See `NsiteIndexedDB`.
    private let indexedDB = NsiteIndexedDBChannel()
    private var continuation: CheckedContinuation<[Notification], Never>?
    private var notifications: [Notification] = []
    private var failure: String?
    /// The event to hand over once the page says it has a worker: its kind,
    /// and the data the shim builds it from.
    private var pending: (kind: String, data: String)?

    init(siteId: String, worker: String, periodicTags: [String] = [], serve: @escaping Serve) {
        self.siteId = siteId
        self.worker = worker
        self.periodicTags = periodicTags
        self.serve = serve
        super.init()
    }

    // MARK: - Delivery

    /**
     Hand the worker one push and collect what it asks to show.

     Returns whatever `showNotification` was called with before every
     `waitUntil` settled, or nothing at all if the worker had no opinion, threw,
     or ran out of time. The caller treats all three the same way: the
     notification the server sent is what the user sees.
     */
    func deliver(push json: String, timeout: TimeInterval) async -> [Notification] {
        await deliver(kind: "push", data: json, timeout: timeout)
    }

    /**
     Hand the worker one event of any kind the shim knows — `push`, or the
     `periodicsync` the main app's background refresh raises with the tag as
     its data — and collect what it asks to show.
     */
    func deliver(kind: String, data: String, timeout: TimeInterval) async -> [Notification] {
        guard let url = URL(string: "\(NsiteOrigins.scheme)://\(NsiteOrigins.hostFor(siteId) ?? "")\(Self.hostPath)") else {
            return []
        }

        pending = (kind, data)

        let scheme = SchemeHandler(host: self)
        self.scheme = scheme

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: NsiteOrigins.scheme)
        config.userContentController.add(self, name: "tenna")
        config.userContentController.addScriptMessageHandler(
            IndexedDBRelay(siteId: siteId, channel: indexedDB), contentWorld: .page, name: "tennaIDB")
        // The site's sealing key, for the host page to hand the worker's
        // vault. The page is Tenna's and none of the site's code runs in it.
        if let key = NsiteCryptoKeys.sealingKey(for: siteId) {
            config.userContentController.addUserScript(WKUserScript(
                source: "window.__tennaVaultKey = \(Self.jsString(key));",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        // Nothing WebKit keeps here will ever be looked at, and a store on
        // disk is a store to clean up. What the worker keeps, it keeps in
        // IndexedDB, which is Tenna's store and not this one.
        config.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        webView.navigationDelegate = self
        self.webView = webView

        let deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.finish(reason: "timed out")
        }

        let result = await withCheckedContinuation { (continuation: CheckedContinuation<[Notification], Never>) in
            self.continuation = continuation
            webView.load(URLRequest(url: url))
        }

        deadline.cancel()
        tearDown()
        return result
    }

    private func finish(reason: String?) {
        guard let continuation else { return }
        self.continuation = nil
        if let reason { NSLog("[NsiteWorkerHost] %@", reason) }
        continuation.resume(returning: notifications)
    }

    private func tearDown() {
        scheme?.cancelAll()
        scheme = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "tenna")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "tennaIDB", contentWorld: .page)
        NsiteIndexedDB.site(siteId).close(indexedDB)
        webView?.navigationDelegate = nil
        webView?.stopLoading()
        webView = nil
    }

    // MARK: - Messages from the host page

    nonisolated func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        MainActor.assumeIsolated {
            guard let text = message.body as? String,
                  let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let kind = object["__tenna"] as? String else { return }

            NSLog("[NsiteWorkerHost] message %@", kind)

            switch kind {
            case "ready":
                guard let event = pending else { return }
                pending = nil

                // The envelope the shim reads, not the event on its own: the
                // worker's channel carries Tenna's traffic and the site's, and
                // the kind is what tells them apart.
                guard let envelope = try? JSONSerialization.data(
                        withJSONObject: ["__tenna": event.kind, "id": 1, "data": event.data]),
                      let text = String(data: envelope, encoding: .utf8) else {
                    finish(reason: "could not encode the \(event.kind)")
                    return
                }

                webView?.evaluateJavaScript("window.__tennaDeliver(\(Self.jsString(text)))") { _, error in
                    if let error {
                        NSLog("[NsiteWorkerHost] could not hand over the event: %@",
                              error.localizedDescription)
                    }
                }

            case "notification":
                notifications.append(Notification(
                    title: String(describing: object["title"] ?? ""),
                    options: object["options"] as? [String: Any] ?? [:]
                ))

            case "done":
                finish(reason: nil)

            case "trace":
                NSLog("[NsiteWorkerHost] trace: %@", object["message"] as? String ?? "")

            case "error":
                failure = object["message"] as? String
                finish(reason: "worker failed: \(failure ?? "unknown")")

            default:
                break
            }
        }
    }

    // MARK: - IndexedDB

    /// Answers the host page's relay of the worker's IndexedDB messages.
    private final class IndexedDBRelay: NSObject, WKScriptMessageHandlerWithReply {
        private let siteId: String
        private let channel: NsiteIndexedDBChannel

        init(siteId: String, channel: NsiteIndexedDBChannel) {
            self.siteId = siteId
            self.channel = channel
            super.init()
        }

        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
        ) {
            MainActor.assumeIsolated {
                NsiteIndexedDB.site(siteId).receive(body: message.body, from: channel, reply: replyHandler)
            }
        }
    }

    // MARK: - Serving

    /**
     Answers every request the host page and the worker make.

     Split out of the host rather than conformed by it because `WKWebView`
     holds its scheme handler strongly and the host holds the web view: the
     same retain cycle `NsiteSchemeHandler` avoids by being owned by the
     session instead.
     */
    @MainActor
    private final class SchemeHandler: NSObject, WKURLSchemeHandler {
        private weak var host: NsiteWorkerHost?

        /// Which tasks are still wanted. Answering one WebKit has stopped
        /// raises `NSInternalInconsistencyException`, which is a crash rather
        /// than an error — the hazard `NsiteSchemeHandler` documents, and one
        /// this handler only acquired by learning to answer late.
        private var nextId: UInt64 = 0
        private var live: [UInt64: WKURLSchemeTask] = [:]

        init(host: NsiteWorkerHost) {
            self.host = host
            super.init()
        }

        nonisolated func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            MainActor.assumeIsolated {
                let id = nextId
                nextId &+= 1
                live[id] = task

                guard let host, let url = task.request.url,
                      url.host == NsiteOrigins.hostFor(host.siteId) else {
                    fail(id, URLError(.badURL))
                    return
                }

                let path = url.path.isEmpty ? "/" : url.path
                let shimmed = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.contains { $0.name == NsiteWorkerHost.shimQuery } ?? false

                Task { @MainActor [weak self] in
                    let answer = await host.answer(path: path, shimmed: shimmed)
                    guard let self else { return }

                    guard let (body, contentType) = answer else {
                        NSLog("[NsiteWorkerHost] 404 %@ (shimmed=%@)", path, shimmed ? "yes" : "no")
                        self.fail(id, URLError(.fileDoesNotExist))
                        return
                    }
                    NSLog("[NsiteWorkerHost] served %@ (%d bytes, shimmed=%@)",
                          path, body.count, shimmed ? "yes" : "no")
                    self.finish(id, url: url, body: body, contentType: contentType)
                }
            }
        }

        nonisolated func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
            MainActor.assumeIsolated {
                // Identity, not equality: `WKURLSchemeTask` is a protocol and
                // the object handed back is the instance that was started.
                if let id = live.first(where: { $0.value === task })?.key {
                    live.removeValue(forKey: id)
                }
            }
        }

        /// Nothing outstanding is answered after this. Called when the host
        /// tears its web view down.
        func cancelAll() {
            live.removeAll()
        }

        private func fail(_ id: UInt64, _ error: Error) {
            guard let task = live.removeValue(forKey: id) else { return }
            task.didFailWithError(error)
        }

        private func finish(_ id: UInt64, url: URL, body: Data, contentType: String) {
            guard let task = live[id] else { return }
            live.removeValue(forKey: id)

            guard let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": contentType,
                    "Content-Length": String(body.count),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                ]
            ) else {
                task.didFailWithError(URLError(.badServerResponse))
                return
            }

            task.didReceive(response)
            task.didReceive(body)
            task.didFinish()
        }
    }

    /// Where the worker loads the IndexedDB engine from.
    static let indexedDBPath = "/.tenna/idb.js"

    /// Where the host page starts the site's vault from. See `NsiteCryptoKeys`.
    static let vaultPath = "/.tenna/vault.js"

    /// The host page, the shim and the engine are Tenna's; everything else is
    /// the site's.
    fileprivate func answer(path: String, shimmed: Bool) async -> (Data, String)? {
        if path == Self.indexedDBPath {
            guard let script = NsiteIndexedDB.script else { return nil }
            return (Data(script.utf8), "text/javascript; charset=utf-8")
        }
        if path == Self.vaultPath {
            guard let script = NsiteIndexedDB.vaultScript else { return nil }
            return (Data(script.utf8), "text/javascript; charset=utf-8")
        }
        if path == Self.hostPath {
            guard let page = Self.resource("NsiteWorkerHostPage", "html") else { return nil }
            // The worker's URL, carrying the marker that asks for the shim.
            let worker = "\(self.worker)?\(Self.shimQuery)=1"
            return (
                Data(page.replacingOccurrences(of: "%%WORKER%%", with: Self.jsString(worker)).utf8),
                "text/html; charset=utf-8"
            )
        }

        guard let (body, contentType) = await serve(path) else { return nil }
        guard shimmed, let shim = Self.resource("NsiteWorkerShim", "js") else {
            return (body, contentType)
        }

        // `importScripts` rather than concatenation, so a `'use strict'`
        // prologue at the top of the site's script is still at the top of a
        // script and still means what it says.
        let tags = (try? JSONSerialization.data(withJSONObject: periodicTags))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        // The engine before the site, whose top-level code may open a
        // database; it reaches the store through the port the host page sends.
        let engine = NsiteIndexedDB.script == nil ? "" : "importScripts(\(Self.jsString(Self.indexedDBPath)));"
        let source = """
        self.__tennaPeriodicTags = \(tags);
        \(shim)
        \(engine)
        importScripts(\(Self.jsString(path)));
        self.__tennaWorker.boot();
        """
        return (Data(source.utf8), "text/javascript; charset=utf-8")
    }

    private static func resource(_ name: String, _ extension: String) -> String? {
        guard let url = Bundle.main.url(forResource: name, withExtension: `extension`),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("[NsiteWorkerHost] missing resource %@.%@", name, `extension`)
            return nil
        }
        return text
    }

    /// A string, as a JavaScript literal. See `NsiteFileServer.jsString`.
    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(
                withJSONObject: value, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return json
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
            .replacingOccurrences(of: "<", with: "\\u003c")
    }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        MainActor.assumeIsolated {
            finish(reason: "host page failed: \(error.localizedDescription)")
        }
    }
}
