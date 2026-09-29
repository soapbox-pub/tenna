import UIKit
import UniformTypeIdentifiers

/**
 Tenna's entry in the share sheet.

 The iOS counterpart of `NsiteShareActivity.java`, and deliberately smaller:
 it decides nothing. What was shared is staged in the App Group
 (`NsiteShares`), and Tenna is opened on its token, where the wall asks which
 site it is for — the same picker Android shows for a share sent to Tenna
 itself. Which sites take what, and how each wants it delivered, is read from
 their manifests in the web layer, and none of that is here.

 An extension has no public way to open its containing app, so the one it has
 is used: `openURL:options:completionHandler:` on the `UIApplication` found up
 the responder chain, which is what every share extension that hands off to
 its app does.
 */
final class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x15 / 255, green: 0x06 / 255, blue: 0x09 / 255, alpha: 1)

        let label = UILabel()
        label.text = "Sending to Tenna…"
        label.textColor = UIColor(red: 0x7c / 255, green: 0xfc / 255, blue: 0x9b / 255, alpha: 1)
        label.font = .preferredFont(forTextStyle: .title3)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { @MainActor in await share() }
    }

    private func share() async {
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        var title: String?
        var text: String?
        var link: String?
        var files: [NsiteShares.Incoming] = []

        for item in items {
            if title == nil, let value = item.attributedTitle?.string, !value.isEmpty { title = value }
            if text == nil, let value = item.attributedContentText?.string, !value.isEmpty { text = value }

            for provider in item.attachments ?? [] {
                if let file = await Self.file(from: provider, into: scratch) {
                    if files.count < NsiteShares.maxFiles { files.append(file) }
                } else if link == nil, let url = await Self.link(from: provider) {
                    link = url
                } else if let value = await Self.text(from: provider) {
                    text = text.map { "\($0)\n\(value)" } ?? value
                }
            }
        }

        // A caption that only repeats the link says nothing the link does not.
        if let found = text, found == link { text = nil }

        do {
            let token = try NsiteShares.stage(title: title, text: text, url: link, files: files)
            if let url = NsiteShares.url(for: token) { open(url) }
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            NSLog("[TennaShare] could not stage the share: %@", error.localizedDescription)
            extensionContext?.cancelRequest(withError: error)
        }
    }

    // MARK: - Reading what was shared

    /// A web link, and nothing else: a file URL is a file.
    private static func link(from provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
              let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
              let url = (item as? URL) ?? (item as? String).flatMap(URL.init(string:)) ?? (item as? Data)
                .flatMap({ URL(dataRepresentation: $0, relativeTo: nil) }),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return url.absoluteString
    }

    private static func text(from provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
              let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) else {
            return nil
        }
        if let text = item as? String { return text }
        if let data = item as? Data { return String(data: data, encoding: .utf8) }
        if let url = item as? URL { return try? String(contentsOf: url, encoding: .utf8) }
        return nil
    }

    /**
     A file, copied out of the system's hands into `scratch`.

     The type is the first one the provider offers that is a file with a MIME
     type — a photo from Photos is `public.heic` or `public.jpeg`, not the
     `public.image` it also answers to. A plain-text or link item is left for
     the two readers above.
     */
    private static func file(from provider: NSItemProvider, into scratch: URL) async -> NsiteShares.Incoming? {
        let type = provider.registeredTypeIdentifiers.lazy
            .compactMap { UTType($0) }
            .first { type in
                type.conforms(to: .data) && type.preferredMIMEType != nil
                    && !type.conforms(to: .url) && !type.conforms(to: .plainText)
            }
            ?? provider.registeredTypeIdentifiers.lazy.compactMap { UTType($0) }
                .first { $0.conforms(to: .plainText) && $0 != .plainText && $0 != .utf8PlainText }
        guard let type else { return nil }

        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: nil)
                    return
                }
                // Only valid inside this closure, so copied now.
                let name = provider.suggestedName.map { name in
                    name.contains(".") ? name : name + "." + (type.preferredFilenameExtension ?? "")
                } ?? url.lastPathComponent
                let copy = scratch.appendingPathComponent(UUID().uuidString)
                do {
                    try FileManager.default.copyItem(at: url, to: copy)
                    continuation.resume(returning: NsiteShares.Incoming(
                        url: copy, name: name, type: type.preferredMIMEType ?? "application/octet-stream"))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    // MARK: - Opening Tenna

    private func open(_ url: URL) {
        let selector = sel_registerName("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector), current is UIApplication {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let method = unsafeBitCast(current.method(for: selector), to: Open.self)
                method(current, selector, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = current.next
        }
        NSLog("[TennaShare] found nothing to open Tenna with")
    }
}
