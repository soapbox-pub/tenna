import CryptoKit
import UIKit
import WebKit

/**
 One open site: its WebView, its scheme handler, and its storage.

 Split out of `NsiteWebViewPlugin` so that everything belonging to a site has
 one owner and one teardown. A site is closed by dropping this.
 */
@MainActor
final class NsiteSession: NSObject, WKNavigationDelegate, WKUIDelegate {

    let siteId: String

    /// What the site's name is, for a prompt raised in its name.
    let name: String

    private let handler: NsiteSchemeHandler
    private let webView: WKWebView
    /// Draws behind the site, and is all that is visible until it paints.
    private let container: Letterbox
    private let onLoad: () -> Void
    /// A JSON-RPC call from the site's provider: id, method, params as text.
    private let onRpc: (Int, String, String) -> Void
    /// The site reached for something of the device's: id, and what it asked for.
    private let onCapability: (Int, [String]) -> Void
    /// The site followed a link to another site, spelled as `nsite://`.
    private let onLink: (String) -> Void
    private var reportedLoad = false
    private var nextCapabilityId = 1
    private var capabilities: [Int: (Bool) -> Void] = [:]

    /// When the user last tapped the site. See `TouchWitness`.
    private let witness = TouchWitness()
    private var location: NsiteLocation?
    /// This WebView's connection to the site's IndexedDB. See `NsiteIndexedDB`.
    private let indexedDB = NsiteIndexedDBChannel()
    private lazy var downloads = NsiteDownloads(presenter: { [weak self] in self?.presenter() })

    /// The JavaScript dialog on screen, if any, and what the page is told if
    /// it goes away unanswered.
    private var dialog: UIAlertController?
    private var refusal: (() -> Void)?

    init(
        siteId: String,
        name: String,
        files: [String: String],
        servers: [String],
        providerScript: String?,
        envScript: String?,
        onLoad: @escaping () -> Void,
        onRpc: @escaping (Int, String, String) -> Void,
        onCapability: @escaping (Int, [String]) -> Void,
        onLink: @escaping (String) -> Void
    ) {
        self.siteId = siteId
        self.name = name
        self.onLoad = onLoad
        self.onRpc = onRpc
        self.onCapability = onCapability
        self.onLink = onLink

        // Black rather than clear: the site is what is meant to be on screen,
        // and anything showing through from the Capacitor layer beneath would
        // be Tenna's own wall sliding around behind a site's transparent
        // background. The site's `theme-color`, once it is known, replaces it.
        let container = Letterbox()
        self.container = container

        // The file server is an actor and reads the document off its own
        // queue; the letterbox is main-thread UI. The hop is queued ahead of
        // the response the document is carried in, so the site's first paint
        // already has its frame.
        let server = NsiteFileServer(files: files, servers: servers, onChrome: { chrome in
            Task { @MainActor in container.chrome = chrome }
        })
        self.handler = NsiteSchemeHandler(
            server: server,
            host: NsiteOrigins.hostFor(siteId) ?? ""
        )

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: NsiteOrigins.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // `requestFullscreen()` on an element. A `<video>` already goes
        // fullscreen through the system player without this.
        config.preferences.isElementFullscreenEnabled = true

        // A store per site, which is what closes the gap `NsiteProfiles.java`
        // describes: `nsite.localhost` is not a public suffix, so without this
        // one site could write a cookie scoped to the parent domain and read
        // every sibling's. A store of its own means there are no siblings.
        //
        // Not a sandbox, and the Android note applies here too — every WebView
        // in the app shares one renderer process.
        config.websiteDataStore = WKWebsiteDataStore(
            forIdentifier: Self.storeIdentifier(for: siteId))

        // The bridge, installed before the site's own code can run. Two user
        // scripts: the shim that gives the provider something to call — see
        // `Host` below — and then the provider itself.
        let controller = config.userContentController
        // `window.ENV`, ahead of everything, into every frame that is the
        // site's own — as Android's origin-scoped document-start script does,
        // and as a gateway serving it on every page would. See `nsiteEnv.ts`.
        if let source = Self.envScript(envScript, siteId: siteId) {
            controller.addUserScript(WKUserScript(
                source: source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            ))
        }
        if let providerScript {
            controller.addUserScript(WKUserScript(
                source: Self.hostShim,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            controller.addUserScript(WKUserScript(
                source: providerScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        // Whether or not there is a provider: where the user is has nothing
        // to do with who they are.
        controller.addUserScript(WKUserScript(
            source: NsiteLocation.script,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // IndexedDB, into every frame that is the site's own: the page, its
        // same-origin iframes, `about:blank` ones that inherit its origin.
        // Anybody else's frame keeps WebKit's. See `NsiteIndexedDB`.
        if let source = Self.indexedDBScript(siteId: siteId) {
            controller.addUserScript(WKUserScript(
                source: source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            ))
        }

        self.webView = WKWebView(frame: .zero, configuration: config)

        super.init()

        // Added after `super.init()` because the handlers are given `self`,
        // and through `webView.configuration` rather than `config` because a
        // `WKWebView` copies the configuration it is made with.
        let host = Host(session: self)
        if providerScript != nil {
            webView.configuration.userContentController.add(host, name: Self.hostObject)
        }
        webView.configuration.userContentController.add(host, name: NsiteLocation.handlerName)
        webView.configuration.userContentController.addScriptMessageHandler(
            IndexedDBHost(session: self), contentWorld: .page, name: Self.indexedDBObject)

        location = NsiteLocation(
            askSite: { [weak self] decide in
                guard let self else { return decide(false) }
                self.ask(["location"], decide)
            },
            deliver: { [weak self] text in
                self?.webView.evaluateJavaScript(
                    "window.__tennaLocationReceive(\(text))", completionHandler: nil)
            }
        )

        container.content = webView
        container.clipsToBounds = true

        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The site handles its own insets through `env(safe-area-inset-*)`,
        // exactly as it does on Android. WebKit must not also inset it. A site
        // that did not ask to is letterboxed instead — see `Letterbox`.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        // A preview is a browser's affordance, and its "Open" would follow the
        // link a second time, long after the tap `TouchWitness` saw.
        webView.allowsLinkPreview = false
        webView.addGestureRecognizer(witness)
        #if DEBUG
        // What Android's `setWebContentsDebuggingEnabled` does for a debug
        // build: the site can be reached from Web Inspector.
        webView.isInspectable = true
        #endif
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    // MARK: - The bridge

    /**
     What the provider script talks to.

     The script is written once and injected on both platforms, and its
     `webMessage` transport expects a global with `postMessage` and `onmessage` —
     which is what Android's `addWebMessageListener` installs. `WKWebView` has
     no such thing: a script message handler is reached at
     `window.webkit.messageHandlers.<name>` and is one-way, with the reply
     arriving as an `evaluateJavaScript` call instead.

     So this is the adapter, and it is the whole of the difference: one object
     under the name the provider expects, and one function for the host to call
     back into. Defined non-enumerably, and before any of the site's own code,
     so a page cannot be made to find something else there.
     */
    private static let hostObject = "tennaHost"

    private static let hostShim = """
    (function() {
      var handler = window.webkit && window.webkit.messageHandlers
        && window.webkit.messageHandlers.\(hostObject);
      if (!handler) return;

      var host = {
        onmessage: null,
        postMessage: function(data) { handler.postMessage(data); }
      };

      Object.defineProperty(window, '\(hostObject)', { value: host });
      Object.defineProperty(window, '__tennaHostReceive', {
        value: function(text) {
          if (typeof host.onmessage === 'function') host.onmessage({ data: text });
        }
      });
    })();
    """

    /**
     Receives the site's messages without keeping the session alive.

     Split out for the reason `NsiteWorkerHost.SchemeHandler` is:
     `WKUserContentController` holds a message handler strongly, and the session
     holds the controller by way of the web view. Conforming the session itself
     would be a cycle the site's window never gets out of.
     */
    private final class Host: NSObject, WKScriptMessageHandler {
        private weak var session: NsiteSession?

        init(session: NsiteSession) {
            self.session = session
            super.init()
        }

        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            MainActor.assumeIsolated {
                session?.receive(message)
            }
        }
    }

    /**
     A message off one of the site's handlers.

     The scripts are injected into the main frame only, but a handler is
     reachable from every frame through `window.webkit.messageHandlers` — so a
     third-party iframe inside the site could otherwise ask for a signature in
     the site's name. Only the site's own top-level document is listened to,
     which is what Android's `isMainFrame` check and origin allowlist say.
     */
    private func receive(_ message: WKScriptMessage) {
        let frame = message.frameInfo
        guard frame.isMainFrame,
              frame.securityOrigin.protocol == NsiteOrigins.scheme,
              frame.securityOrigin.host == NsiteOrigins.hostFor(siteId) else { return }

        switch message.name {
        case Self.hostObject:
            guard let text = message.body as? String else { return }
            receive(text)
        case NsiteLocation.handlerName:
            location?.receive(message.body)
        default:
            return
        }
    }

    /// One JSON-RPC request off the site's provider.
    private func receive(_ text: String) {
        guard let data = text.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (request["id"] as? NSNumber)?.intValue,
              let method = request["method"] as? String else { return }

        // `napp.fetch` is answered here rather than in the web layer, as on
        // Android: it asks nobody anything, and its payload is the site's
        // bytes, which have no business crossing Capacitor to arrive back
        // where they started. See `NappFetch`.
        if method.hasPrefix("napp.fetch.") {
            answerFetch(id: id, method: method, params: request["params"] as? [String: Any] ?? [:])
            return
        }

        // Params travel on as JSON text. A signed event's tags are an
        // arbitrarily shaped array, and Capacitor's object coercion does not
        // keep them intact — the same reason Android does this.
        let params = request["params"].map { NappSubscriptions.text($0) } ?? "{}"
        onRpc(id, method, params)
    }

    private func answerFetch(id: Int, method: String, params: [String: Any]) {
        switch method {
        case "napp.fetch.begin":
            do {
                let ticket = try NappFetch.stage(siteId: siteId, params: params)
                // A UUID, so quoting it is all it takes to make it JSON.
                respond(id: id, result: "\"\(ticket)\"", error: nil)
            } catch {
                respond(id: id, result: nil, error: error.localizedDescription)
            }
        case "napp.fetch.body":
            do {
                try NappFetch.body(siteId: siteId, ticket: params["ticket"] as? String ?? "",
                                   encoded: params["body"] as? String ?? "")
                respond(id: id, result: "null", error: nil)
            } catch {
                respond(id: id, result: nil, error: error.localizedDescription)
            }
        case "napp.fetch.abort":
            NappFetch.abort(siteId: siteId, ticket: params["ticket"] as? String ?? "")
            respond(id: id, result: "null", error: nil)
        default:
            respond(id: id, result: nil, error: "Method not found: \(method)")
        }
    }

    /// Write a JSON-RPC response back to the site's provider.
    func respond(id: Int, result: String?, error: String?) {
        var response: [String: Any] = ["jsonrpc": "2.0", "id": id]

        if let error {
            response["error"] = ["code": -1, "message": error]
        } else {
            // `result` is JSON text, parsed back out here, which is how it
            // reaches this class from the web layer.
            let value = result
                .flatMap { $0.data(using: .utf8) }
                .flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
            response["result"] = value ?? NSNull()
        }

        guard JSONSerialization.isValidJSONObject(response),
              let data = try? JSONSerialization.data(withJSONObject: response),
              let text = String(data: data, encoding: .utf8) else { return }

        webView.evaluateJavaScript("window.__tennaHostReceive(\(Self.jsString(text)))") { _, error in
            if error != nil {
                // The site has gone and there was nobody to tell. It no longer
                // has any way to notice, either.
            }
        }
    }

    /// A string, as a JavaScript literal. See `NsiteWorkerHost.jsString`.
    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(
                withJSONObject: value, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return json
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    // MARK: - IndexedDB

    private static let indexedDBObject = "tennaIDB"

    /// The engine, for frames whose origin is this site's and no other.
    ///
    /// With it, the site's sealing key for the engine to hand its vault
    /// (`NsiteCryptoKeys`). A user script's source is not the page's to read,
    /// and the engine takes the key before any of the site's code runs.
    private static func indexedDBScript(siteId: String) -> String? {
        guard let script = NsiteIndexedDB.script, let origin = NsiteOrigins.originFor(siteId) else { return nil }
        let key = NsiteCryptoKeys.sealingKey(for: siteId).map { "self.__tennaIDBVaultKey = \(jsString($0));\n" } ?? ""
        return "if (self.origin === \(jsString(origin))) {\n\(key)\(script)\n}"
    }

    /// The web layer's `window.ENV` script, kept to frames of this site's origin.
    private static func envScript(_ script: String?, siteId: String) -> String? {
        guard let script, let origin = NsiteOrigins.originFor(siteId) else { return nil }
        return "if (self.origin === \(jsString(origin))) {\n\(script)\n}"
    }

    /// Carries the engine's messages to the store, answering each in turn.
    private final class IndexedDBHost: NSObject, WKScriptMessageHandlerWithReply {
        private weak var session: NsiteSession?

        init(session: NsiteSession) {
            self.session = session
            super.init()
        }

        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
        ) {
            MainActor.assumeIsolated {
                guard let session else { return replyHandler(nil, "UnknownError: The site has closed.") }
                session.receiveIndexedDB(message, reply: replyHandler)
            }
        }
    }

    /**
     A message from the engine in one of the site's frames. Any frame will do,
     as long as its origin is the site's: the data is the site's own, and a
     frame of the site's is the site.
     */
    private func receiveIndexedDB(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard origin.protocol == NsiteOrigins.scheme, origin.host == NsiteOrigins.hostFor(siteId) else {
            return reply(nil, "UnknownError: Refused.")
        }
        NsiteIndexedDB.site(siteId).receive(body: message.body, from: indexedDB, reply: reply)
    }

    // MARK: - Capabilities

    /// Answer a question previously raised as `nsiteCapability`.
    func respondCapability(id: Int, granted: Bool) {
        guard let decide = capabilities.removeValue(forKey: id) else { return }
        decide(granted)
    }

    /// Ask the web layer whether the site may have something of the device's.
    private func ask(_ kinds: [String], _ decide: @escaping (Bool) -> Void) {
        let id = nextCapabilityId
        nextCapabilityId += 1
        capabilities[id] = decide
        onCapability(id, kinds)
    }

    /// A stable store identity per site, so a site's storage survives closing
    /// and reopening it the way its cache does.
    static func storeIdentifier(for siteId: String) -> UUID {
        // A UUID is sixteen bytes and a site id is up to sixty-three: the
        // first sixteen of its SHA-256, so no two sites share a store.
        var digest = Array(SHA256.hash(data: Data(siteId.utf8)).prefix(16))
        // Version 4 / variant bits, so the value is a well-formed UUID.
        digest[6] = (digest[6] & 0x0f) | 0x40
        digest[8] = (digest[8] & 0x3f) | 0x80
        return UUID(uuid: (digest[0], digest[1], digest[2], digest[3],
                           digest[4], digest[5], digest[6], digest[7],
                           digest[8], digest[9], digest[10], digest[11],
                           digest[12], digest[13], digest[14], digest[15]))
    }

    // MARK: - Lifecycle

    func attach(to parent: UIView, frame: CGRect) {
        container.frame = frame
        parent.addSubview(container)
        container.addSubview(webView)

        // The site fades up when it has something to show. Until then React is
        // painting tuning static underneath, and an empty WebView over it
        // would just be a grey hole where the static should be.
        container.alpha = 0
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func setFrame(_ frame: CGRect) {
        container.frame = frame
    }

    func goBack() -> Bool {
        guard webView.canGoBack else { return false }
        webView.goBack()
        return true
    }

    func setConcealed(_ concealed: Bool) {
        container.isHidden = concealed
    }

    /// A picture of the site as it stands, as a `data:` URL.
    func snapshot(_ completion: @escaping (String?) -> Void) {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        // Half resolution, like Android's: it is a backdrop behind a sheet,
        // and the bridge carries it as base64 text.
        config.snapshotWidth = NSNumber(value: Double(webView.bounds.width / 2))

        webView.takeSnapshot(with: config) { image, _ in
            guard let image, let jpeg = image.jpegData(compressionQuality: 0.7) else {
                completion(nil)
                return
            }
            completion("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
    }

    func tearDown() {
        handler.cancelAll()
        // A question with nobody left to answer it is a renderer waiting
        // forever; WebKit wants every decision handler called exactly once.
        for (_, decide) in capabilities { decide(false) }
        capabilities.removeAll()
        location?.tearDown()
        location = nil
        downloads.tearDown()
        // The same rule for a dialog: its page is answered on the way out.
        dismissDialog()
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.hostObject)
        controller.removeScriptMessageHandler(forName: NsiteLocation.handlerName)
        controller.removeScriptMessageHandler(forName: Self.indexedDBObject, contentWorld: .page)
        NsiteIndexedDB.site(siteId).close(indexedDB)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        webView.removeFromSuperview()
        container.removeFromSuperview()
    }

    // MARK: - WKUIDelegate

    /**
     The camera and the microphone, which the WebView asks about rather than the
     site.

     Raised to the web layer as an `nsiteCapability`, which is where the grants
     and the prompt live — the same sheet a signing request opens, and the same
     store Android writes to. Whether *Tenna* may reach the camera is a separate
     question, and here it comes first: WebKit settles the app's own camera and
     microphone access with the system before it asks this delegate anything,
     so the order Android keeps is not Tenna's to choose. The usage strings in
     Info.plist are what make that question askable at all; without them iOS
     ends the app instead.
     */
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        guard origin.host == NsiteOrigins.hostFor(siteId) else {
            decisionHandler(.deny)
            return
        }

        let kinds: [String]
        switch type {
        case .camera: kinds = ["camera"]
        case .microphone: kinds = ["microphone"]
        case .cameraAndMicrophone: kinds = ["camera", "microphone"]
        @unknown default:
            decisionHandler(.deny)
            return
        }

        ask(kinds) { granted in decisionHandler(granted ? .grant : .deny) }
    }

    /**
     `window.open`, and a link with a `target` of its own.

     There is no second window to put it in — Android turns multiple windows
     off for the same reason — so it goes where the same link would have gone
     without a target: into this one if it is the site's own, out to the device
     if not. WebKit only asks this for a page the user is interacting with,
     since `javaScriptCanOpenWindowsAutomatically` is off.
     */
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isOwn(url) {
                webView.load(navigationAction.request)
            } else {
                handOff(url)
            }
        }
        return nil
    }

    // MARK: JavaScript dialogs

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        // An alert has nothing to disagree with, so dismissing it and pressing
        // its one button mean the same thing.
        let alert = makeDialog(message)
        alert.addAction(answering(.default, "OK", completionHandler))
        show(alert, refusal: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = makeDialog(message)
        alert.addAction(answering(.cancel, "Cancel") { completionHandler(false) })
        alert.addAction(answering(.default, "OK") { completionHandler(true) })
        show(alert) { completionHandler(false) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = makeDialog(prompt)
        alert.addTextField { field in field.text = defaultText }
        alert.addAction(answering(.cancel, "Cancel") { completionHandler(nil) })
        alert.addAction(answering(.default, "OK") { [weak alert] in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        show(alert) { completionHandler(nil) }
    }

    /**
     The shape every dialog a site opens takes.

     Titled with the site's name, because a box drawn over a window with no
     address bar has nothing else to say whose words these are. A site that
     could put an unattributed box on screen could put Tenna's words in it. The
     message is set as text, never as anything read as markup.
     */
    private func makeDialog(_ message: String) -> UIAlertController {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmed.isEmpty ? "This site says" : "\(trimmed) says"
        return UIAlertController(title: title, message: message, preferredStyle: .alert)
    }

    /// A button: the end of the refusal, and then the answer it gives.
    private func answering(
        _ style: UIAlertAction.Style,
        _ title: String,
        _ answer: @escaping () -> Void
    ) -> UIAlertAction {
        UIAlertAction(title: title, style: style) { [weak self] _ in
            self?.dialog = nil
            self?.refusal = nil
            answer()
        }
    }

    /**
     Put a site's dialog on screen, and hold the page to a single answer.

     WebKit blocks the page on a JavaScript dialog until its handler is called,
     and wants it called exactly once. So a dialog that cannot be shown is
     refused on the spot, and one still up when the site closes is refused
     then — see `tearDown`.
     */
    private func show(_ alert: UIAlertController, refusal: @escaping () -> Void) {
        dismissDialog()

        guard let presenter = presenter() else {
            refusal()
            return
        }

        dialog = alert
        self.refusal = refusal
        presenter.present(alert, animated: true)
    }

    /// Take down whatever dialog is up, telling the page no.
    private func dismissDialog() {
        let pending = refusal
        refusal = nil
        dialog?.dismiss(animated: false)
        dialog = nil
        pending?()
    }

    /// The controller on top of the window the site is in, or nil if the site
    /// is not in one.
    private func presenter() -> UIViewController? {
        var top = container.window?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    // MARK: - WKNavigationDelegate

    /**
     A site that never loaded, said out loud.

     Nothing is reported to the web layer, which matches Android: `onLoad` is
     simply never called, the viewer's tuning static never lifts, and a site
     that cannot be fetched looks like a channel with no signal — which is what
     it is. But a failure that leaves no trace anywhere is one nobody can
     diagnose later, so it is at least written to the log.
     */
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[Nsite] navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[Nsite] navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !reportedLoad else { return }
        reportedLoad = true

        UIView.animate(withDuration: 0.6) { self.container.alpha = 1 }
        onLoad()
    }

    /**
     Where the site is allowed to take itself.

     Its own host is its own business, and so is a file it offers: bytes it
     serves or made itself, which become a download rather than a page.

     A frame inside the site may load what it likes over the web. A
     third-party subframe reaching for its own origin is the page loading
     itself, not somebody asking to leave, and an embedded video has no
     business throwing the user into a browser — so it stays where it is.

     The top of the window going anywhere else is a link out, which this
     window cannot follow: it is one site's window, not a browser. It is
     cancelled here and handed to the device — see `handOff`. A navigation
     WebKit would open in a new window arrives here with no target frame, and
     is treated as the top of this one.
     */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        let own = isOwn(url)

        if navigationAction.shouldPerformDownload, own || scheme == "data" {
            decisionHandler(.download)
            return
        }

        guard let target = navigationAction.targetFrame else {
            decisionHandler(.cancel)
            if own { webView.load(navigationAction.request) } else { handOff(url) }
            return
        }

        if !target.isMainFrame {
            let embeddable = own || Self.frameSchemes.contains(scheme)
            decisionHandler(embeddable ? .allow : .cancel)
            return
        }

        if own {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            handOff(url)
        }
    }

    /// What a frame inside the site may load.
    private static let frameSchemes: Set<String> = ["https", "http", "about", "data", "blob"]

    /// A response the WebView cannot show is a file, and files are saved.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let isFile = navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType
        decisionHandler(isFile ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.adopt(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.adopt(download)
    }

    // MARK: - Links out

    /**
     Whether a URL is the site's own: its origin, or a blob it made there.

     A blob URL carries the origin that minted it, so one of the site's own is
     as much the site's as its files are.
     */
    private func isOwn(_ url: URL) -> Bool {
        var url = url
        if url.scheme?.lowercased() == "blob",
           let inner = URL(string: String(url.absoluteString.dropFirst("blob:".count))) {
            url = inner
        }
        return url.scheme?.lowercased() == NsiteOrigins.scheme
            && url.host == NsiteOrigins.hostFor(siteId)
    }

    /**
     Hand a link out of the site to whatever on the device answers for it.

     An http link goes to the browser, a `mailto:` to the mail app, a
     `lightning:` to a wallet. Two things are asked of it first, as on
     Android. Its scheme must not be one of `refusedSchemes`. And it must be
     one the user pressed, because a page that reaches for another app on load
     is not following anybody. `WKNavigationAction` has no `hasGesture()`, so
     the tap is witnessed directly — see `TouchWitness` — and spent by the
     first link it lets out, so one tap cannot open two apps.

     A link to another site is not a link out of Tenna at all, so it does not
     go to the OS: Tenna registers `nsite:` itself, and the round trip would
     come straight back in through the wall. It is raised to the web layer as
     `nsiteLink` instead, which resolves and opens it.
     */
    private func handOff(_ url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""

        guard !scheme.isEmpty, !Self.refusedSchemes.contains(scheme) else {
            NSLog("[Nsite] refused to hand the device a \(scheme): link")
            return
        }

        guard witness.spend() else {
            NSLog("[Nsite] refused an unasked-for navigation to \(url.absoluteString)")
            return
        }

        if scheme == NsiteOrigins.scheme {
            onLink(Self.publicLink(url))
            return
        }

        UIApplication.shared.open(url) { opened in
            if !opened { NSLog("[Nsite] nothing on the device answers for \(url.absoluteString)") }
        }
    }

    /**
     Schemes a site never gets to hand the device.

     `file:` names the device's own storage, which is not the site's to point
     a viewer at. The rest never reach a URL handler anyway, and are refused
     here so that stays true.
     */
    private static let refusedSchemes: Set<String> = [
        "file", "javascript", "data", "about", "blob",
    ]

    /**
     A link to another site, in the grammar the web layer reads.

     A public `nsite://` link passes through as it is. One written against
     another site's origin here — `nsite://<id>.nsite.localhost/path`, which
     only exists inside this app — is turned back into the canonical spelling
     of the same site, `nsite://<id>/path`. See `src/lib/nsiteUrl.ts`.
     */
    private static func publicLink(_ url: URL) -> String {
        guard let id = NsiteOrigins.siteIdFor(host: url.host),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        parts.host = id
        return parts.string ?? url.absoluteString
    }
}

/**
 Witnesses the user tapping the site.

 Stands in for Android's `WebResourceRequest.hasGesture()`, which WebKit has
 no public equivalent of. It never recognizes anything, never delays or
 cancels a touch, and runs alongside WebKit's own recognizers; all it does is
 note when a finger lifted without having moved, which is a tap and not a
 scroll. A link out is let through only within a few seconds of one — the
 same window a browser's transient user activation gives — and spends it.
 */
private final class TouchWitness: UIGestureRecognizer, UIGestureRecognizerDelegate {

    private static let window: TimeInterval = 5
    private static let slop: CGFloat = 10

    private var start: CGPoint?
    private var lastTap: TimeInterval = -.infinity

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    /// Whether there was a recent tap, forgetting it either way.
    func spend() -> Bool {
        let fresh = ProcessInfo.processInfo.systemUptime - lastTap <= Self.window
        lastTap = -.infinity
        return fresh
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        start = touches.first?.location(in: view)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        if let start, let end = touches.first?.location(in: view),
           hypot(end.x - start.x, end.y - start.y) <= Self.slop {
            lastTap = ProcessInfo.processInfo.systemUptime
        }
        start = nil
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        start = nil
        state = .failed
    }

    override func reset() {
        start = nil
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

/**
 The frame around the site: its colour, and its margins if it wants them.

 A site that says `viewport-fit=cover` draws under the home indicator and the
 sensor housing and handles them through `env(safe-area-inset-*)`. One that
 does not is letterboxed out of them, as it would be in Safari and as Android
 does, and the letterbox is the site's `theme-color` — which is also what
 shows in the overscroll behind a transparent page. See `NsiteSiteChrome`.
 */
private final class Letterbox: UIView {

    /// What the site's document said. Nil until its first byte is served.
    var chrome: NsiteSiteChrome? {
        didSet {
            let chrome = chrome
            backgroundColor = UIColor { traits in
                chrome?.themeColor(prefersDark: traits.userInterfaceStyle == .dark) ?? .black
            }
            setNeedsLayout()
        }
    }

    weak var content: UIView?

    init() {
        super.init(frame: .zero)
        backgroundColor = .black
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let margins = (chrome?.edgeToEdge ?? true) ? .zero : safeAreaInsets
        content?.frame = bounds.inset(by: margins)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }
}
