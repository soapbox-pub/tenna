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

            if let answer = Self.indexedDB(url) {
                finish(id, with: answer, url: url)
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

    // MARK: - IndexedDB for workers

    /// The marker a worker's script URL carries when the engine must load
    /// ahead of it, with `classic` or `module` for how. See `entry.ts`.
    static let workerMarker = "__tenna_idb_worker"

    /**
     Tenna's answers under the site's origin: the IndexedDB engine, and the
     wrapper a worker the site starts is really started with — the engine,
     then the site's own script, which is loaded rather than inlined so that
     it is still a script of its own with its own `'use strict'`, and at a URL
     in the same directory, so the worker resolves relative URLs as the site
     meant.
     */
    private static func indexedDB(_ url: URL) -> NsiteFileServer.Response? {
        let engine = "/.tenna/idb.js"
        if url.path == engine {
            guard let script = NsiteIndexedDB.script else { return nil }
            return javascript(script)
        }
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let kind = parts.queryItems?.first(where: { $0.name == workerMarker })?.value else { return nil }
        parts.queryItems = parts.queryItems?.filter { $0.name != workerMarker }
        if parts.queryItems?.isEmpty == true { parts.queryItems = nil }
        let original = parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
        let source = kind == "module"
            ? "import \(jsString(engine));\nimport \(jsString(original));\n"
            : "importScripts(\(jsString(engine)), \(jsString(original)));\n"
        return javascript(source)
    }

    private static func javascript(_ source: String) -> NsiteFileServer.Response {
        NsiteFileServer.Response(
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            headers: ["Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"],
            body: Data(source.utf8)
        )
    }

    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return "\"\"" }
        return json
    }

    /// Refuse everything outstanding. Called when the site is torn down, so
    /// that nothing answers into a WebView that is on its way out.
    func cancelAll() {
        live.removeAll()
    }
}
