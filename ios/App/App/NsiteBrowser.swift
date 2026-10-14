import UIKit
import WebKit

/**
 Somewhere else on the web, opened over the site that linked to it.

 A site's window is not a browser, so a link out of it used to go to Safari.
 That is right for a link somebody follows to read something, and wrong for
 every flow that expects to come back: a checkout, a sign-in, a payment page.
 Those send the user on to an address the site gave them — almost always its
 own origin — and a site's origin here is `nsite://<id>.nsite.localhost`, which
 exists only inside this app's WebViews. Safari cannot follow it anywhere.

 So a link out opens here instead, as a sheet over the site, and the moment
 anything here heads for a site's origin the sheet closes and hands the address
 back for the site's window to load. That is what a browser's popup does with
 the same flow, minus the second tab. Android's `NsiteBrowserActivity` is the
 same window.

 Nothing of the site's is in here. There is no bridge, no provider and no
 scheme handler, so the site's origin can never be shown in this window — a
 navigation there is the end of it. What it shares with the site is the site's
 data store, so a cookie a provider set inside the site's iframe is the one it
 sees here, as it would be in one browser.

 Always the host under the title, because this draws a page from anywhere over
 a site the user trusts, and the title is the page's to choose.
 */
@MainActor
final class NsiteBrowser: UIViewController, WKNavigationDelegate, WKUIDelegate {

    /// Whether this window is somewhere a link to `url` can open.
    static func opens(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http"
    }

    /**
     Put `url` on screen over `presenter`.

     `onReturn` is given the address at a site's origin the page went to. It is
     not called if the user closed the sheet.
     */
    static func present(
        _ url: URL,
        siteId: String,
        over presenter: UIViewController,
        onReturn: @escaping (URL) -> Void
    ) {
        let browser = NsiteBrowser(url: url, siteId: siteId, onReturn: onReturn)
        let navigation = UINavigationController(rootViewController: browser)
        navigation.modalPresentationStyle = .pageSheet
        presenter.present(navigation, animated: true)
    }

    private let initialURL: URL
    private let onReturn: (URL) -> Void
    private let webView: WKWebView
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let titleLabel = UILabel()
    private let hostLabel = UILabel()
    private var observations: [NSKeyValueObservation] = []
    private var returned = false

    private init(url: URL, siteId: String, onReturn: @escaping (URL) -> Void) {
        self.initialURL = url
        self.onReturn = onReturn

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = WKWebsiteDataStore(
            forIdentifier: NsiteSession.storeIdentifier(for: siteId))
        self.webView = WKWebView(frame: .zero, configuration: config)

        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif

        webView.translatesAutoresizingMaskIntoConstraints = false
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(progress)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.lineBreakMode = .byTruncatingTail
        hostLabel.font = .preferredFont(forTextStyle: .caption1)
        hostLabel.textColor = .secondaryLabel
        hostLabel.lineBreakMode = .byTruncatingMiddle
        let address = UIStackView(arrangedSubviews: [titleLabel, hostLabel])
        address.axis = .vertical
        address.alignment = .center
        navigationItem.titleView = address

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        let external = UIBarButtonItem(
            image: UIImage(systemName: "safari"),
            primaryAction: UIAction { [weak self] _ in self?.openExternally() }
        )
        external.accessibilityLabel = "Open in Safari"
        navigationItem.rightBarButtonItem = external

        observations = [
            webView.observe(\.estimatedProgress) { [weak self] webView, _ in
                MainActor.assumeIsolated {
                    self?.progress.setProgress(Float(webView.estimatedProgress), animated: true)
                    self?.progress.isHidden = webView.estimatedProgress >= 1
                }
            },
            webView.observe(\.title) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.showAddress() }
            },
            webView.observe(\.url) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.showAddress() }
            },
        ]

        showAddress()
        webView.load(URLRequest(url: initialURL))
    }

    /// The page's title over its host, or the host alone until it has one.
    private func showAddress() {
        let url = webView.url ?? initialURL
        let host = url.host ?? url.absoluteString
        let title = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if title.isEmpty || title == url.absoluteString {
            titleLabel.text = host
            hostLabel.text = nil
            hostLabel.isHidden = true
        } else {
            titleLabel.text = title
            hostLabel.text = host
            hostLabel.isHidden = false
        }
    }

    /// Give the page to Safari, and get out of the way.
    private func openExternally() {
        let url = webView.url.flatMap { Self.opens($0) ? $0 : nil } ?? initialURL
        UIApplication.shared.open(url)
        dismiss(animated: true)
    }

    /// Close, handing the site's window the address that brought us back.
    private func giveBack(_ url: URL) {
        guard !returned else { return }
        returned = true
        webView.stopLoading()
        let onReturn = onReturn
        dismiss(animated: true) { onReturn(url) }
    }

    /// Whether a URL is any site's origin, in either spelling a page could reach for.
    private static func isSite(_ url: URL) -> Bool {
        url.scheme?.lowercased() == NsiteOrigins.scheme
            || NsiteOrigins.siteIdFor(host: url.host) != nil
    }

    // MARK: - WKNavigationDelegate

    /**
     The web goes on in here. A site's origin is the way back, and ends this
     window. Anything else — a `mailto:`, a wallet, an app's own scheme — goes
     to the device, but only for a link the user pressed, and never one of the
     schemes a site may not hand out either.
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
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true

        if Self.isSite(url) {
            decisionHandler(.cancel)
            if isMain { giveBack(url) }
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""
        if Self.opens(url) || ["about", "data", "blob"].contains(scheme) {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.cancel)
        guard isMain, navigationAction.navigationType == .linkActivated,
              !["file", "javascript"].contains(scheme) else {
            NSLog("[NsiteBrowser] refused to hand the device \(url.absoluteString)")
            return
        }
        UIApplication.shared.open(url)
    }

    /// The second look, for a way back that went around the policy check.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if let url = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL, Self.isSite(url) {
            giveBack(url)
        }
    }

    // MARK: - WKUIDelegate

    /// `window.open`, and a link with a `target`: into this window, as on Android.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        webView.load(navigationAction.request)
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
