import Foundation

/**
 What the share sheet handed Tenna, kept on disk until a site takes it.

 The iOS counterpart of `NsiteShares.java`, and the meeting point of two
 processes: the share extension writes a share here and opens Tenna with its
 token, and the app reads it back when the user has picked a site. Only the
 token ever crosses — a shared video is not going into a URL.

 A share is a directory in the App Group named by its token, holding
 `share.json` (the text fields and each file's name, type and size) and the
 files themselves, named by their index. Tokens are random UUIDs, and nothing
 serves a file from here except to the site the user sent the share to.
 */
enum NsiteShares {

    /// Ceilings on one share: what a phone would plausibly send a site, and
    /// what a site's worker can be handed without falling over.
    static let maxFiles = 10
    static let maxBytes: Int64 = 100 * 1024 * 1024

    /// A share nobody came for is let go after a day.
    private static let lifetime: TimeInterval = 24 * 60 * 60

    private static var directory: URL { NsiteGroup.directory("nsite-shares") }

    static func isToken(_ token: String) -> Bool {
        UUID(uuidString: token) != nil
    }

    private static func folder(_ token: String) -> URL? {
        guard isToken(token) else { return nil }
        return directory.appendingPathComponent(token.lowercased(), isDirectory: true)
    }

    // MARK: - Writing, from the extension

    /// One file to stage: where the system put it, and what to call it.
    struct Incoming {
        let url: URL
        let name: String
        let type: String
    }

    /**
     Stage a share and return its token.

     Files are copied, not moved: the ones the system hands an extension are
     its own and are cleaned up when the extension goes.
     */
    static func stage(title: String?, text: String?, url: String?, files: [Incoming]) throws -> String {
        sweep()
        let token = UUID().uuidString.lowercased()
        guard let folder = folder(token) else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        var records: [[String: Any]] = []
        var total: Int64 = 0
        for file in files.prefix(maxFiles) {
            let size = (try? file.url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            guard total + size <= maxBytes else { break }
            let index = records.count
            try FileManager.default.copyItem(at: file.url, to: folder.appendingPathComponent(String(index)))
            total += size
            records.append(["index": index, "name": file.name, "type": file.type, "size": size])
        }

        var payload: [String: Any] = ["files": records, "created": Date().timeIntervalSince1970]
        if let title, !title.isEmpty { payload["title"] = title }
        if let text, !text.isEmpty { payload["text"] = text }
        if let url, !url.isEmpty { payload["url"] = url }

        let data = try JSONSerialization.data(withJSONObject: payload)
        try data.write(to: folder.appendingPathComponent("share.json"), options: .atomic)
        return token
    }

    // MARK: - Reading, in the app

    /// The share's text fields and file metadata, in the shape
    /// `NsiteSharePayload` has in the web layer.
    static func payload(_ token: String) -> [String: Any]? {
        guard let folder = folder(token),
              let data = try? Data(contentsOf: folder.appendingPathComponent("share.json")),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        object.removeValue(forKey: "created")
        return object
    }

    /// One staged file's bytes, and its type, for the site it was sent to.
    static func file(_ token: String, index: Int) -> (URL, String)? {
        guard let folder = folder(token), let payload = payload(token),
              let files = payload["files"] as? [[String: Any]],
              let record = files.first(where: { ($0["index"] as? NSNumber)?.intValue == index }) else { return nil }
        let url = folder.appendingPathComponent(String(index))
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return (url, record["type"] as? String ?? "application/octet-stream")
    }

    static func release(_ token: String) {
        guard let folder = folder(token) else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    /// Let go of every share older than a day.
    static func sweep() {
        let cutoff = Date().addingTimeInterval(-lifetime)
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.creationDateKey])) ?? []
        for entry in entries {
            let created = (try? entry.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            if created < cutoff { try? FileManager.default.removeItem(at: entry) }
        }
    }

    // MARK: - The URL that opens Tenna on one

    /// Tenna's own scheme for a share the extension has just staged. Handled
    /// natively in `SceneDelegate` and never passed to the web layer as a link.
    static let scheme = "tenna-share"

    static func url(for token: String) -> URL? {
        URL(string: "\(scheme):\(token)")
    }

    static func token(in url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let token = url.absoluteString.dropFirst(scheme.count + 1)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return isToken(token) ? token.lowercased() : nil
    }
}
