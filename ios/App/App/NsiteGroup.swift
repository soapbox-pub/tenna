import Foundation

/**
 The one directory the app and the notification extension both have.

 An extension is a separate process with a container of its own, so everything
 `NsiteNotify` needs to answer a push has to be somewhere the app can put it and
 the extension can read it. That is an App Group, and there is nothing else: the
 extension cannot ask the app for anything, because the app is not running.

 Two things live here. The **blob cache**, so a site's own files — its service
 worker above all — are on disk before the push that needs them arrives; and the
 **site records**, so the extension knows which sites exist, what they
 subscribed to, and whether the user has muted them. See `NsiteStore`.

 ## When there is no group

 `containerURL` returns nil when the entitlement is missing — an old
 provisioning profile, a target that was never given the capability. Rather than
 fail, everything falls back to the process's own caches directory, which is
 where the blob cache lived before this existed. The app then works exactly as
 it did, and the extension simply finds no sites and shows the server's own
 text. A degraded notification is the right failure for a missing entitlement;
 a crash on launch is not.
 */
enum NsiteGroup {

    /// Declared in both targets' entitlements, and on the App ID.
    static let identifier = "group.pub.soapbox.tenna"

    /// The shared container, or this process's own caches if there isn't one.
    static let container: URL = {
        if let shared = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: identifier) {
            return shared
        }
        NSLog("[NsiteGroup] no shared container; falling back to this process's caches")
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    }()

    /// Whether the app and the extension are actually looking at the same place.
    static var shared: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) != nil
    }

    /// A subdirectory of the container, created if it is not there yet.
    static func directory(_ name: String) -> URL {
        let url = container.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
