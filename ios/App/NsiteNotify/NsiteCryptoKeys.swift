import CryptoKit
import Foundation
import Security

/**
 The keys a site's stored CryptoKeys are sealed with.

 A site's IndexedDB keeps a CryptoKey as a sealed copy, which only its vault
 can open — see `src/lib/idb/vault.ts`. The vault is handed its site's
 sealing key by the realm that starts it, before any of the site's code runs:
 by the page's user script (`NsiteSession`), and by the host page the
 notification extension runs a worker in (`NsiteWorkerHost`).

 Each site's key is derived from one master key with HKDF, the site id as
 the info, so a copy sealed for one site does not open for another. The master
 key is 32 random bytes in the Keychain, in the App Group's access group so the
 app and the extension share it, readable after the first unlock since boot —
 a push can arrive while the phone is locked — and never leaving this device:
 not in a backup, not in iCloud Keychain. A backup of the App Group restored
 elsewhere has sealed copies nothing can open, which is WebKit's behaviour for
 its own stored keys too.

 Nil when the Keychain will not give the key up — before the first unlock, or
 without the entitlement. A realm with no key has no vault: storing a
 non-extractable CryptoKey fails with a DataCloneError, and reading a stored
 one with a DataError, and nothing else changes.
 */
enum NsiteCryptoKeys {

    private static let service = "pub.soapbox.tenna.idb-sealing"
    private static let account = "master"

    private static let lock = NSLock()
    private static var cached: SymmetricKey?

    /// A site's sealing key, as base64 for a script to hand to its vault.
    static func sealingKey(for siteId: String) -> String? {
        guard let master = master() else { return nil }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: master,
            salt: Data("tenna-idb-sealing/1".utf8),
            info: Data(siteId.utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }.base64EncodedString()
    }

    private static func master() -> SymmetricKey? {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        if let found = read() {
            cached = found
            return found
        }
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { return nil }
        var add = query()
        add[kSecValueData as String] = bytes
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        // The other process may have made it first; theirs is the one.
        if added == errSecDuplicateItem, let found = read() {
            cached = found
            return found
        }
        guard added == errSecSuccess else {
            NSLog("[NsiteCryptoKeys] could not keep the master key: %d", added)
            return nil
        }
        cached = SymmetricKey(data: bytes)
        return cached
    }

    private static func read() -> SymmetricKey? {
        var find = query()
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
            if status != errSecItemNotFound { NSLog("[NsiteCryptoKeys] could not read the master key: %d", status) }
            return nil
        }
        return SymmetricKey(data: data)
    }

    private static func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: NsiteGroup.identifier,
            kSecAttrSynchronizable as String: false,
        ]
    }
}
