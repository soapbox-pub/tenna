import Foundation
import Security

/**
 Where a logged-in user's secret key lives on iOS: in the Keychain, readable
 by this app alone, and unsealed only in this process.

 The iOS counterpart of `TennaKeys.java`, and it exists for the same reason.
 The key used to be read back out of the Keychain into the web layer and
 signed with there, which put it in the WebContent process every time — the
 process that parses bytes from the open internet for whatever site the user
 opened. WebKit runs that process apart from the app's, so a key that stays on
 this side is not in the address space a compromised renderer has. What that
 renderer gets instead is the bridge: it can ask for signatures, as the user,
 for as long as it is resident, and not the key itself. That is a trade and
 not a fix, and `TennaKeys.java` says so at more length.

 The same two consequences follow:

 - **There is no export.** Nothing here returns a stored key. `generate` hands
   back the key it has just made, once, so the signup screen can show it.
 - **The item is device-bound, not user-bound.** No access control asks for
   Face ID: that would stop somebody holding the unlocked phone and do nothing
   about the attacker this is about, who is already inside the process that
   would be asking.

 One generic-password item per account, keyed by x-only pubkey. The access
 group is left to default, which is this app's own — the notification
 extension cannot read these, and has no reason to. Readable after the first
 unlock since boot, never synchronized, never in a backup that could be
 restored to another phone.
 */
enum TennaKeys {

    private static let service = "pub.soapbox.tenna.nostr-key"

    private static let lock = NSLock()

    /// Keys already read, by pubkey. The Keychain is a round trip to
    /// `securityd`, and a site asking for twenty signatures is one gesture.
    private static var memory: [String: [UInt8]] = [:]

    /// Keep a key and say whose it is.
    static func importKey(_ sk: [UInt8]) throws -> String {
        guard NostrCrypto.isValidSecretKey(sk) else { throw NostrCrypto.Failure.invalidKey }
        let pubkey = try NostrCrypto.pubkey(of: sk)

        lock.lock()
        defer { lock.unlock() }

        var add = query(pubkey)
        add[kSecValueData as String] = Data(sk)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // The same account again. The key is a function of nothing but
            // itself, so what is stored is already this.
            status = SecItemUpdate(query(pubkey) as CFDictionary, [kSecValueData as String: Data(sk)] as CFDictionary)
        }
        guard status == errSecSuccess else {
            NSLog("[TennaKeys] could not keep a key: %d", status)
            throw KeychainFailure(status: status)
        }
        memory[pubkey] = sk
        return pubkey
    }

    /// Make an account, keep it, and return its key this one time.
    static func generate() throws -> [UInt8] {
        let sk = try NostrCrypto.generateSecretKey()
        _ = try importKey(sk)
        return sk
    }

    /// The key for `pubkey`, or nil when this device does not hold it.
    static func get(_ pubkey: String) -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        if let sk = memory[pubkey] { return sk }

        var find = query(pubkey)
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
            if status != errSecItemNotFound { NSLog("[TennaKeys] could not read a key: %d", status) }
            return nil
        }
        let sk = [UInt8](data)
        memory[pubkey] = sk
        return sk
    }

    /// Every account this device can sign for.
    static func pubkeys() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return stored()
    }

    /**
     Keep these and forget the rest; answer how many were forgotten.

     The web layer decides what "the rest" is, and guards against acting on a
     login list it has not got a real answer for — see `NativeKeys.tsx`.
     */
    static func retain(_ keep: Set<String>) -> Int {
        lock.lock()
        defer { lock.unlock() }

        var forgotten = 0
        for pubkey in stored() where !keep.contains(pubkey) {
            let status = SecItemDelete(query(pubkey) as CFDictionary)
            if status == errSecSuccess { forgotten += 1 }
            if var sk = memory.removeValue(forKey: pubkey) { NostrCrypto.wipe(&sk) }
        }
        return forgotten
    }

    // MARK: - The Keychain

    /// Callers hold `lock`.
    private static func stored() -> [String] {
        let find: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    private static func query(_ pubkey: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: pubkey,
            kSecAttrSynchronizable as String: false,
        ]
    }

    struct KeychainFailure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "The Keychain refused the key (\(status))" }
    }
}
