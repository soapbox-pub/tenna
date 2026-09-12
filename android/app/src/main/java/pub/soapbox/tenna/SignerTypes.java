package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * The vocabulary every way into the signer is translated into.
 *
 * Three transports ask Tenna the same small set of questions in three
 * different dialects. A NIP-55 intent names a method in an extra called
 * {@code type}; a content resolver names it in the authority it queries; a
 * NIP-46 request names it in a JSON field called {@code method}. They are the
 * same methods, and the difference is spelling.
 *
 * So each dialect is normalised here, once, into a {@code Method} — and every
 * method that needs the user's consent carries the permission type that
 * consent is recorded under. Those permission strings are deliberately the
 * ones {@code nsitePermissions.ts} already uses for sites: an app asking to
 * decrypt and a site asking to decrypt are the same question about the same
 * key, and the settings screen that lists both should not need a translation
 * table to say so.
 *
 * A method with no permission type is one the user answers by other means.
 * {@code connect} is the approval itself, so there is nothing to look up
 * beforehand; {@code switch_relays} and {@code logout} are things the signer
 * tells the client rather than things the client asks of the key.
 */
final class SignerTypes {

    private SignerTypes() {}

    // ── Permission types ─────────────────────────────────────────────────────
    //
    // Shared with the web layer's `NsitePermissionType`. Changing one of these
    // strings orphans every grant already written under it.

    static final String PERM_GET_PUBLIC_KEY = "getPublicKey";
    static final String PERM_SIGN_EVENT = "signEvent";
    static final String PERM_NIP04_ENCRYPT = "nip04.encrypt";
    static final String PERM_NIP04_DECRYPT = "nip04.decrypt";
    static final String PERM_NIP44_ENCRYPT = "nip44.encrypt";
    static final String PERM_NIP44_DECRYPT = "nip44.decrypt";
    static final String PERM_DECRYPT_ZAP_EVENT = "decryptZapEvent";
    static final String PERM_CONNECT = "connect";
    static final String PERM_PING = "ping";

    // ── Methods ──────────────────────────────────────────────────────────────

    /** One thing a client can ask for. */
    enum Method {
        GET_PUBLIC_KEY("get_public_key", "GET_PUBLIC_KEY", PERM_GET_PUBLIC_KEY),
        SIGN_EVENT("sign_event", "SIGN_EVENT", PERM_SIGN_EVENT),
        NIP04_ENCRYPT("nip04_encrypt", "NIP04_ENCRYPT", PERM_NIP04_ENCRYPT),
        NIP04_DECRYPT("nip04_decrypt", "NIP04_DECRYPT", PERM_NIP04_DECRYPT),
        NIP44_ENCRYPT("nip44_encrypt", "NIP44_ENCRYPT", PERM_NIP44_ENCRYPT),
        NIP44_DECRYPT("nip44_decrypt", "NIP44_DECRYPT", PERM_NIP44_DECRYPT),
        DECRYPT_ZAP_EVENT("decrypt_zap_event", "DECRYPT_ZAP_EVENT", PERM_DECRYPT_ZAP_EVENT),

        /** NIP-46 only: the approval of a connection, not a use of one. */
        CONNECT("connect", null, null),
        /** NIP-46 only: granted with the connection and never asked about again. */
        PING("ping", "PING", PERM_PING),
        /** NIP-46 only: the signer's answer about where to talk to it. */
        SWITCH_RELAYS("switch_relays", null, null),
        /** NIP-46 only: the client saying it is done. */
        LOGOUT("logout", null, null);

        /** How NIP-55 extras and NIP-46 messages spell it. */
        @NonNull final String wire;
        /** The content provider authority suffix, or null if it has none. */
        @Nullable final String authority;
        /** What a grant for this is recorded under, or null if it takes none. */
        @Nullable final String permission;

        Method(@NonNull String wire, @Nullable String authority, @Nullable String permission) {
            this.wire = wire;
            this.authority = authority;
            this.permission = permission;
        }

        /** Whether this needs a peer pubkey to answer. */
        boolean needsPeer() {
            return this == NIP04_ENCRYPT || this == NIP04_DECRYPT
                || this == NIP44_ENCRYPT || this == NIP44_DECRYPT;
        }

        /** Whether a client may reach this over a content resolver or an intent. */
        boolean isNip55() {
            return authority != null && this != PING;
        }
    }

    /** The method a client named, or null if it named none this signer knows. */
    @Nullable
    static Method fromWire(@Nullable String wire) {
        if (wire == null) return null;
        for (Method method : Method.values()) {
            if (method.wire.equals(wire)) return method;
        }
        return null;
    }

    /**
     * The method a content provider authority stands for, or null.
     *
     * <p>Takes the whole authority — {@code pub.soapbox.tenna.SIGN_EVENT} —
     * and matches on the part after the last dot, so the same code works
     * whatever {@code applicationId} a build carries.
     */
    @Nullable
    static Method fromAuthority(@Nullable String authority) {
        if (authority == null) return null;
        int dot = authority.lastIndexOf('.');
        String suffix = dot >= 0 ? authority.substring(dot + 1) : authority;
        for (Method method : Method.values()) {
            if (suffix.equals(method.authority)) return method;
        }
        return null;
    }

    // ── Requested permissions ────────────────────────────────────────────────

    /**
     * Turn one entry of a NIP-46 {@code perms} list into a permission type.
     *
     * <p>The format is {@code method} or {@code method:kind} — so
     * {@code sign_event:4} is a request to sign kind 4 and nothing else. The
     * kind, when there is one, goes in {@code kindOut[0]}; callers that do not
     * care may pass null.
     */
    @Nullable
    static String permissionFromPerm(@Nullable String perm, @Nullable Integer[] kindOut) {
        if (perm == null) return null;

        String trimmed = perm.trim();
        if (trimmed.isEmpty()) return null;

        String name = trimmed;
        Integer kind = null;
        int colon = trimmed.indexOf(':');
        if (colon >= 0) {
            name = trimmed.substring(0, colon);
            try {
                kind = Integer.valueOf(trimmed.substring(colon + 1).trim());
            } catch (NumberFormatException e) {
                // "sign_event:" and "sign_event:abc" are a request to sign
                // anything, which is not what the client can have meant. The
                // method survives; the bogus kind does not.
                kind = null;
            }
        }

        Method method = fromWire(name);
        if (method == null || method.permission == null) return null;

        if (kindOut != null && kindOut.length > 0) {
            kindOut[0] = method == Method.SIGN_EVENT ? kind : null;
        }
        return method.permission;
    }
}
