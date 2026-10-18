package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.security.KeyStore;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Where a logged-in user's secret key lives on Android: sealed on disk under a
 * key the Android Keystore will not give up, and unsealed in this process's
 * Java heap.
 *
 * <p>Nowhere in this class does a secret key cross back to the web layer.
 * {@link TennaSignerPlugin} takes what a caller wants done and hands back the
 * answer — a signature, a ciphertext — and that is the whole point. The key
 * used to sit in the WebView's storage, which means it sat in the renderer's
 * address space every time the app read it, and the renderer is the process
 * that parses bytes from the open internet on behalf of whatever site the user
 * opened. A renderer compromise could read it and keep it forever.
 *
 * <p>It cannot now. The renderer and the app process are separate processes —
 * Chromium has run renderers out-of-process since Android O — so a key on this
 * side is not in the attacker's address space. What they get instead is the
 * bridge: they can ask this plugin to sign and decrypt, as the user, for as
 * long as they are resident. That is a signing oracle, and it is bad, but it
 * ends when the compromise ends. Key theft does not end; there is no password
 * reset for an nsec. Trading the second for the first is the whole of this
 * change, and it is worth saying plainly that it is a trade and not a fix.
 *
 * <p>Two consequences follow from that, and both are deliberate:
 *
 * <ul>
 *   <li><b>There is no export.</b> No method here returns a stored key, so a
 *       compromised renderer cannot ask for one. {@link #generate} hands back
 *       the nsec of a key it has just created, once, because a user who is
 *       never shown their key has no account — but a key that arrived by
 *       {@link #importKey} is never readable again, and neither is a generated
 *       one after the call that made it. Anything that wants to show a user
 *       their own nsec later has to come with a native confirmation the
 *       renderer cannot forge. {@link NearbyLogin} is the one that does: it
 *       sends a key to a computer, encrypted, only after the user approves
 *       a system prompt, and never through the renderer.
 *   <li><b>The seal is device-bound, not user-bound.</b> The Keystore key sets
 *       no {@code setUserAuthenticationRequired}, so unsealing needs no
 *       prompt. A biometric gate would be strictly stronger against someone
 *       holding the unlocked phone, and strictly useless against the attacker
 *       this is about, who is already inside the process that would be doing
 *       the asking.
 * </ul>
 *
 * <p>Sealed format: {@code base64(iv(12) || ciphertext+tag)} over the key's
 * 64 hex characters, AES-256-GCM. Keyed by the x-only public key, since Tenna
 * holds several logins at once and each needs its own.
 */
final class TennaKeys {

    private static final String TAG = "TennaKeys";

    private static final String PREFS = "tenna-keys";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "tenna-key-seal";

    /**
     * Unsealed keys, by pubkey. A trip to the Keystore per signature would be
     * felt — a site asking for twenty is one gesture — so the first unseal is
     * the only one. They stay until the process does.
     */
    private static final Map<String, byte[]> memory = new HashMap<>();

    private TennaKeys() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── The store ────────────────────────────────────────────────────────────

    /**
     * Take in a secret key and keep it. Returns the x-only pubkey it belongs
     * to, or null if the key was unusable or the seal failed.
     */
    static synchronized String importKey(Context context, byte[] sk) {
        if (sk == null || sk.length != 32) return null;
        if (!NostrCrypto.isAvailable()) return null;

        final String pubkey;
        try {
            pubkey = NostrCrypto.pubkeyOf(sk);
        } catch (Exception e) {
            // An all-zero key, or one above the group order. No pubkey exists.
            return null;
        }

        String sealed = seal(NostrCrypto.bytesToHex(sk));
        if (sealed == null) {
            Log.w(TAG, "Could not seal a key; refusing to keep it");
            return null;
        }

        prefs(context).edit().putString(pubkey, sealed).apply();
        memory.put(pubkey, sk.clone());
        return pubkey;
    }

    /** Make a new key, keep it, and return it — the one time it is readable. */
    static synchronized byte[] generate(Context context) {
        byte[] sk = NostrCrypto.generateSecretKey();
        return importKey(context, sk) != null ? sk : null;
    }

    /**
     * The secret key for {@code pubkey}, or null if this device has none.
     *
     * <p>Package-private, and it must stay that way: the value is the account.
     * Only {@link TennaSignerPlugin} and {@link NearbyLogin} call it, and only
     * to pass it straight into {@link NostrCrypto} or {@link NostrCipher}.
     */
    static synchronized byte[] get(Context context, String pubkey) {
        if (pubkey == null || pubkey.length() != 64) return null;

        byte[] cached = memory.get(pubkey);
        if (cached != null) return cached;

        String sealed = prefs(context).getString(pubkey, null);
        if (sealed == null) return null;

        String hex = open(sealed);
        byte[] sk = hex != null ? NostrCipher.hexToBytes(hex) : null;
        if (sk == null || sk.length != 32) {
            // The blob is there and won't open. It is kept anyway.
            //
            // Some reasons it won't are permanent — a Keystore key lost to a
            // reset of the secure hardware, a corrupted entry — and for those
            // the entry is worthless and retrying it costs a failed decrypt
            // per call. But others are not: the Keystore is a service that can
            // be unavailable for a moment, particularly early in a boot, and
            // nothing here can tell the two apart from the outside.
            //
            // A key deleted here cannot be got back. There is no export, so
            // this blob is the only copy of that account on the device, and
            // trading it against a cheap retry is not a trade worth making.
            // The one thing that removes a key is the account being signed
            // out of; see `retain`.
            Log.w(TAG, "A sealed key will not open; keeping it and answering with nothing");
            return null;
        }

        memory.put(pubkey, sk);
        return sk;
    }

    /** Whether this device holds a key for {@code pubkey}. Doesn't unseal it. */
    static synchronized boolean has(Context context, String pubkey) {
        return pubkey != null && prefs(context).contains(pubkey);
    }

    /** Every pubkey this device holds a key for. */
    static synchronized Set<String> pubkeys(Context context) {
        return new HashSet<>(prefs(context).getAll().keySet());
    }

    /** Forget a key, on disk and in memory. */
    static synchronized void forget(Context context, String pubkey) {
        if (pubkey == null) return;
        prefs(context).edit().remove(pubkey).apply();
        wipe(memory.remove(pubkey));
    }

    /**
     * Forget every key except these — how a logout takes the key with it.
     *
     * <p>Logging out is {@code removeLogin}, and there are several ways to
     * reach it: the account switcher, the menu, a second login replacing the
     * first. Rather than find them all and hope, the web layer says which keys
     * still have a login behind them whenever that list changes, and anything
     * else goes. A key whose login is gone is a key nothing can ask for.
     *
     * @return how many were forgotten.
     */
    static synchronized int retain(Context context, Collection<String> keep) {
        Set<String> doomed = pubkeys(context);
        doomed.removeAll(keep);
        for (String pubkey : doomed) {
            forget(context, pubkey);
            Log.i(TAG, "Forgot the key of an account that is no longer signed in");
        }
        return doomed.size();
    }

    /**
     * Overwrite a key we are done with.
     *
     * <p>Worth very little — the JVM may have copied the array during a GC
     * cycle and nothing can reach those copies — but it costs a loop, and it
     * shortens the window in which a heap dump of a running process finds the
     * key of an account that has already been logged out.
     */
    private static void wipe(byte[] sk) {
        if (sk != null) java.util.Arrays.fill(sk, (byte) 0);
    }

    // ── The seal ─────────────────────────────────────────────────────────────

    private static SecretKey sealKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /**
     * Encrypt for SharedPreferences; null on failure.
     *
     * <p>Package-private rather than private because {@link BunkerConnections}
     * holds secrets of the same order — a key that signs as the user, for one
     * remote connection — and there is no reason for a second Keystore alias
     * doing the identical job. It is deliberately not a general-purpose
     * facility: the only things sealed with it are keys.
     */
    static String seal(String plaintext) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, sealKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plaintext.getBytes("UTF-8"));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** Decrypt a sealed blob; null on any failure. */
    static String open(String sealed) {
        try {
            byte[] data = Base64.decode(sealed, Base64.NO_WRAP);
            if (data.length < 13) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, sealKey(), new GCMParameterSpec(128, data, 0, 12));
            return new String(cipher.doFinal(data, 12, data.length - 12), "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }
}
