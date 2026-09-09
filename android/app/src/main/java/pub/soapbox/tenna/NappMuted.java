package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;

import java.util.HashSet;
import java.util.Set;

/**
 * Which sites the user has turned notifications off for.
 *
 * A site asking to send notifications and a user wanting to hear them are two
 * different questions, and this is the second. The permission is the site's
 * to be granted and revoked; the switch on the app's info screen is the
 * user's, is on before anybody touches it, and survives the site setting its
 * subscriptions again — which a revoked permission would not, since the site
 * would simply ask once more.
 *
 * Kept apart from the subscriptions themselves for that reason: those are
 * replaced wholesale every time a site calls {@code set()}, and a preference
 * that a site could clear by re-subscribing would not be much of a
 * preference. It is also an answer that has to exist before the site has
 * subscribed to anything at all.
 *
 * Stored as a flat set of site ids, the way the wall is — see
 * {@link NsiteWall}. Absence means notifications are on, so a site nobody has
 * had an opinion about costs nothing to store.
 */
final class NappMuted {

    private static final String PREFS = "napp-muted";
    private static final String KEY_SITES = "siteIds";

    private NappMuted() {}

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Whether the user has turned this site's notifications off. */
    static boolean isMuted(@NonNull Context context, @NonNull String siteId) {
        Set<String> stored = prefs(context).getStringSet(KEY_SITES, null);
        return stored != null && stored.contains(siteId);
    }

    /** Turn a site's notifications off, or back on. */
    static synchronized void set(@NonNull Context context, @NonNull String siteId, boolean muted) {
        Set<String> stored = prefs(context).getStringSet(KEY_SITES, null);
        // The set handed back by SharedPreferences must not be modified, and
        // its contents are undefined after the next edit — so it is copied.
        Set<String> next = stored == null ? new HashSet<>() : new HashSet<>(stored);

        if (muted ? !next.add(siteId) : !next.remove(siteId)) return;

        prefs(context).edit().putStringSet(KEY_SITES, next).apply();
    }

    /** Forget the answer for a site Tenna is no longer holding anything about. */
    static void forget(@NonNull Context context, @NonNull String siteId) {
        set(context, siteId, false);
    }
}
