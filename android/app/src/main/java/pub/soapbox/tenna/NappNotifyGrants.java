package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;

import java.util.HashSet;
import java.util.Set;

/**
 * Which sites the user has allowed to send notifications, as the native side
 * sees it.
 *
 * <p>The grant itself lives in the web layer's {@code localStorage} — see
 * {@code nsiteBrowserPermissions.ts} — where nothing native can read it. That
 * never used to matter: the only thing that woke a worker with no window was a
 * push, and a site could only have subscriptions if it had been granted. A
 * periodic sync is not proof of anything of the kind, so a worker it wakes is
 * checked against this before it may put anything in the shade.
 *
 * <p>Replaced whole every time a grant changes, and once at every launch, by
 * {@code NsiteGrants}. A flat set of site ids, the way {@link NappMuted} is.
 */
final class NappNotifyGrants {

    private static final String PREFS = "napp-notify-grants";
    private static final String KEY_SITES = "siteIds";

    private NappNotifyGrants() {}

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Whether a site's worker may post notifications.
     *
     * <p>Subscriptions count as a grant too, because they are one: the web
     * layer asks before it will set them, and revoking the grant clears them.
     * That also covers the moments after an update, before the web layer has
     * run once and mirrored anything here.
     */
    static boolean allowed(@NonNull Context context, @NonNull String siteId) {
        Set<String> stored = prefs(context).getStringSet(KEY_SITES, null);
        if (stored != null && stored.contains(siteId)) return true;

        NappSubscriptions.Record record = NappSubscriptions.get(context, siteId);
        return record != null && record.subscriptions.length() > 0;
    }

    static void set(@NonNull Context context, @NonNull Set<String> siteIds) {
        prefs(context).edit().putStringSet(KEY_SITES, new HashSet<>(siteIds)).apply();
    }
}
