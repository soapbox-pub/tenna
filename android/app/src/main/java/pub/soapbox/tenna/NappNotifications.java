package pub.soapbox.tenna;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Turns a site's {@code showNotification(title, options)} into one of the
 * OS's.
 *
 * Each site gets a channel of its own, named after the site, so that the
 * system's notification settings can mute one site without muting the rest —
 * the nearest Android has to a per-origin notification permission. The push
 * service's own standing notification sits on a separate, quiet channel.
 *
 * Tapping one opens the site's window, the same one a shortcut opens. What
 * the site put in {@code options.data} is not delivered anywhere yet; a
 * {@code notificationclick} for the worker is a later addition.
 */
final class NappNotifications {

    private static final String TAG = "NappNotifications";

    /** The push service's standing notification. */
    static final String SERVICE_CHANNEL = "napp.service";
    static final int SERVICE_NOTIFICATION_ID = 1;

    private static final String SITES_GROUP = "napp.sites";
    private static final String SITE_CHANNEL_PREFIX = "napp.site.";

    /** For notifications the site gave no tag; each gets a slot of its own. */
    private static final AtomicInteger UNTAGGED = new AtomicInteger(1);

    private NappNotifications() {}

    /** Whether the OS will show anything we post at all. */
    static boolean isEnabled(@NonNull Context context) {
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /**
     * Post a notification for a site. Returns false if it could not be shown.
     *
     * The payload is what the worker passed: {@code {title, options}}, with
     * the options object as the Notifications API defines it. Only the parts
     * with an Android counterpart are used.
     */
    static boolean show(@NonNull Context context, @NonNull String siteId, @NonNull JSONObject payload) {
        if (!isEnabled(context)) {
            Log.i(TAG, "Notifications are off; dropping one from " + siteId);
            return false;
        }

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) {
            Log.i(TAG, "No record for " + siteId + "; dropping its notification");
            return false;
        }

        String title = payload.optString("title", "");
        JSONObject options = payload.optJSONObject("options");
        if (options == null) options = new JSONObject();

        String body = options.optString("body", "");
        String tag = options.has("tag") && !options.isNull("tag") ? options.optString("tag") : null;
        boolean silent = options.optBoolean("silent", false);

        String channelId = ensureSiteChannel(context, siteId, record.label);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_napp)
            .setContentTitle(title.isEmpty() ? record.label : title)
            .setSubText(record.label)
            .setAutoCancel(true)
            .setSilent(silent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setContentIntent(openSite(context, siteId));

        if (!body.isEmpty()) {
            builder.setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }

        Bitmap icon = NsiteSites.taskIcon(context, siteId);
        if (icon != null) builder.setLargeIcon(icon);

        // A tagged notification replaces the last one with the same tag, as
        // it does on the web; an untagged one is always another.
        String key = NsiteSites.key(siteId);
        String notificationTag = tag != null ? key + "/" + tag : key + "/#" + UNTAGGED.getAndIncrement();

        try {
            NotificationManagerCompat.from(context).notify(notificationTag, 0, builder.build());
            Log.i(TAG, "Posted a notification for " + record.label);
            return true;
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS was revoked between the check and the post.
            return false;
        }
    }

    /** The standing notification the push service runs under. */
    static Notification serviceNotification(@NonNull Context context, int siteCount) {
        ensureServiceChannel(context);

        String text = siteCount == 1
            ? "Listening for notifications from 1 site"
            : "Listening for notifications from " + siteCount + " sites";

        return new NotificationCompat.Builder(context, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_napp)
            .setContentTitle("Tenna")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    // -----------------------------------------------------------------------
    // Channels
    // -----------------------------------------------------------------------

    private static PendingIntent openSite(Context context, String siteId) {
        return PendingIntent.getActivity(
            context,
            // Distinct per site, or one site's intent would replace another's.
            NsiteSites.key(siteId).hashCode(),
            NsiteAppActivity.intentFor(context, siteId),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void ensureServiceChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            SERVICE_CHANNEL,
            "Background listener",
            NotificationManager.IMPORTANCE_MIN
        );
        channel.setDescription("Shown while Tenna is connected to relays for site notifications");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    @NonNull
    private static String ensureSiteChannel(Context context, String siteId, @Nullable String label) {
        String id = SITE_CHANNEL_PREFIX + NsiteSites.key(siteId);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id;

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return id;

        manager.createNotificationChannelGroup(new NotificationChannelGroup(SITES_GROUP, "Sites"));

        NotificationChannel channel = new NotificationChannel(
            id,
            label == null || label.isEmpty() ? siteId : label,
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setGroup(SITES_GROUP);
        manager.createNotificationChannel(channel);
        return id;
    }
}
