package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The secret that says a request for a site's own reserved paths came from
 * that site's own worker.
 *
 * The paths under {@code /.napp/} are Tenna's rather than the site's, and they
 * do things: post a notification wearing the site's name and icon, read its
 * tray back, take one down, open its window. They are answered from
 * {@link NsiteRequests}, which is reached two ways — the site's own WebView
 * client, and the one process-wide service worker client that every worker in
 * the app shares. The second is the problem. A worker fetch carries no WebView
 * with it, so the only thing naming a site is the host in the URL, and a host
 * is not proof: any site could {@code fetch} another site's notification path
 * and be answered as though it were that site.
 *
 * So the shim carries a token, and the host checks it. The token is stamped
 * into the shim when the worker's own script is served, which is a response
 * only that origin can read — a cross-origin {@code fetch} of it is opaque,
 * and the shim is appended only when the {@code Service-Worker} header is
 * present, which the browser sets for a worker script fetch and for nothing a
 * site can arrange.
 *
 * Derived rather than stored per site, from one random secret made on first
 * use. A worker script is cached by the browser for as long as the
 * registration lives, so the token baked into an installed worker has to stay
 * valid across restarts; deriving it means that holds without a second store
 * to keep in step with the sites.
 */
final class NappTokens {

    private static final String PREFS = "napp-tokens";
    private static final String KEY_SECRET = "secret";

    private NappTokens() {}

    /**
     * The value that says a notification intent was built by this app.
     *
     * {@link NsiteAppActivity} is exported — the launcher has to be able to
     * start a pinned site — so any app on the device can send it an intent
     * naming a site and a notification key. Keys are derived from public
     * values, so they can be guessed. Without this, another app could raise a
     * {@code notificationclick} in a site's worker for a notification nobody
     * pressed, and open the window inside which that worker is then allowed to
     * open windows of its own.
     *
     * Derived from the same install secret as a site token, so it survives a
     * restart: a notification outlives the process that posted it, and the
     * PendingIntent it carries has to still be good afterwards.
     */
    @NonNull
    static String intentNonce(@NonNull Context context) {
        return forSite(context, "\u0000notification-intent");
    }

    /** Whether a value is this install's intent nonce. */
    static boolean isIntentNonce(@NonNull Context context, @Nullable String value) {
        return matches(context, "\u0000notification-intent", value);
    }

    /** The token for a site: HMAC-SHA256 of its id under the install secret. */
    @NonNull
    static String forSite(@NonNull Context context, @NonNull String siteId) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret(context), "HmacSHA256"));
            return NsiteBlobs.hex(mac.doFinal(siteId.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            // HmacSHA256 is required of every Java platform; this cannot happen.
            throw new IllegalStateException(e);
        }
    }

    /**
     * Whether a token is the one for this site.
     *
     * Compared without an early exit. The comparison is of a value the caller
     * supplied against one derived here, which is the shape a timing oracle is
     * built out of, and the cost of not having one is nothing.
     */
    static boolean matches(@NonNull Context context, @NonNull String siteId, @Nullable String token) {
        if (token == null) return false;
        String expected = forSite(context, siteId);
        if (token.length() != expected.length()) return false;

        int difference = 0;
        for (int i = 0; i < expected.length(); i++) {
            difference |= token.charAt(i) ^ expected.charAt(i);
        }
        return difference == 0;
    }

    private static synchronized byte[] secret(@NonNull Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(KEY_SECRET, null);

        if (stored == null) {
            byte[] fresh = new byte[32];
            new SecureRandom().nextBytes(fresh);
            stored = Base64.encodeToString(fresh, Base64.NO_WRAP);
            prefs.edit().putString(KEY_SECRET, stored).apply();
            return fresh;
        }

        return Base64.decode(stored, Base64.NO_WRAP);
    }
}
