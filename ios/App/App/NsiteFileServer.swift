import CryptoKit
import Foundation

/**
 Serves an nsite's files to a WebView straight from Blossom.

 This is the whole reason the native path exists. The site is the WebView's
 top-level document, so it gets real safe-area insets and its own origin — but
 only if nothing has to round-trip its bytes through the Capacitor bridge to
 get there. Every request is resolved here and answered from a
 content-addressed disk cache or a direct HTTPS fetch.

 Blobs are named by sha256, so the cache never needs invalidating: a given name
 always denotes the same bytes. Reopening a site costs nothing after the first
 visit, which the iframe implementation cannot say — it re-downloads the whole
 manifest every time.

 The Swift side of `NsiteFileServer.java`, minus the one thing iOS has no use
 for: Android appends a push shim to a site's service worker script on the way
 out, and a document under a custom scheme has no service workers to append to.
 */
actor NsiteFileServer {

    /// What to send back: the transport-neutral shape of an HTTP response.
    struct Response {
        let status: Int
        let contentType: String
        let headers: [String: String]
        let body: Data

        static func text(_ status: Int, _ text: String) -> Response {
            Response(
                status: status,
                contentType: "text/plain; charset=utf-8",
                headers: ["Cache-Control": "no-store"],
                body: Data(text.utf8)
            )
        }
    }

    /// Manifest path (e.g. `/index.html`) to sha256.
    private let files: [String: String]
    private let servers: [String]
    private let cacheDirectory: URL
    private let session: URLSession

    /// The document is served again on every SPA route; sniff it once.
    private var chromeReported = false

    /// Raised on the first `/index.html`, before the renderer gets a byte.
    private let onChrome: (@Sendable (NsiteSiteChrome) -> Void)?

    /**
     The last server that successfully served a blob, tried first next time.

     Mirrors the same optimisation in `src/lib/nsiteFiles.ts`: most servers in a
     site's list don't hold most of its blobs, so without this every request
     pays for a run of 404s.
     */
    private var preferredServer: String?

    init(
        files: [String: String],
        servers: [String],
        onChrome: (@Sendable (NsiteSiteChrome) -> Void)? = nil
    ) {
        self.files = files
        self.servers = servers
        self.onChrome = onChrome
        self.cacheDirectory = Self.cacheDirectory()

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        // Our own content-addressed cache is the only one worth keeping; a
        // second, byte-identical copy in the URL cache is just disk.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.session = URLSession(configuration: config)

        try? FileManager.default.createDirectory(
            at: cacheDirectory, withIntermediateDirectories: true)
    }

    /**
     The one blob cache every server shares: blobs are named by content.

     Versioned in the name for the same reason as Android's, and named the same
     thing — the two caches never meet, but the guarantee they make is one
     guarantee and it is worth being able to say so.

     In the App Group container rather than this process's caches, because the
     notification extension is the other process that reads it and a site's
     worker has to already be on disk when a push arrives. See `NsiteGroup`.
     */
    static func cacheDirectory() -> URL {
        NsiteGroup.container.appendingPathComponent("nsite-v2", isDirectory: true)
    }

    // -----------------------------------------------------------------------
    // Serving
    // -----------------------------------------------------------------------

    func serve(_ url: URL) async -> Response {
        var path = url.path
        if path.isEmpty { path = "/" }
        if path.hasSuffix("/") { path += "index.html" }

        var sha256 = files[path]
        var servingPath = path

        // Fall back to /index.html for SPA client-side routes.
        if sha256 == nil {
            sha256 = files["/index.html"]
            servingPath = "/index.html"
        }
        guard let sha256 else { return .text(404, "Not Found") }

        let bytes: Data
        do {
            bytes = try await blob(sha256)
        } catch {
            return .text(502, "Failed to fetch \(sha256)")
        }

        if servingPath == "/index.html", !chromeReported, let onChrome {
            chromeReported = true
            onChrome(NsiteSiteChrome.read(String(decoding: bytes, as: UTF8.self)))
        }

        return Response(
            status: 200,
            contentType: NsiteMimeTypes.contentType(for: servingPath),
            headers: [
                // The blob itself is immutable, but the path it answers to
                // isn't: /index.html means something different after the site
                // publishes again. Our own sha256 cache is the one that's safe
                // to keep.
                "Cache-Control": "no-cache",
                // The type is read off the manifest's path, so a site names it
                // by choosing a file extension. Without this the renderer is
                // free to disagree and sniff a script out of something
                // declared otherwise.
                "X-Content-Type-Options": "nosniff",
                // Every site here is a sibling on `nsite.localhost`, served by
                // this same code. Nothing one site is made of is another's to
                // embed: no <script src> from a neighbour's origin, no images,
                // no fonts.
                "Cross-Origin-Resource-Policy": "same-origin",
            ],
            body: bytes
        )
    }

    /**
     One named file, or nothing.

     `serve` falls back to `/index.html` for anything the manifest does not
     have, because a site's client-side routes are the ordinary case for a
     document. Nothing else wants that: a worker asked for at a path the site
     never published must come back missing rather than as a page of HTML with
     a JavaScript content type on it. So the extension asks through here.
     */
    func file(_ path: String) async -> (Data, String)? {
        guard let sha256 = files[path], let bytes = try? await blob(sha256) else { return nil }
        return (bytes, NsiteMimeTypes.contentType(for: path))
    }

    /// Put a file in the cache now, so a push that needs it later does not have
    /// to reach the network from inside an extension. Answers whether it is there.
    @discardableResult
    func warm(_ path: String) async -> Bool {
        await file(path) != nil
    }

    // -----------------------------------------------------------------------
    // Blob retrieval
    // -----------------------------------------------------------------------

    private enum BlobError: Error {
        case notAName
        case escapesCache
        case noServer
        case badStatus(Int)
        case wrongContent(served: String, wanted: String)
    }

    /// The cached blob for a sha256, downloading it first if necessary.
    private func blob(_ sha256: String) async throws -> Data {
        // The manifest was filtered on the way in, on both sides of the
        // bridge, but this is the line that turns the string into a path and
        // so it is the line that has to be sure. See NsiteBlobs.
        guard NsiteBlobs.isName(sha256) else { throw BlobError.notAName }

        let cached = cacheDirectory.appendingPathComponent(sha256, isDirectory: false)
        guard cached.deletingLastPathComponent().standardizedFileURL.path
                == cacheDirectory.standardizedFileURL.path else {
            throw BlobError.escapesCache
        }

        if let data = try? Data(contentsOf: cached), !data.isEmpty { return data }

        var lastError: Error = BlobError.noServer

        var ordered = servers
        if let preferred = preferredServer, let index = ordered.firstIndex(of: preferred) {
            ordered.remove(at: index)
            ordered.insert(preferred, at: 0)
        }

        for server in ordered {
            do {
                return try await download(from: server, sha256: sha256, to: cached)
            } catch {
                lastError = error
            }
        }

        throw lastError
    }

    /**
     Download a blob, check it is the blob that was asked for, and cache it.

     **The bytes are hashed before anything else sees them.** A Blossom server
     is named by a `server` tag on the manifest, which is the publisher's choice
     and not the reader's, so the content address is the only thing that makes a
     mirror untrusted infrastructure rather than a host. It matters more here
     than on the web, because the cache is shared by every site in the app and a
     blob is stored under the name that was *requested*: an unverified answer
     would let one site's chosen server poison a file another site is made of,
     and hand it script at that site's origin with that site's stored
     permissions. A server that fails is treated as one that did not have the
     blob, and the next is tried.

     Written to a temp file and moved into place so a failed or truncated
     transfer never becomes a cached file.
     */
    private func download(from server: String, sha256: String, to destination: URL) async throws -> Data {
        var base = server
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: "\(base)/\(sha256)") else {
            throw BlobError.badStatus(0)
        }

        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw BlobError.badStatus(http.statusCode)
        }

        let served = NsiteBlobs.hex(SHA256.hash(data: data))
        guard served == sha256 else {
            throw BlobError.wrongContent(served: served, wanted: sha256)
        }

        let temp = cacheDirectory.appendingPathComponent(
            "tmp-\(UUID().uuidString)", isDirectory: false)
        do {
            try data.write(to: temp, options: .atomic)
            // Another request for the same blob may have won the race, which
            // is fine — the content is identical either way.
            if FileManager.default.fileExists(atPath: destination.path) {
                try? FileManager.default.removeItem(at: temp)
            } else {
                try FileManager.default.moveItem(at: temp, to: destination)
            }
        } catch {
            try? FileManager.default.removeItem(at: temp)
            // The bytes are verified and in hand; failing to cache them is a
            // reason to be slower next time, not to fail this request.
        }

        preferredServer = server
        return data
    }
}
