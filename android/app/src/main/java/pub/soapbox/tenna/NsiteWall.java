package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Which sites are on the channel wall, where the native side can see them.
 *
 * The wall itself lives in the web layer's local storage, which is no use to
 * the code that needs to consult it: {@link NsiteShortcutsPlugin#finish}
 * decides whether to throw a site's record away while running inside that
 * site's own window, with no wall in memory and quite possibly no Tenna task
 * alive at all, and the share sheet is read by the system when nothing of ours
 * is running. So the wall is mirrored down here as a flat set of site ids.
 *
 * It is a mirror and never an original. The web layer replaces the whole set
 * every time the wall changes, so anything that goes wrong — a crash between
 * two writes, storage cleared, a version that didn't know about this — is
 * corrected on the next launch rather than accumulating.
 *
 * Being on the wall is what now keeps a site's record alive, which used to be
 * the job of a home screen shortcut alone. A site is on the wall because
 * somebody put it there; that they also chose to pin it to the launcher is a
 * further thing, and not the one that should decide whether Tenna remembers
 * what the site is.
 */
final class NsiteWall {

    private static final String PREFS = "nsite-wall";
    private static final String KEY_SITES = "siteIds";

    private NsiteWall() {}

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Every site id the wall holds. Empty before the web layer has spoken. */
    @NonNull
    static Set<String> all(@NonNull Context context) {
        Set<String> stored = prefs(context).getStringSet(KEY_SITES, null);
        // The set handed back by SharedPreferences must not be modified, and
        // its contents are undefined after the next edit — so it is copied.
        return stored == null ? Collections.emptySet() : new HashSet<>(stored);
    }

    /** Whether a site is on the wall. */
    static boolean has(@NonNull Context context, @NonNull String siteId) {
        Set<String> stored = prefs(context).getStringSet(KEY_SITES, null);
        return stored != null && stored.contains(siteId);
    }

    /**
     * Replace the wall wholesale.
     *
     * Wholesale rather than one site at a time because the web layer knows the
     * whole answer and nothing here does: a removal that never arrived would
     * otherwise leave a site on the wall here forever, and there would be
     * nothing to notice it by.
     */
    static void replace(@NonNull Context context, @NonNull Collection<String> siteIds) {
        prefs(context).edit().putStringSet(KEY_SITES, new HashSet<>(siteIds)).apply();
    }
}
