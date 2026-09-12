package pub.soapbox.tenna;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;


/**
 * A signer in the app process, for keys the web layer is not allowed to hold.
 *
 * <p>Everything a NIP-07 signer can do is here — sign an event, encrypt and
 * decrypt under NIP-44 and NIP-04 — and none of it takes a key as an argument
 * or returns one. Callers name an account by its pubkey and get back the
 * result; {@link TennaKeys} is the only thing that ever sees the secret, and
 * it does not give it out. That is the same shape as the NIP-55 path in
 * {@code androidNativeSigner.ts}, which asks a signer app on the device the
 * same questions, except that nothing here leaves the app: no intent, no
 * consent screen from somebody else's activity, no round trip. The web layer
 * picks between them in {@code useCurrentUser}.
 *
 * <p><b>Only Tenna's own window can reach this.</b> An nsite runs in a WebView
 * built by {@code NsiteWebViewPlugin}, which has no Capacitor bridge in it at
 * all — a site's {@code window.nostr} is an injected proxy that posts messages
 * to the web layer, which asks the user, and only then calls a method here.
 * Nothing about moving the key changes that path, and a site has no more reach
 * than it had.
 *
 * <p>Events cross the bridge as JSON text in both directions rather than as
 * Capacitor objects, for the same reason push filters do: a tag array is
 * arbitrarily shaped, and coercion through {@code JSObject} does not keep it
 * intact. The id is a hash of those exact bytes, so "close enough" is a
 * signature over the wrong event.
 */
@CapacitorPlugin(name = "TennaSigner")
public class TennaSignerPlugin extends Plugin {

    /**
     * Whether this device can hold a key natively.
     *
     * <p>False when libsecp256k1 did not load — an ABI the APK was not built
     * for. The web layer answers that by keeping the key in JavaScript, the
     * way it did before any of this, rather than by refusing to log anybody
     * in.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", NostrCrypto.isAvailable());
        call.resolve(result);
    }

    /**
     * Make a new account.
     *
     * <p>The key is kept before it is returned, and returned exactly once:
     * this answer is what the signup screen shows the user to write down, and
     * there is no second call that will produce it again. See {@link TennaKeys}
     * for why there is no export.
     */
    @PluginMethod
    public void generate(PluginCall call) {
        if (!NostrCrypto.isAvailable()) {
            call.reject("This device has no native signer");
            return;
        }

        byte[] sk = TennaKeys.generate(getContext());
        if (sk == null) {
            call.reject("Could not create a key");
            return;
        }

        JSObject result = new JSObject();
        result.put("pubkey", NostrCrypto.pubkeyOf(sk));
        result.put("secretKey", NostrCrypto.bytesToHex(sk));
        call.resolve(result);
    }

    /** Take a key the user pasted, or one an older version left in web storage. */
    @PluginMethod
    public void importKey(PluginCall call) {
        String hex = call.getString("secretKey");
        byte[] sk = NostrCipher.hexToBytes(hex);
        if (sk == null || sk.length != 32) {
            call.reject("secretKey must be 32 bytes of hex");
            return;
        }

        String pubkey = TennaKeys.importKey(getContext(), sk);
        if (pubkey == null) {
            call.reject("Could not keep the key");
            return;
        }

        JSObject result = new JSObject();
        result.put("pubkey", pubkey);
        call.resolve(result);
    }

    /** Which accounts this device can sign for. */
    @PluginMethod
    public void listKeys(PluginCall call) {
        JSArray pubkeys = new JSArray();
        for (String pubkey : TennaKeys.pubkeys(getContext())) {
            pubkeys.put(pubkey);
        }

        JSObject result = new JSObject();
        result.put("pubkeys", pubkeys);
        call.resolve(result);
    }

    /**
     * Say who is signed in, so that code with no WebView in it can know.
     *
     * <p>Wholesale: the argument is the whole list and it replaces the whole
     * list. See {@link TennaAccounts} for why there is a copy of this down
     * here at all, and why it is only ever a copy.
     */
    @PluginMethod
    public void setAccounts(PluginCall call) {
        String accounts = call.getString("accounts");
        if (accounts == null) {
            call.reject("accounts is required");
            return;
        }

        TennaAccounts.replace(getContext(), accounts);
        call.resolve();
    }

    /** Keep these and forget the rest — see {@link TennaKeys#retain}. */
    @PluginMethod
    public void retainKeys(PluginCall call) {
        JSArray given = call.getArray("pubkeys");
        if (given == null) {
            call.reject("pubkeys is required");
            return;
        }

        List<String> keep = new ArrayList<>();
        try {
            for (Object pubkey : given.toList()) {
                if (pubkey instanceof String) keep.add((String) pubkey);
            }
        } catch (org.json.JSONException e) {
            call.reject("pubkeys must be an array of strings");
            return;
        }

        JSObject result = new JSObject();
        result.put("forgotten", TennaKeys.retain(getContext(), keep));
        call.resolve(result);
    }

    // ── Signing ──────────────────────────────────────────────────────────────

    /**
     * Sign an event template as {@code pubkey}.
     *
     * <p>Takes {@code kind}, {@code content}, {@code tags} and
     * {@code created_at}; ignores any {@code id}, {@code pubkey} or
     * {@code sig} the caller put in, because those are what this computes. A
     * caller that disagrees about the id would otherwise get a signature over
     * its own idea of the event, which is the failure this whole class has to
     * not have.
     */
    @PluginMethod
    public void signEvent(PluginCall call) {
        String pubkey = call.getString("pubkey");
        String eventJson = call.getString("event");
        if (pubkey == null || eventJson == null) {
            call.reject("pubkey and event are required");
            return;
        }

        byte[] sk = TennaKeys.get(getContext(), pubkey);
        if (sk == null) {
            call.reject("No key on this device for that account");
            return;
        }

        try {
            JSONObject template = new JSONObject(eventJson);
            int kind = template.getInt("kind");
            String content = template.optString("content", "");
            JSONArray tags = template.optJSONArray("tags");
            if (tags == null) tags = new JSONArray();
            long createdAt = template.optLong("created_at", System.currentTimeMillis() / 1000);

            JSONObject signed = NostrCrypto.finalizeEvent(kind, content, tags, createdAt, sk);

            JSObject result = new JSObject();
            result.put("event", signed.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not sign the event", e);
        }
    }

    // ── Encryption ───────────────────────────────────────────────────────────

    @PluginMethod
    public void nip44Encrypt(PluginCall call) {
        byte[] conversationKey = conversationKey(call);
        if (conversationKey == null) return;

        String plaintext = call.getString("plaintext");
        if (plaintext == null) {
            call.reject("plaintext is required");
            return;
        }

        answer(call, NostrCipher.encrypt44(conversationKey, plaintext), "Could not encrypt");
    }

    @PluginMethod
    public void nip44Decrypt(PluginCall call) {
        byte[] conversationKey = conversationKey(call);
        if (conversationKey == null) return;

        String ciphertext = call.getString("ciphertext");
        if (ciphertext == null) {
            call.reject("ciphertext is required");
            return;
        }

        answer(call, NostrCipher.decrypt44(conversationKey, ciphertext), "Could not decrypt");
    }

    @PluginMethod
    public void nip04Encrypt(PluginCall call) {
        byte[] shared = sharedSecret(call);
        if (shared == null) return;

        String plaintext = call.getString("plaintext");
        if (plaintext == null) {
            call.reject("plaintext is required");
            return;
        }

        answer(call, NostrCipher.encrypt04(shared, plaintext), "Could not encrypt");
    }

    @PluginMethod
    public void nip04Decrypt(PluginCall call) {
        byte[] shared = sharedSecret(call);
        if (shared == null) return;

        String ciphertext = call.getString("ciphertext");
        if (ciphertext == null) {
            call.reject("ciphertext is required");
            return;
        }

        answer(call, NostrCipher.decrypt04(shared, ciphertext), "Could not decrypt");
    }

    // ── Shared plumbing ──────────────────────────────────────────────────────

    /**
     * The secret key for the call's {@code pubkey}, or null having already
     * rejected the call. Callers return immediately on null.
     */
    private byte[] keyFor(PluginCall call) {
        String pubkey = call.getString("pubkey");
        String peer = call.getString("peer");
        if (pubkey == null || peer == null) {
            call.reject("pubkey and peer are required");
            return null;
        }

        byte[] sk = TennaKeys.get(getContext(), pubkey);
        if (sk == null) {
            call.reject("No key on this device for that account");
            return null;
        }
        return sk;
    }

    private byte[] conversationKey(PluginCall call) {
        byte[] sk = keyFor(call);
        if (sk == null) return null;

        byte[] key = NostrCrypto.conversationKey(sk, call.getString("peer"));
        if (key == null) call.reject("peer is not a valid public key");
        return key;
    }

    private byte[] sharedSecret(PluginCall call) {
        byte[] sk = keyFor(call);
        if (sk == null) return null;

        byte[] shared = NostrCrypto.sharedSecret(sk, call.getString("peer"));
        if (shared == null) call.reject("peer is not a valid public key");
        return shared;
    }

    /**
     * Resolve with {@code result}, or reject with {@code failure}.
     *
     * <p>{@link NostrCipher} returns null for every kind of failure alike and
     * this keeps it that way: a caller that could tell a bad MAC from bad
     * padding from a bad key has an oracle, and the site asking is not
     * necessarily friendly.
     */
    private void answer(PluginCall call, String result, String failure) {
        if (result == null) {
            call.reject(failure);
            return;
        }
        JSObject out = new JSObject();
        out.put("result", result);
        call.resolve(out);
    }
}
