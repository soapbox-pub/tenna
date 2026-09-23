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
    private let container: UIView
    private let onLoad: () -> Void
    /// A JSON-RPC call from the site's provider: id, method, params as text.
    private let onRpc: (Int, String, String) -> Void
    /// The site reached for something of the device's: id, and what it asked for.
    private let onCapability: (Int, [String]) -> Void
    private var reportedLoad = false
    private var nextCapabilityId = 1
    private var capabilities: [Int: (Bool) -> Void] = [:]

    init(
        siteId: String,
        name: String,
        files: [String: String],
        servers: [String],
        providerScript: String?,
        onLoad: @escaping () -> Void,
        onRpc: @escaping (Int, String, String) -> Void,
        onCapability: @escaping (Int, [String]) -> Void
    ) {
        self.siteId = siteId
        self.name = name
        self.onLoad = onLoad
        self.onRpc = onRpc
        self.onCapability = onCapability

        let server = NsiteFileServer(files: files, servers: servers)
        self.handler = NsiteSchemeHandler(
            server: server,
            host: NsiteOrigins.hostFor(siteId) ?? ""
        )

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: NsiteOrigins.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // A store per site, which is what closes the gap `NsiteProfiles.java`
        // describes: `nsite.localhost` is not a public suffix, so without this
        // one site could write a cookie scoped to the parent domain and read
        // every sibling's. A store of its own means there are no siblings.
        //
        // Not a sandbox, and the Android note applies here too — every WebView
        // in the app shares one renderer process.
        config.websiteDataStore = WKWebsiteDataStore(
            forIdentifier: Self.storeIdentifier(for: siteId))

        // Black rather than clear: the site is what is meant to be on screen,
        // and anything showing through from the Capacitor layer beneath would
        // be Tenna's own wall sliding around behind a site's transparent
        // background.
        self.container = UIView()
        container.backgroundColor = .black
        container.clipsToBounds = true

        // The bridge, installed before the site's own code can run. Two user
        // scripts: the shim that gives the provider something to call — see
        // `Host` below — and then the provider itself.
        if let providerScript {
            let controller = config.userContentController
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

        self.webView = WKWebView(frame: .zero, configuration: config)

        super.init()

        if providerScript != nil {
            // Added after `super.init()` because the handler is given `self`,
            // and through `webView.configuration` rather than `config` because
            // a `WKWebView` copies the configuration it is made with.
            webView.configuration.userContentController
                .add(Host(session: self), name: Self.hostObject)
        }

        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The site handles its own insets through `env(safe-area-inset-*)`,
        // exactly as it does on Android. WebKit must not also inset it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
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
                guard let text = message.body as? String else { return }
                session?.receive(text)
            }
        }
    }

    /// One JSON-RPC request off the site's provider.
    private func receive(_ text: String) {
        guard let data = text.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (request["id"] as? NSNumber)?.intValue,
              let method = request["method"] as? String else { return }

        // Params travel on as JSON text. A signed event's tags are an
        // arbitrarily shaped array, and Capacitor's object coercion does not
        // keep them intact — the same reason Android does this.
        let params = request["params"].map { NappSubscriptions.text($0) } ?? "{}"
        onRpc(id, method, params)
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

    // MARK: - Capabilities

    /// Answer a question previously raised as `nsiteCapability`.
    func respondCapability(id: Int, granted: Bool) {
        guard let decide = capabilities.removeValue(forKey: id) else { return }
        decide(granted)
    }

    /// A stable store identity per site, so a site's storage survives closing
    /// and reopening it the way its cache does.
    private static func storeIdentifier(for siteId: String) -> UUID {
        // A UUID is sixteen bytes and a site id is up to sixty-three, so the
        // digest is what makes the mapping total rather than lossy.
        var digest = [UInt8](repeating: 0, count: 16)
        for (index, byte) in Array(siteId.utf8).enumerated() {
            digest[index % 16] = digest[index % 16] &+ byte &+ UInt8(index & 0x1f)
        }
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

        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
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
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: Self.hostObject)
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
     question the system asks afterwards, and only if the site was allowed
     first: there is no point putting the OS prompt in front of someone who has
     not yet said the site can have it.
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

        let id = nextCapabilityId
        nextCapabilityId += 1
        capabilities[id] = { granted in decisionHandler(granted ? .grant : .deny) }
        onCapability(id, kinds)
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

     Its own host is its own business. Anything else is refused outright for
     now: Android hands a main-frame navigation off to the OS, but it can
     require `hasGesture()` before doing so, and `WKNavigationAction` has no
     equivalent — so the nearest approximation would let a site throw the user
     into another app on load. Refusing is the conservative half of that
     trade, and a link that goes nowhere is a smaller bug than a site that
     hijacks the device.
     */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let host = navigationAction.request.url?.host
        decisionHandler(host == NsiteOrigins.hostFor(siteId) ? .allow : .cancel)
    }
}
