import Foundation

/**
 MIME type lookup for files served out of an nsite manifest.

 Mirrors `src/lib/sandbox/mimeTypes.ts` and `NsiteMimeTypes.java`. Manifest
 paths carry no content type of their own — the sha256 is all Blossom knows
 about a blob — so the extension is the only signal any of the three
 implementations has.
 */
enum NsiteMimeTypes {

    private static let types: [String: String] = [
        "html": "text/html",
        "htm": "text/html",
        "css": "text/css",
        "js": "application/javascript",
        "mjs": "application/javascript",
        "json": "application/json",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "svg": "image/svg+xml",
        "webp": "image/webp",
        "ico": "image/x-icon",
        "bmp": "image/bmp",
        "avif": "image/avif",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "otf": "font/otf",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "wav": "audio/wav",
        "opus": "audio/opus",
        "weba": "audio/webm",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "xml": "application/xml",
        "txt": "text/plain",
        "md": "text/markdown",
        "wasm": "application/wasm",
        "pdf": "application/pdf",
        "toml": "application/toml",
    ]

    static func of(_ path: String) -> String {
        guard let dot = path.lastIndex(of: ".") else { return "application/octet-stream" }
        let ext = String(path[path.index(after: dot)...]).lowercased()
        return types[ext] ?? "application/octet-stream"
    }

    /**
     The charset to declare, or nil for binary.

     Unlike Android's `WebResourceResponse`, which keeps the type and the
     encoding in separate fields, a `URLResponse` carries one `Content-Type`
     string — so this is appended to the type rather than passed beside it. The
     rule about which types get one is the same either way.
     */
    static func encodingFor(_ mimeType: String) -> String? {
        if mimeType.hasPrefix("text/") { return "utf-8" }
        switch mimeType {
        case "application/javascript", "application/json", "application/xml",
             "application/toml", "image/svg+xml":
            return "utf-8"
        default:
            return nil
        }
    }

    /// The full `Content-Type` header value for a path.
    static func contentType(for path: String) -> String {
        let type = of(path)
        guard let charset = encodingFor(type) else { return type }
        return "\(type); charset=\(charset)"
    }
}
