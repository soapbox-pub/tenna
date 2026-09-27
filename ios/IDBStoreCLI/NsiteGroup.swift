import Foundation

/// The command line has no App Group; `main.swift` sets the store's location
/// itself, and this only satisfies the default the store is compiled with.
enum NsiteGroup {
    static func directory(_ name: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name, isDirectory: true)
    }
}
