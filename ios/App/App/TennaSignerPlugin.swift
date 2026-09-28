import Capacitor
import Foundation

/**
 A signer in the app process, for keys the web layer is not allowed to hold.

 The iOS counterpart of `TennaSignerPlugin.java`, answering the same interface
 (`src/lib/tennaSignerPlugin.ts`) so `NativeKeySigner` and the login paths do
 not branch. Every method names an account by pubkey and gets back a result;
 none takes a key or returns one, except `generate`, once. See `TennaKeys`.

 **Only Tenna's own window can reach this.** A site runs in a `WKWebView` of
 its own with no Capacitor bridge in it (`NsiteSession`), and its
 `window.nostr` posts to the web layer, which asks the user before it calls a
 method here.

 Events cross as JSON text in both directions, because the id is a hash of
 the tags' exact bytes and Capacitor's coercion of nested arrays is not
 something to hash.
 */
@objc(TennaSignerPlugin)
public class TennaSignerPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TennaSignerPlugin"
    public let jsName = "TennaSigner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retainKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAccounts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nip44Encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nip44Decrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nip04Encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nip04Decrypt", returnType: CAPPluginReturnPromise),
    ]

    /// libsecp256k1 is compiled in, so there is no ABI to be missing.
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func generate(_ call: CAPPluginCall) {
        do {
            let sk = try TennaKeys.generate()
            call.resolve(["pubkey": try NostrCrypto.pubkey(of: sk), "secretKey": NostrCrypto.hex(sk)])
        } catch {
            call.reject("Could not create a key: \(error.localizedDescription)")
        }
    }

    @objc func importKey(_ call: CAPPluginCall) {
        guard let hex = call.getString("secretKey"), var sk = NostrCrypto.bytes(hex: hex), sk.count == 32 else {
            call.reject("secretKey must be 32 bytes of hex")
            return
        }
        defer { NostrCrypto.wipe(&sk) }
        do {
            call.resolve(["pubkey": try TennaKeys.importKey(sk)])
        } catch {
            call.reject("Could not keep the key: \(error.localizedDescription)")
        }
    }

    @objc func listKeys(_ call: CAPPluginCall) {
        call.resolve(["pubkeys": TennaKeys.pubkeys()])
    }

    @objc func retainKeys(_ call: CAPPluginCall) {
        guard let given = call.getArray("pubkeys") else {
            call.reject("pubkeys is required")
            return
        }
        let keep = Set(given.compactMap { $0 as? String })
        call.resolve(["forgotten": TennaKeys.retain(keep)])
    }

    /**
     Who is signed in.

     Android keeps a copy for the paths that run with no WebView — a NIP-55
     query, a remote signing request on a background socket. iOS has neither,
     so there is nothing here to read it, and it is accepted and let go rather
     than written somewhere nothing will look.
     */
    @objc func setAccounts(_ call: CAPPluginCall) {
        guard call.getString("accounts") != nil else {
            call.reject("accounts is required")
            return
        }
        call.resolve()
    }

    // MARK: - Signing

    @objc func signEvent(_ call: CAPPluginCall) {
        guard let pubkey = call.getString("pubkey"), let text = call.getString("event") else {
            call.reject("pubkey and event are required")
            return
        }
        guard let sk = TennaKeys.get(pubkey) else {
            call.reject("No key on this device for that account")
            return
        }
        guard let data = text.data(using: .utf8),
              let template = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            call.reject("event must be a JSON object")
            return
        }

        do {
            let signed = try NostrCrypto.finalize(template, sk: sk)
            let json = try JSONSerialization.data(withJSONObject: signed)
            call.resolve(["event": String(decoding: json, as: UTF8.self)])
        } catch {
            call.reject("Could not sign the event: \(error.localizedDescription)")
        }
    }

    // MARK: - Encryption

    @objc func nip44Encrypt(_ call: CAPPluginCall) {
        crypt(call, input: "plaintext", failure: "Could not encrypt") { sk, peer, plaintext in
            var key = try NostrCrypto.conversationKey(sk, peer: peer)
            defer { NostrCrypto.wipe(&key) }
            return NostrCipher.encrypt44(conversationKey: key, plaintext: plaintext)
        }
    }

    @objc func nip44Decrypt(_ call: CAPPluginCall) {
        crypt(call, input: "ciphertext", failure: "Could not decrypt") { sk, peer, ciphertext in
            var key = try NostrCrypto.conversationKey(sk, peer: peer)
            defer { NostrCrypto.wipe(&key) }
            return NostrCipher.decrypt44(conversationKey: key, payload: ciphertext)
        }
    }

    @objc func nip04Encrypt(_ call: CAPPluginCall) {
        crypt(call, input: "plaintext", failure: "Could not encrypt") { sk, peer, plaintext in
            var shared = try NostrCrypto.sharedSecret(sk, peer: peer)
            defer { NostrCrypto.wipe(&shared) }
            return NostrCipher.encrypt04(sharedSecret: shared, plaintext: plaintext)
        }
    }

    @objc func nip04Decrypt(_ call: CAPPluginCall) {
        crypt(call, input: "ciphertext", failure: "Could not decrypt") { sk, peer, ciphertext in
            var shared = try NostrCrypto.sharedSecret(sk, peer: peer)
            defer { NostrCrypto.wipe(&shared) }
            return NostrCipher.decrypt04(sharedSecret: shared, payload: ciphertext)
        }
    }

    /**
     The shape all four share: find the key, run `body`, and answer with its
     result or with `failure`.

     A bad peer is said out loud, because it is the caller's input and not a
     secret. Everything else that goes wrong is `failure` alike — see
     `NostrCipher`.
     */
    private func crypt(_ call: CAPPluginCall, input: String, failure: String,
                       _ body: ([UInt8], String, String) throws -> String?) {
        guard let pubkey = call.getString("pubkey"), let peer = call.getString("peer") else {
            call.reject("pubkey and peer are required")
            return
        }
        guard let text = call.getString(input) else {
            call.reject("\(input) is required")
            return
        }
        guard let sk = TennaKeys.get(pubkey) else {
            call.reject("No key on this device for that account")
            return
        }

        do {
            guard let result = try body(sk, peer, text) else {
                call.reject(failure)
                return
            }
            call.resolve(["result": result])
        } catch NostrCrypto.Failure.invalidPeer {
            call.reject("peer is not a valid public key")
        } catch {
            call.reject(failure)
        }
    }
}
