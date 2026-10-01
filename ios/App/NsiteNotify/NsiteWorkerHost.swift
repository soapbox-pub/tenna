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
    /// Whether the site registered it with `type: 'module'`, which decides
    /// how it is started: a module is not a script `importScripts` can run.
    private let module: Bool
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

    /**
     What `clients.openWindow` does for this delivery: open the site at a
     path and say whether it did. Nil — the default — refuses, which is right
     for a push or a background run: nobody asked for a window. The app sets
     it for a tap. See `NappNotificationEvents`.
     */
    var opener: ((String) -> Bool)?

    /// The staged share this delivery may read, at `/.tenna/share/<index>`.
    /// Set only for a `share_target` POST. See `NsiteShareDelivery`.
    var shareToken: String?

    /// What the worker's `fetch` handler answered a share with: `status`,
    /// `headers` and base64 `body`, or `none` when it did not answer.
    private(set) var response: [String: Any]?

    /// Told when a worker changed its site's periodic sync tags. The app
    /// schedules its background task from it; the extension cannot, and
    /// leaves that to the app's next trip to the background.
    static var periodicChanged: (() -> Void)?

    /// Told when a worker unsubscribed its site. The app re-sends the merged
    /// list to the push service; the extension cannot, and leaves that to the
    /// app's next launch or resume.
    static var subscriptionsChanged: (() -> Void)?

    init(siteId: String, worker: String, module: Bool = false, periodicTags: [String] = [],
         serve: @escaping Serve) {
        self.siteId = siteId
        self.worker = worker
        self.module = module
        self.periodicTags = periodicTags
        self.serve = serve
        super.init()
    }

    /// A host for a site as it is written down, serving its files out of its
    /// manifest and the shared blob cache.
    convenience init(site: NsiteRecord) {
        let server = NsiteFileServer(files: site.files, servers: site.servers)
        self.init(
            siteId: site.siteId,
            worker: site.worker ?? "/sw.js",
            module: site.workerModule,
            periodicTags: site.periodicSync.map(\.tag)
        ) { path in
            await server.file(path)
        }
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
        config.userContentController.addScriptMessageHandler(
            CallRelay(host: self), contentWorld: .page, name: "tennaCall")
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
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "tennaCall", contentWorld: .page)
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

            case "response":
                response = object

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

    // MARK: - Questions from the worker

    /// Answers the host page's relay of the worker's `call`s. See the shim.
    private final class CallRelay: NSObject, WKScriptMessageHandlerWithReply {
        private weak var host: NsiteWorkerHost?

        init(host: NsiteWorkerHost) {
            self.host = host
            super.init()
        }

        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
        ) {
            MainActor.assumeIsolated {
                guard let host,
                      let text = message.body as? String,
                      let object = NappSubscriptions.object(text),
                      let method = object["method"] as? String else {
                    replyHandler(nil, "Malformed call")
                    return
                }
                let params = object["params"] as? [String: Any] ?? [:]
                Task { @MainActor in
                    do {
                        replyHandler(try await host.answer(method: method, params: params), nil)
                    } catch {
                        replyHandler(nil, error.localizedDescription)
                    }
                }
            }
        }
    }

    struct CallFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// What the worker asked for, answered as the site and nobody else.
    private func answer(method: String, params: [String: Any]) async throws -> Any {
        switch method {
        case "list":
            let tag = params["tag"] as? String
            let records = await withCheckedContinuation { continuation in
                NappNotifications.list(siteId: siteId, tag: tag) { continuation.resume(returning: $0) }
            }
            return NappSubscriptions.text(records)

        case "close":
            guard let key = params["key"] as? String else { throw CallFailure(message: "key is required") }
            NappNotifications.close(siteId: siteId, key: key)
            return NSNull()

        case "periodicRegister":
            guard let tag = params["tag"] as? String, !tag.isEmpty else {
                throw CallFailure(message: "tag is required")
            }
            // Milliseconds from the web, seconds here.
            let minInterval = ((params["minInterval"] as? NSNumber)?.doubleValue ?? 0) / 1000
            try NsitePeriodic.register(siteId: siteId, label: nil, tag: tag, minInterval: minInterval, existing: true)
            Self.periodicChanged?()
            return NSNull()

        case "periodicUnregister":
            guard let tag = params["tag"] as? String else { throw CallFailure(message: "tag is required") }
            NsitePeriodic.unregister(siteId: siteId, tag: tag)
            Self.periodicChanged?()
            return NSNull()

        case "periodicTags":
            return NsitePeriodic.tags(siteId: siteId)

        case "pushSubscribed":
            return !(NsiteStore.load(siteId)?.subscriptions.isEmpty ?? true)

        case "pushUnsubscribe":
            guard let record = NsiteStore.load(siteId), !record.subscriptions.isEmpty else { return false }
            guard NsiteStore.update(siteId, { $0.subscriptions = [] }) != nil else {
                throw CallFailure(message: "Could not store the subscriptions")
            }
            Self.subscriptionsChanged?()
            return true

        case "napp.fetch.begin":
            do {
                return try NappFetch.stage(siteId: siteId, params: params)
            } catch {
                throw CallFailure(message: error.localizedDescription)
            }

        case "napp.fetch.body":
            do {
                try NappFetch.body(siteId: siteId, ticket: params["ticket"] as? String ?? "",
                                   encoded: params["body"] as? String ?? "")
                return NSNull()
            } catch {
                throw CallFailure(message: error.localizedDescription)
            }

        case "napp.fetch.abort":
            NappFetch.abort(siteId: siteId, ticket: params["ticket"] as? String ?? "")
            return NSNull()

        case "open":
            guard let path = params["path"] as? String, path.hasPrefix("/"), !path.hasPrefix("//") else {
                throw CallFailure(message: "A site can only open itself")
            }
            guard let opener, opener(path) else {
                throw CallFailure(message: "Nothing asked for that window")
            }
            return NSNull()

        default:
            throw CallFailure(message: "Unknown call \(method)")
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
        /// What stops each `napp.fetch` still in flight, by task.
        private var fetches: [UInt64: () -> Void] = [:]

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

                // The worker collecting a `napp.fetch` it staged. See `NappFetch`.
                if path == NappFetchRoute.path {
                    let cancel = NappFetch.run(
                        siteId: host.siteId, ticket: NappFetchRoute.ticket(in: url),
                        sink: NappFetchRoute.sink(
                            url: url,
                            task: { [weak self] in self?.live[id] },
                            done: { [weak self] in
                                self?.live.removeValue(forKey: id)
                                self?.fetches.removeValue(forKey: id)
                            }))
                    if let cancel {
                        if live[id] != nil { fetches[id] = cancel }
                    } else {
                        NappFetchRoute.fail(live.removeValue(forKey: id), url: url, message: "No such request")
                    }
                    return
                }

                let shimmed = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.contains { $0.name == NsiteWorkerHost.shimQuery } ?? false

                Task { @MainActor [weak self] in
                    let answer = await host.answer(path: path, shimmed: shimmed)
                    guard let self else { return }

                    guard let (body, contentType) = answer else {
                        NSLog("[NsiteWorkerHost] 404 %@ (shimmed=%@)", path, shimmed ? "yes" : "no")
                        // A response, as the site's own window gets: a worker
                        // checking `response.ok` for a file it may not have
                        // published should not have to catch a network error.
                        self.finish(id, url: url, status: 404,
                                    body: Data("Not Found".utf8), contentType: "text/plain; charset=utf-8")
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
                    fetches.removeValue(forKey: id)?()
                }
            }
        }

        /// Nothing outstanding is answered after this. Called when the host
        /// tears its web view down.
        func cancelAll() {
            live.removeAll()
            let stops = fetches.values
            fetches.removeAll()
            for stop in stops { stop() }
        }

        private func fail(_ id: UInt64, _ error: Error) {
            guard let task = live.removeValue(forKey: id) else { return }
            task.didFailWithError(error)
        }

        private func finish(_ id: UInt64, url: URL, status: Int = 200, body: Data, contentType: String) {
            guard let task = live[id] else { return }
            live.removeValue(forKey: id)

            guard let response = HTTPURLResponse(
                url: url, statusCode: status, httpVersion: "HTTP/1.1",
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

    /// Where a share's files are read back from, by index.
    static let sharePrefix = "/.tenna/share/"

    /// Where the worker loads the shim from, ahead of the site's script.
    static let shimPath = "/.tenna/sw-shim.js"

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
        if path == Self.shimPath {
            guard let shim = Self.resource("NsiteWorkerShim", "js") else { return nil }
            let tags = (try? JSONSerialization.data(withJSONObject: periodicTags))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            return (
                Data(shim.replacingOccurrences(of: "%%PERIODIC_TAGS%%", with: tags).utf8),
                "text/javascript; charset=utf-8"
            )
        }
        if path.hasPrefix(Self.sharePrefix) {
            guard let token = shareToken,
                  let index = Int(path.dropFirst(Self.sharePrefix.count)),
                  let (url, type) = NsiteShares.file(token, index: index),
                  let data = try? Data(contentsOf: url) else { return nil }
            return (data, type)
        }
        if path == Self.hostPath {
            guard let page = Self.resource("NsiteWorkerHostPage", "html") else { return nil }
            // The worker's URL, carrying the marker that asks for the shim.
            let worker = "\(self.worker)?\(Self.shimQuery)=1"
            return (
                Data(page
                    .replacingOccurrences(of: "%%WORKER%%", with: Self.jsString(worker))
                    .replacingOccurrences(of: "%%WORKER_TYPE%%", with: Self.jsString(module ? "module" : "classic"))
                    .utf8),
                "text/html; charset=utf-8"
            )
        }

        guard !shimmed else { return wrapper(path) }
        return await serve(path)
    }

    /**
     The script the worker is really started with: the shim, the IndexedDB
     engine, then the site's own script, and then the lifecycle.

     Each is loaded rather than concatenated, so a `'use strict'` prologue at
     the top of the site's script is still at the top of a script and still
     means what it says — and the site's script is loaded from the path it was
     started at, so its own URL is the one it was published under. The engine
     comes before the site, whose top-level code may open a database; it
     reaches the store through the port the host page sends.

     A module's static imports are evaluated in the order they are written, so
     the module wrapper keeps the same order the classic one has.
     */
    private func wrapper(_ path: String) -> (Data, String) {
        var scripts = [Self.shimPath]
        if NsiteIndexedDB.script != nil { scripts.append(Self.indexedDBPath) }
        scripts.append(path)

        let load = module
            ? scripts.map { "import \(Self.jsString($0));" }.joined(separator: "\n")
            : "importScripts(\(scripts.map(Self.jsString).joined(separator: ", ")));"
        let source = "\(load)\nself.__tennaWorker.boot();\n"
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
