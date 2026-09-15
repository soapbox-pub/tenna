import Foundation
import WebKit

/**
 Answers every request a site's WebView makes for its own origin.

 The WebKit half of what `shouldInterceptRequest` does on Android: the site's
 document, its scripts, its images and everything else arrive here and are
 resolved against the manifest by `NsiteFileServer`. Nothing resolves
 `nsite.localhost`, so a request that reaches the network at all is a request
 for somebody else's host, and WebKit routes those normally without consulting
 this at all — an nsite fetching a relay or an avatar is nobody's business
 here.

 ## Answering exactly once, and only while asked

 `WKURLSchemeTask` has the mirror image of the hazard `NsiteChromeClient`
 documents for JS dialogs. There the renderer blocks until a dialog is answered
 exactly once; here the task must be answered exactly once *and not after
 WebKit has stopped it* — a `didReceive` or `didFinish` on a stopped task
 raises `NSInternalInconsistencyException`, which is a crash, not an error.
 Serving is asynchronous by nature (a blob may be a network fetch away), so a
 task being stopped mid-flight is ordinary rather than exceptional: it happens
 every time a site navigates while something is still loading.

 So every task is held by an id in a main-actor set, removed on `stop`, and
 checked again on the main actor immediately before each call. The set is the
 only thing that decides whether a task is still live.
 */
@MainActor
final class NsiteSchemeHandler: NSObject, WKURLSchemeHandler {

    private let server: NsiteFileServer
    /// The site this handler serves. A request for any other host is refused
    /// rather than served from the wrong manifest.
    private let host: String

    private var nextId: UInt64 = 0
    private var live: [UInt64: WKURLSchemeTask] = [:]

    init(server: NsiteFileServer, host: String) {
        self.server = server
        self.host = host
        super.init()
    }

    nonisolated func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        MainActor.assumeIsolated {
            let id = nextId
            nextId &+= 1
            live[id] = urlSchemeTask

            guard let url = urlSchemeTask.request.url, url.host == host else {
                finish(id, with: .text(404, "Not Found"), url: urlSchemeTask.request.url)
                return
            }

            Task { [weak self] in
                let response = await self?.server.serve(url)
                guard let self, let response else { return }
                self.finish(id, with: response, url: url)
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        MainActor.assumeIsolated {
            // Identity, not equality: `WKURLSchemeTask` is a protocol and the
            // object handed back here is the same instance that was started.
            if let id = live.first(where: { $0.value === urlSchemeTask })?.key {
                live.removeValue(forKey: id)
            }
        }
    }

    private func finish(_ id: UInt64, with response: NsiteFileServer.Response, url: URL?) {
        // Re-read rather than capture: between the request going out and the
        // bytes coming back, WebKit may well have stopped this task.
        guard let task = live[id], let url else { return }
        live.removeValue(forKey: id)

        var headers = response.headers
        headers["Content-Type"] = response.contentType
        headers["Content-Length"] = String(response.body.count)

        guard let http = HTTPURLResponse(
            url: url, statusCode: response.status,
            httpVersion: "HTTP/1.1", headerFields: headers
        ) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }

        task.didReceive(http)
        task.didReceive(response.body)
        task.didFinish()
    }

    /// Refuse everything outstanding. Called when the site is torn down, so
    /// that nothing answers into a WebView that is on its way out.
    func cancelAll() {
        live.removeAll()
    }
}
