import UIKit
import WebKit

/**
 One open site: its WebView, its scheme handler, and its storage.

 Split out of `NsiteWebViewPlugin` so that everything belonging to a site has
 one owner and one teardown. A site is closed by dropping this.
 */
@MainActor
final class NsiteSession: NSObject, WKNavigationDelegate {

    let siteId: String

    private let handler: NsiteSchemeHandler
    private let webView: WKWebView
    /// Draws behind the site, and is all that is visible until it paints.
    private let container: UIView
    private let onLoad: () -> Void
    private var reportedLoad = false

    init(
        siteId: String,
        files: [String: String],
        servers: [String],
        onLoad: @escaping () -> Void
    ) {
        self.siteId = siteId
        self.onLoad = onLoad

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

        self.webView = WKWebView(frame: .zero, configuration: config)

        super.init()

        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The site handles its own insets through `env(safe-area-inset-*)`,
        // exactly as it does on Android. WebKit must not also inset it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
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
        webView.navigationDelegate = nil
        webView.stopLoading()
        webView.removeFromSuperview()
        container.removeFromSuperview()
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
