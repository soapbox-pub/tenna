import Foundation

/**
 What a blob is allowed to be called.

 The Swift side of the same rule in `src/lib/nsiteFiles.ts` and
 `NsiteBlobs.java`, and one of the three places the app decides it.

 A manifest's sha256 is a string off a stranger's event tag that this app then
 uses as a path — the tail of a Blossom URL on the way out, the name of a file
 in the shared cache on the way back. Both readings are dangerous if the string
 is not what it claims to be: `../../Library/Preferences/foo.plist` is a
 perfectly good dictionary key and a perfectly good traversal out of the cache
 directory into the app's private storage, which the site would then be served
 from its own origin and could read at its leisure.

 So a name is thirty-two bytes of lowercase hex or it is not a name.
 */
enum NsiteBlobs {

    /// Whether a manifest's sha256 is a name a blob can actually have.
    static func isName(_ value: String?) -> Bool {
        guard let value, value.utf8.count == 64 else { return false }
        // Written out rather than done with a regex because this runs for
        // every request and the rule is three comparisons.
        return value.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)
        }
    }

    /// Whether a manifest's path is one a request could ask for.
    static func isPath(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.hasPrefix("/")
    }

    /// Lowercase hex for a digest.
    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        let table = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(64)
        for byte in digest {
            out.append(table[Int(byte >> 4)])
            out.append(table[Int(byte & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}
