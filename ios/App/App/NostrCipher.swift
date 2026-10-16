import CommonCrypto
import CryptoKit
import Foundation

/**
 NIP-44 v2 and NIP-04, the two ways Nostr encrypts a message to one person.

 The iOS counterpart of `NostrCipher.java`, and like it, every failure returns
 nil and says nothing about which check failed: a caller that could tell a bad
 MAC from bad padding has an oracle, and the site asking is not necessarily
 friendly.

 ChaCha20 is written out here because CryptoKit only offers it sealed inside
 ChaChaPoly, whose keystream starts at block 1; NIP-44 starts at block 0.
 */
enum NostrCipher {

    // MARK: - NIP-44 v2

    static func encrypt44(conversationKey: [UInt8], plaintext: String) -> String? {
        encrypt44(conversationKey: conversationKey, plaintext: plaintext, nonce: NostrCrypto.randomBytes(32))
            .map { Data($0).base64EncodedString() }
    }

    static func encrypt44(conversationKey: [UInt8], plaintext: String, nonce: [UInt8]) -> [UInt8]? {
        guard conversationKey.count == 32, nonce.count == 32 else { return nil }
        let unpadded = Array(plaintext.utf8)
        guard (1...Int(UInt32.max)).contains(unpadded.count) else { return nil }

        let (chachaKey, chachaNonce, hmacKey) = messageKeys(conversationKey, nonce)
        let padded = pad(unpadded)
        let ciphertext = chacha20(key: chachaKey, nonce: chachaNonce, input: padded)
        let mac = hmac(hmacKey, nonce + ciphertext)
        return [2] + nonce + ciphertext + mac
    }

    static func decrypt44(conversationKey: [UInt8], payload: String) -> String? {
        guard !payload.isEmpty, !payload.hasPrefix("#"),
              let data = Data(base64Encoded: payload) else { return nil }
        return decrypt44(conversationKey: conversationKey, data: [UInt8](data))
    }

    static func decrypt44(conversationKey: [UInt8], data: [UInt8]) -> String? {
        // version(1) + nonce(32) + ciphertext(>= 34) + mac(32).
        guard conversationKey.count == 32, data.count >= 99, data[0] == 2 else { return nil }

        let nonce = Array(data[1..<33])
        let ciphertext = Array(data[33..<(data.count - 32)])
        let mac = Array(data[(data.count - 32)...])

        let (chachaKey, chachaNonce, hmacKey) = messageKeys(conversationKey, nonce)
        guard constantTimeEquals(hmac(hmacKey, nonce + ciphertext), mac) else { return nil }

        return unpad(chacha20(key: chachaKey, nonce: chachaNonce, input: ciphertext))
    }

    private static func messageKeys(_ conversationKey: [UInt8], _ nonce: [UInt8]) -> ([UInt8], [UInt8], [UInt8]) {
        let keys = HKDF<SHA256>.expand(
            pseudoRandomKey: SymmetricKey(data: conversationKey),
            info: Data(nonce),
            outputByteCount: 76
        ).withUnsafeBytes { Array($0) }
        return (Array(keys[0..<32]), Array(keys[32..<44]), Array(keys[44..<76]))
    }

    static func paddedLength(_ length: Int) -> Int {
        if length <= 32 { return 32 }
        var nextPower = 1
        while nextPower < length { nextPower <<= 1 }
        let chunk = nextPower <= 256 ? 32 : nextPower / 8
        return chunk * ((length - 1) / chunk + 1)
    }

    /// Plaintexts this long or longer take the extended u32 length prefix.
    private static let extendedPrefixThreshold = 65536

    /// `[u16-BE len][plaintext][zeros]`, or `[0x0000][u32-BE len][plaintext][zeros]`
    /// from 64 KiB up.
    private static func pad(_ unpadded: [UInt8]) -> [UInt8] {
        let length = unpadded.count
        let prefix: [UInt8] = length >= extendedPrefixThreshold
            ? [0, 0, UInt8(length >> 24 & 0xff), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff)]
            : [UInt8(length >> 8), UInt8(length & 0xff)]
        return prefix + unpadded + [UInt8](repeating: 0, count: paddedLength(length) - length)
    }

    private static func unpad(_ padded: [UInt8]) -> String? {
        guard padded.count >= 2 else { return nil }
        var length = Int(padded[0]) << 8 | Int(padded[1])
        var prefixLength = 2
        if length == 0 {
            guard padded.count >= 6 else { return nil }
            length = Int(padded[2]) << 24 | Int(padded[3]) << 16 | Int(padded[4]) << 8 | Int(padded[5])
            guard length >= extendedPrefixThreshold else { return nil }
            prefixLength = 6
        }
        guard length >= 1, prefixLength + length <= padded.count,
              padded.count == prefixLength + paddedLength(length) else { return nil }
        return String(bytes: padded[prefixLength..<(prefixLength + length)], encoding: .utf8)
    }

    // MARK: - NIP-04

    static func encrypt04(sharedSecret: [UInt8], plaintext: String) -> String? {
        let iv = NostrCrypto.randomBytes(16)
        guard let ciphertext = aesCBC(encrypt: true, key: sharedSecret, iv: iv, input: Array(plaintext.utf8)) else {
            return nil
        }
        return Data(ciphertext).base64EncodedString() + "?iv=" + Data(iv).base64EncodedString()
    }

    static func decrypt04(sharedSecret: [UInt8], payload: String) -> String? {
        guard let at = payload.range(of: "?iv="),
              let ciphertext = Data(base64Encoded: String(payload[..<at.lowerBound])),
              let iv = Data(base64Encoded: String(payload[at.upperBound...])), iv.count == 16,
              let plain = aesCBC(encrypt: false, key: sharedSecret, iv: [UInt8](iv), input: [UInt8](ciphertext))
        else { return nil }
        return String(bytes: plain, encoding: .utf8)
    }

    private static func aesCBC(encrypt: Bool, key: [UInt8], iv: [UInt8], input: [UInt8]) -> [UInt8]? {
        guard key.count == 32, iv.count == 16 else { return nil }
        var out = [UInt8](repeating: 0, count: input.count + kCCBlockSizeAES128)
        var written = 0
        let status = CCCrypt(
            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt),
            CCAlgorithm(kCCAlgorithmAES),
            CCOptions(kCCOptionPKCS7Padding),
            key, key.count, iv, input, input.count, &out, out.count, &written
        )
        guard status == kCCSuccess else { return nil }
        return Array(out[0..<written])
    }

    // MARK: - Primitives

    private static func hmac(_ key: [UInt8], _ message: [UInt8]) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    private static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in a.indices { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// RFC 8439 ChaCha20 with a 12-byte nonce and the block counter from 0.
    static func chacha20(key: [UInt8], nonce: [UInt8], input: [UInt8]) -> [UInt8] {
        var state = [UInt32](repeating: 0, count: 16)
        state[0] = 0x61707865
        state[1] = 0x3320646e
        state[2] = 0x79622d32
        state[3] = 0x6b206574
        for i in 0..<8 { state[4 + i] = le32(key, i * 4) }
        state[12] = 0
        state[13] = le32(nonce, 0)
        state[14] = le32(nonce, 4)
        state[15] = le32(nonce, 8)

        var out = [UInt8](repeating: 0, count: input.count)
        var x = [UInt32](repeating: 0, count: 16)
        var offset = 0
        while offset < input.count {
            for i in 0..<16 { x[i] = state[i] }
            for _ in 0..<10 {
                quarterRound(&x, 0, 4, 8, 12)
                quarterRound(&x, 1, 5, 9, 13)
                quarterRound(&x, 2, 6, 10, 14)
                quarterRound(&x, 3, 7, 11, 15)
                quarterRound(&x, 0, 5, 10, 15)
                quarterRound(&x, 1, 6, 11, 12)
                quarterRound(&x, 2, 7, 8, 13)
                quarterRound(&x, 3, 4, 9, 14)
            }
            let n = min(64, input.count - offset)
            for i in 0..<n {
                let word = x[i / 4] &+ state[i / 4]
                let byte = UInt8(truncatingIfNeeded: word >> (UInt32(i % 4) * 8))
                out[offset + i] = input[offset + i] ^ byte
            }
            offset += n
            state[12] &+= 1
        }
        return out
    }

    private static func quarterRound(_ x: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        x[a] &+= x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 16)
        x[c] &+= x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 12)
        x[a] &+= x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 8)
        x[c] &+= x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 7)
    }

    private static func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 {
        (v << n) | (v >> (32 - n))
    }

    private static func le32(_ b: [UInt8], _ off: Int) -> UInt32 {
        UInt32(b[off]) | UInt32(b[off + 1]) << 8 | UInt32(b[off + 2]) << 16 | UInt32(b[off + 3]) << 24
    }
}
