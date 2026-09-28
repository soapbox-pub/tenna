import CSecp256k1
import CryptoKit
import Foundation
import Security

/**
 The secp256k1 side of Nostr: x-only public keys, BIP-340 Schnorr signatures,
 canonical NIP-01 event ids, and the shared secret both encryption NIPs start
 from.

 The iOS counterpart of `NostrCrypto.java`. None of the curve arithmetic is
 ours: it is libsecp256k1, vendored in `ios/App/Secp256k1`, the same library
 Android reaches through ACINQ's bindings. What is ours is the plumbing — which
 bytes go in, and the NIP-01 serialization whose hash comes out — and that is
 where a signer goes wrong silently, so `NativeKeySigner` re-derives every id
 in JavaScript and refuses one that does not match.
 */
enum NostrCrypto {

    enum Failure: LocalizedError {
        case invalidKey
        case invalidPeer
        case invalidEvent(String)
        case library

        var errorDescription: String? {
            switch self {
            case .invalidKey: return "Not a valid secret key"
            case .invalidPeer: return "peer is not a valid public key"
            case .invalidEvent(let why): return why
            case .library: return "libsecp256k1 refused the operation"
            }
        }
    }

    /**
     One context for the process, randomized once.

     Every call made with it here takes it as `const`, which libsecp256k1
     documents as safe from any thread; only `secp256k1_context_randomize`
     mutates, and that happens once, before anything else can see it.
     */
    private static let context: OpaquePointer = {
        // SECP256K1_CONTEXT_NONE.
        let ctx = secp256k1_context_create(1)!
        var seed = randomBytes(32)
        _ = secp256k1_context_randomize(ctx, &seed)
        wipe(&seed)
        return ctx
    }()

    // MARK: - Keys

    /// A fresh valid secret key from the system CSPRNG.
    static func generateSecretKey() throws -> [UInt8] {
        for _ in 0..<8 {
            let sk = randomBytes(32)
            if secp256k1_ec_seckey_verify(context, sk) == 1 { return sk }
        }
        throw Failure.library
    }

    static func isValidSecretKey(_ sk: [UInt8]) -> Bool {
        sk.count == 32 && secp256k1_ec_seckey_verify(context, sk) == 1
    }

    /// The x-only (BIP-340, Nostr) public key of a secret key, as hex.
    static func pubkey(of sk: [UInt8]) throws -> String {
        var keypair = try self.keypair(sk)
        defer { wipeKeypair(&keypair) }

        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(context, &xonly, nil, &keypair) == 1 else { throw Failure.library }
        var out = [UInt8](repeating: 0, count: 32)
        guard secp256k1_xonly_pubkey_serialize(context, &out, &xonly) == 1 else { throw Failure.library }
        return hex(out)
    }

    /**
     The x-coordinate of `sk · lift_x(peer)` — NIP-04's key as it is, and what
     NIP-44 extracts its conversation key from.

     Not libsecp's ECDH module, which hashes the point: both NIPs want the bare
     x. The even-Y lift matches nostr-tools, and a point and its negation share
     an x, so the peer's real parity does not change the answer.
     */
    static func sharedSecret(_ sk: [UInt8], peer: String) throws -> [UInt8] {
        guard let x = bytes(hex: peer), x.count == 32 else { throw Failure.invalidPeer }
        var point = secp256k1_pubkey()
        let compressed = [0x02] + x
        guard secp256k1_ec_pubkey_parse(context, &point, compressed, 33) == 1 else { throw Failure.invalidPeer }
        guard secp256k1_ec_pubkey_tweak_mul(context, &point, sk) == 1 else { throw Failure.invalidKey }

        var out = [UInt8](repeating: 0, count: 33)
        var length = 33
        // SECP256K1_EC_COMPRESSED.
        guard secp256k1_ec_pubkey_serialize(context, &out, &length, &point, 258) == 1 else { throw Failure.library }
        defer { wipe(&out) }
        return Array(out[1..<33])
    }

    /// NIP-44 v2: `HKDF-Extract(salt: "nip44-v2", ikm: sharedSecret)`.
    static func conversationKey(_ sk: [UInt8], peer: String) throws -> [UInt8] {
        var shared = try sharedSecret(sk, peer: peer)
        defer { wipe(&shared) }
        let mac = HMAC<SHA256>.authenticationCode(for: shared, using: SymmetricKey(data: Data("nip44-v2".utf8)))
        return Array(mac)
    }

    // MARK: - Events

    /**
     Id and sign an event template as the owner of `sk`.

     `template` is what `JSONSerialization` made of the web layer's JSON: the
     kind, content, tags and created_at. Any id, pubkey or sig in it is
     ignored, because those are what this computes.
     */
    static func finalize(_ template: [String: Any], sk: [UInt8]) throws -> [String: Any] {
        guard let kind = (template["kind"] as? NSNumber)?.intValue else {
            throw Failure.invalidEvent("kind is required")
        }
        let content = template["content"] as? String ?? ""
        let createdAt = (template["created_at"] as? NSNumber)?.int64Value ?? Int64(Date().timeIntervalSince1970)

        var tags: [[String]] = []
        for tag in template["tags"] as? [Any] ?? [] {
            guard let values = tag as? [Any] else { throw Failure.invalidEvent("A tag must be an array") }
            // Strings only. A number here would serialize one way in this
            // file and another in JavaScript, and the id would be wrong.
            let strings = values.compactMap { $0 as? String }
            guard strings.count == values.count else { throw Failure.invalidEvent("Tag values must be strings") }
            tags.append(strings)
        }

        let pubkey = try self.pubkey(of: sk)
        let id = eventId(pubkey: pubkey, createdAt: createdAt, kind: kind, tags: tags, content: content)
        let sig = try schnorrSign(bytes(hex: id)!, sk: sk)

        return [
            "id": id,
            "pubkey": pubkey,
            "created_at": createdAt,
            "kind": kind,
            "tags": tags,
            "content": content,
            "sig": hex(sig),
        ]
    }

    /**
     The NIP-01 id: sha256 of `[0,pubkey,created_at,kind,tags,content]`, as
     `JSON.stringify` writes it. `JSONSerialization` escapes `/` and is not
     used for this, for the reason `NostrCrypto.java` gives about org.json.
     */
    static func eventId(pubkey: String, createdAt: Int64, kind: Int, tags: [[String]], content: String) -> String {
        var out = "[0,\"\(pubkey)\",\(createdAt),\(kind),["
        for (i, tag) in tags.enumerated() {
            if i > 0 { out += "," }
            out += "["
            for (j, value) in tag.enumerated() {
                if j > 0 { out += "," }
                jsonString(&out, value)
            }
            out += "]"
        }
        out += "],"
        jsonString(&out, content)
        out += "]"
        return hex(Array(SHA256.hash(data: Data(out.utf8))))
    }

    /// A JSON string literal exactly as `JSON.stringify` writes one.
    private static func jsonString(_ out: inout String, _ s: String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\t": out += "\\t"
            case "\n": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\r": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    private static func schnorrSign(_ msg32: [UInt8], sk: [UInt8]) throws -> [UInt8] {
        var keypair = try self.keypair(sk)
        defer { wipeKeypair(&keypair) }
        var aux = randomBytes(32)
        var sig = [UInt8](repeating: 0, count: 64)
        guard secp256k1_schnorrsig_sign32(context, &sig, msg32, &keypair, &aux) == 1 else { throw Failure.library }

        // Checked before it leaves: a fault in the signing path must not
        // become a signature somebody publishes.
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(context, &xonly, nil, &keypair) == 1,
              secp256k1_schnorrsig_verify(context, sig, msg32, 32, &xonly) == 1 else { throw Failure.library }
        return sig
    }

    private static func keypair(_ sk: [UInt8]) throws -> secp256k1_keypair {
        guard sk.count == 32 else { throw Failure.invalidKey }
        var keypair = secp256k1_keypair()
        guard secp256k1_keypair_create(context, &keypair, sk) == 1 else { throw Failure.invalidKey }
        return keypair
    }

    // MARK: - Bytes

    static func randomBytes(_ count: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &out)
        precondition(status == errSecSuccess, "The system CSPRNG failed")
        return out
    }

    static func wipe(_ bytes: inout [UInt8]) {
        for i in bytes.indices { bytes[i] = 0 }
    }

    private static func wipeKeypair(_ keypair: inout secp256k1_keypair) {
        withUnsafeMutableBytes(of: &keypair) { raw in
            for i in raw.indices { raw[i] = 0 }
        }
    }

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func bytes(hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }
}
