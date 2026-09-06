package pub.soapbox.tenna;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Turns a site's {@code showNotification(title, options)} into one of the
 * OS's.
 *
 * Nothing but the standard options, honoured as far as Android will take them:
 * {@code body}, {@code tag}, {@code icon}, {@code badge}, {@code image},
 * {@code actions}, {@code data}, {@code silent}, {@code renotify},
 * {@code timestamp} and {@code vibrate}. A site written for the web is a site
 * written for this, and there is nothing to opt into. See {@link NappOptions}.
 *
 * <b>Each site is its own app in the shade.</b> Its notifications carry a
 * group of their own with a summary above them, so two sites are two bundles
 * rather than one pile marked Tenna; the small icon is the site's, out of its
 * own {@code badge} or its own monochrome manifest icon, so the status bar
 * says which site is talking; and the site's field colour tints both. That is
 * the whole of what a per-site notification is, and it is what should have
 * been built before anything richer.
 *
 * Each site also gets a channel group of its own in system settings, named
 * after the site, so a user can mute one site without muting the rest — the
 * nearest Android has to a per-origin notification permission. The push
 * service's own standing notification sits on a separate, quiet channel
 * outside all of that.
 *
 * Pictures never hold a notification up. Whatever is already decoded is used,
 * the notification goes out, and it is posted again — silently, under the same
 * tag — when the rest arrives. See {@link NappImages}.
 */
final class NappNotifications {

    private static final String TAG = "NappNotifications";

    /** The push service's standing notification. */
    static final String SERVICE_CHANNEL = "napp.service";
    static final int SERVICE_NOTIFICATION_ID = 1;

    /**
     * The group a site's channels live in, one group per site.
     *
     * Sites once shared a single "Sites" group with one channel each. Both the
     * old group and the old channel are deleted on the way past; a channel's
     * group cannot be changed once it exists, so moving them is the only way.
     */
    private static final String SITE_GROUP_PREFIX = "napp.group.";
    private static final String SITE_CHANNEL_PREFIX = "napp.site.";
    private static final String DEFAULT_CHANNEL = "default";

    private static final String LEGACY_SITES_GROUP = "napp.sites";

    /**
     * The tag of a site's group summary.
     *
     * A site's own notifications are filed under {@code <site>/<tag>}, so
     * nothing a site can say produces this — which is what stops a site from
     * closing or replacing the header its notifications sit under.
     */
    private static final String SUMMARY_SUFFIX = "!summary";

    /** Titles listed on the summary before the system's own count takes over. */
    private static final int SUMMARY_LINES = 6;

    /** For notifications the site gave no tag; each gets a slot of its own. */
    private static final AtomicInteger UNTAGGED = new AtomicInteger(1);

    /**
     * How long after acting on a notification a site may open its own window.
     *
     * {@code clients.openWindow()} exists for {@code notificationclick}, where
     * the user has just asked for something and opening it is the answer. A
     * site calling it out of a {@code push} handler is a site putting itself on
     * screen over whatever the user was doing, and that is not a thing to
     * grant because a worker asked nicely. Android's own background-launch
     * rules would refuse most of it anyway; this refuses the rest.
     */
    private static final long INTERACTION_WINDOW_MS = 60_000;

    private static final java.util.Map<String, Long> INTERACTED =
        new java.util.concurrent.ConcurrentHashMap<>();

    private NappNotifications() {}

    /** Whether the OS will show anything we post at all. */
    static boolean isEnabled(@NonNull Context context) {
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    // -----------------------------------------------------------------------
    // Showing
    // -----------------------------------------------------------------------

    /**
     * Post a notification for a site. Returns false if it could not be shown.
     *
     * The payload is what the worker passed: {@code {title, options}}, with
     * the options object as the Notifications API defines it.
     */
    static boolean show(@NonNull Context context, @NonNull String siteId, @NonNull JSONObject payload) {
        if (!isEnabled(context)) {
            Log.i(TAG, "Notifications are off; dropping one from " + siteId);
            return false;
        }

        if (NsiteSites.load(context, siteId) == null) {
            Log.i(TAG, "No record for " + siteId + "; dropping its notification");
            return false;
        }

        JSONObject options = payload.optJSONObject("options");
        if (options == null) options = new JSONObject();

        String tag = NappOptions.parse(options).tag;

        // A tagged notification replaces the last one with the same tag, as it
        // does on the web; an untagged one is always another.
        String key = tag.isEmpty()
            ? NsiteSites.key(siteId) + "/#" + UNTAGGED.getAndIncrement()
            : NsiteSites.key(siteId) + "/" + tag;

        return post(context, siteId, payload.optString("title", ""), options, key, tag, false);
    }

    /**
     * Show a notification again without alerting, because something it was
     * waiting on has arrived.
     *
     * Only ever called by {@link NappImages} once a picture has been decoded.
     * Everything about the notification is read back from the record written
     * when it was first posted, so this cannot show anything the site did not
     * already say.
     */
    static void repost(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        if (!isEnabled(context)) return;

        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null) return;

        // The user swiped it away while the picture was in the air.
        if (!isActive(context, key)) return;

        try {
            post(context, siteId, entry.title, new JSONObject(entry.options), key, entry.tag, true);
        } catch (JSONException e) {
            // The record is unreadable; it will be replaced by the next post.
        }
    }

    // -----------------------------------------------------------------------

    private static boolean post(
        Context context,
        String siteId,
        String rawTitle,
        JSONObject json,
        String key,
        String tag,
        boolean quiet
    ) {
        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) return false;

        NappOptions options = NappOptions.parse(json);
        String title = NappOptions.title(rawTitle, record.label);

        // The application's, so a picture still in the air cannot hold a
        // window's context alive behind it.
        Context app = context.getApplicationContext();
        NappImages.OnLoaded again = () -> repost(app, siteId, key);

        NotificationCompat.Builder builder =
            new NotificationCompat.Builder(context, ensureChannel(context, siteId, record.label))
                .setContentTitle(title)
                // Whose notification this is, whatever the site put in the title.
                .setSubText(record.label)
                .setAutoCancel(true)
                .setSilent(options.silent)
                // Web semantics: replacing a tagged notification is quiet unless
                // the site asks otherwise. A first post alerts either way.
                .setOnlyAlertOnce(quiet || !options.renotify)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setGroup(NsiteSites.key(siteId))
                .setContentIntent(openSite(context, siteId, key, options.url))
                .setDeleteIntent(dismissed(context, siteId, key));

        smallIcon(builder, context, siteId, options.badge, again);

        if (options.timestamp > 0) builder.setWhen(options.timestamp).setShowWhen(true);

        // Above Android 8 the pattern belongs to the channel, and a per-post
        // one is ignored — which is the platform's answer, not ours to work
        // around.
        if (options.vibrate != null && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setVibrate(options.vibrate);
        }

        // The site's field colour, already worked out for the recents card, so
        // the shade tints the small icon and the site's name to match its tile.
        NsiteSites.TaskIcon tile = NsiteSites.taskIcon(context, siteId);
        if (tile != null) builder.setColor(tile.color).setColorized(false);

        Bitmap large = options.icon == null
            ? null
            : NappImages.cached(context, siteId, options.icon, NappImages.SHAPE_PLAIN, again);
        builder.setLargeIcon(large != null ? large : (tile == null ? null : tile.bitmap));

        style(context, siteId, builder, options, again);
        actions(context, siteId, builder, key, options, again);

        try {
            NotificationManagerCompat.from(context).notify(key, 0, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS was revoked between the check and the post.
            return false;
        }

        NappNotificationStore.put(context, siteId, new NappNotificationStore.Entry(
            key,
            tag,
            title,
            json.toString(),
            options.url,
            System.currentTimeMillis()
        ));

        summarize(context, siteId, record.label, key);

        if (!quiet) Log.i(TAG, "Posted a notification for " + record.label);
        return true;
    }

    /**
     * The site's own mark in the status bar, or Tenna's where it has none.
     *
     * The notification's {@code badge} first, then the monochrome icon the
     * site declares in its web app manifest, then the television. A badge
     * still being fetched shows the next one down and arrives on the repost.
     */
    private static void smallIcon(
        NotificationCompat.Builder builder,
        Context context,
        String siteId,
        @Nullable String badge,
        NappImages.OnLoaded again
    ) {
        IconCompat icon = NappBadges.icon(context, siteId, badge, again);
        if (icon != null) builder.setSmallIcon(icon);
        else builder.setSmallIcon(R.drawable.ic_stat_napp);
    }

    /**
     * How the notification expands: into its photograph, or into its text.
     *
     * A picture not yet decoded is shown flat and expands when it lands.
     */
    private static void style(
        Context context,
        String siteId,
        NotificationCompat.Builder builder,
        @NonNull NappOptions options,
        NappImages.OnLoaded again
    ) {
        if (options.image != null) {
            Bitmap picture = NappImages.cached(
                context, siteId, options.image, NappImages.SHAPE_PLAIN, again
            );
            if (picture != null) {
                NotificationCompat.BigPictureStyle big = new NotificationCompat.BigPictureStyle()
                    .bigPicture(picture)
                    // The large icon would otherwise be redrawn over the top of
                    // the photograph when the notification is expanded.
                    .bigLargeIcon((Bitmap) null);
                if (!options.body.isEmpty()) builder.setContentText(options.body);
                builder.setStyle(big);
                return;
            }
        }

        if (!options.body.isEmpty()) {
            builder
                .setContentText(options.body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(options.body));
        }
    }

    /**
     * The buttons under a notification.
     *
     * A button with an {@code input} gets a reply box, which is the one place
     * a mutable {@code PendingIntent} is required — {@code RemoteInput} fills
     * the intent in on its way out, and an immutable one has nowhere to put
     * the text.
     */
    private static void actions(
        Context context,
        String siteId,
        NotificationCompat.Builder builder,
        String key,
        @NonNull NappOptions options,
        NappImages.OnLoaded again
    ) {
        for (NappOptions.Action action : options.actions) {
            Intent intent = new Intent(context, NappNotificationReceiver.class)
                .setAction(NappNotificationReceiver.ACTION_ACTION)
                // Extras alone do not tell two PendingIntents apart; the data
                // URI does, so each button keeps its own.
                .setData(android.net.Uri.parse("tenna-napp:" + key + "#" + action.action))
                .putExtra(NappNotificationReceiver.EXTRA_SITE_ID, siteId)
                .putExtra(NappNotificationReceiver.EXTRA_KEY, key)
                .putExtra(NappNotificationReceiver.EXTRA_ACTION, action.action);

            PendingIntent pending = PendingIntent.getBroadcast(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT
                    | (action.input ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE)
            );

            // An action's icon is a stencil too, drawn the same way as the one
            // in the status bar.
            IconCompat glyph = action.icon == null
                ? null
                : NappBadges.icon(context, siteId, action.icon, again);

            NotificationCompat.Action.Builder button = new NotificationCompat.Action.Builder(
                glyph != null ? glyph : IconCompat.createWithResource(context, R.drawable.ic_stat_napp),
                action.title,
                pending
            );

            if (action.input) {
                RemoteInput.Builder input = new RemoteInput.Builder(NappNotificationReceiver.KEY_REPLY);
                if (action.placeholder != null) input.setLabel(action.placeholder);
                button
                    .addRemoteInput(input.build())
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    // The worker answers it; there is nothing to bring forward.
                    .setShowsUserInterface(false)
                    .setAllowGeneratedReplies(true);
            }

            builder.addAction(button.build());
        }
    }

    // -----------------------------------------------------------------------
    // The bundle
    // -----------------------------------------------------------------------

    /**
     * The header a site's notifications sit under, posted or taken down to
     * match what the site currently has out.
     *
     * Android will bundle several notifications from one app on its own, but
     * it bundles them as <i>the app</i> — which for Tenna means every site's
     * notifications in one pile under one name. A summary per site is what
     * makes the pile per site instead, and it wears the site's own mark so the
     * pile is recognisable before it is opened.
     *
     * Only ever above two or more. A group of one is shown by some versions of
     * Android as the header alone, which would hide the notification behind a
     * count of itself; a site with one notification out wants that
     * notification, which already carries the site's mark and name and colour.
     *
     * Never alerts: {@code GROUP_ALERT_CHILDREN} hands the sound to the
     * notification that actually arrived, so posting the header does not buzz
     * a second time.
     */
    private static void summarize(
        Context context,
        String siteId,
        String label,
        @Nullable String posted
    ) {
        List<String> titles = live(context, siteId, posted);
        String key = NsiteSites.key(siteId) + SUMMARY_SUFFIX;

        if (titles.size() < 2) {
            NotificationManagerCompat.from(context).cancel(key, 0);
            return;
        }

        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle()
            .setSummaryText(label);
        for (int i = Math.max(0, titles.size() - SUMMARY_LINES); i < titles.size(); i++) {
            inbox.addLine(titles.get(i));
        }

        NotificationCompat.Builder builder =
            new NotificationCompat.Builder(context, ensureChannel(context, siteId, label))
                .setContentTitle(label)
                .setContentText(titles.size() + " notifications")
                .setStyle(inbox)
                .setGroup(NsiteSites.key(siteId))
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openSite(context, siteId, null, null));

        // The site's, with no notification behind it: a header stands for the
        // site rather than for anything it said.
        IconCompat icon = NappBadges.site(context, siteId);
        if (icon != null) builder.setSmallIcon(icon);
        else builder.setSmallIcon(R.drawable.ic_stat_napp);

        NsiteSites.TaskIcon tile = NsiteSites.taskIcon(context, siteId);
        if (tile != null) builder.setColor(tile.color).setColorized(false);

        try {
            NotificationManagerCompat.from(context).notify(key, 0, builder.build());
        } catch (SecurityException e) {
            // The children are up; a missing header is not worth failing over.
        }
    }

    /**
     * The titles of the site's notifications that are actually on screen,
     * oldest first.
     *
     * The store outlives the tray — notifications do not survive a reboot and
     * their records do — so a header built from the records alone would
     * announce five where the user can see one. What the system says is on
     * screen wins, with the one just posted taken on trust: {@code notify()}
     * is answered by a handler in the notification service, and asking it a
     * moment later can be asking too early.
     */
    @NonNull
    private static List<String> live(Context context, String siteId, @Nullable String posted) {
        java.util.Set<String> active = activeKeys(context);
        List<String> titles = new java.util.ArrayList<>();

        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            if (active != null && !active.contains(entry.key) && !entry.key.equals(posted)) continue;
            titles.add(entry.title);
        }

        return titles;
    }

    /** Every notification tag the app currently has out, or null if unreadable. */
    @Nullable
    private static java.util.Set<String> activeKeys(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return null;

        try {
            java.util.Set<String> keys = new java.util.HashSet<>();
            for (StatusBarNotification notification : manager.getActiveNotifications()) {
                if (notification.getTag() != null) keys.add(notification.getTag());
            }
            return keys;
        } catch (RuntimeException e) {
            // Some OEM builds refuse to enumerate. Trust the records rather
            // than deciding the shade is empty.
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // The tray
    // -----------------------------------------------------------------------

    /** Take a notification down, as {@code Notification.close()} does on the web. */
    static void cancel(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        NotificationManagerCompat.from(context).cancel(key, 0);
        forget(context, siteId, key);
    }

    /**
     * Forget a notification the user has already taken down themselves.
     *
     * The system has removed it; all that is left is the record, and the
     * header above it if it was the last one.
     */
    static void forget(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        NappNotificationStore.remove(context, siteId, key);

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        summarize(context, siteId, record == null ? siteId : record.label, null);
    }

    /**
     * Take every one of a site's notifications down and forget them.
     *
     * For a site that has lost the permission to post them, or its record.
     * Leaving them in the shade would leave a tap pointing at a window that
     * cannot be served.
     */
    static void cancelAll(@NonNull Context context, @NonNull String siteId) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            manager.cancel(entry.key, 0);
        }
        manager.cancel(NsiteSites.key(siteId) + SUMMARY_SUFFIX, 0);
        NappNotificationStore.clear(context, siteId);
    }

    /** Note that the user has just acted on one of a site's notifications. */
    static void interacted(@NonNull String siteId) {
        INTERACTED.put(siteId, System.currentTimeMillis());
    }

    /** Whether that was recent enough for the site to open its own window. */
    static boolean recentlyInteracted(@NonNull String siteId) {
        Long at = INTERACTED.get(siteId);
        return at != null && System.currentTimeMillis() - at < INTERACTION_WINDOW_MS;
    }

    /** Whether a notification we posted is still on screen. */
    private static boolean isActive(Context context, String key) {
        java.util.Set<String> active = activeKeys(context);
        // Unreadable: assume it is there rather than throwing away a
        // notification the user can still see.
        return active == null || active.contains(key);
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
    // Intents
    // -----------------------------------------------------------------------

    /**
     * Where the body of a notification goes when it is pressed.
     *
     * Straight to the site's window, at the path the site named, and without
     * waiting for anything: a tap has to land at once, and the worker that
     * would have routed it may not be running. The window then tells the push
     * service to raise {@code notificationclick} in the worker anyway, so a
     * site that routes there still can — see {@link NsiteAppActivity}.
     */
    private static PendingIntent openSite(
        Context context,
        String siteId,
        @Nullable String key,
        @Nullable String path
    ) {
        String slot = key == null ? NsiteSites.key(siteId) + SUMMARY_SUFFIX : key;

        return PendingIntent.getActivity(
            context,
            // Distinct per notification, or one would replace another's.
            slot.hashCode(),
            NsiteAppActivity.notificationIntentFor(context, siteId, path, key),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** Fired when the user swipes a notification away. */
    private static PendingIntent dismissed(Context context, String siteId, String key) {
        Intent intent = new Intent(context, NappNotificationReceiver.class)
            .setAction(NappNotificationReceiver.ACTION_DISMISSED)
            .setData(android.net.Uri.parse("tenna-napp:" + key))
            .putExtra(NappNotificationReceiver.EXTRA_SITE_ID, siteId)
            .putExtra(NappNotificationReceiver.EXTRA_KEY, key);

        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    // -----------------------------------------------------------------------
    // Channels
    // -----------------------------------------------------------------------

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

    /**
     * The site's channel, made if it isn't there.
     *
     * One per site, in a group of its own named after the site. Sites may no
     * longer name channels of their own — that came in with the extension this
     * has walked back, and a site naming a channel the user then tunes is a
     * setting they cannot get rid of short of reinstalling.
     *
     * Creating a channel that exists is a no-op and does not undo an
     * importance the user has changed, which is why this can run on every post.
     */
    @NonNull
    private static String ensureChannel(Context context, String siteId, @Nullable String label) {
        String site = NsiteSites.key(siteId);
        String id = SITE_CHANNEL_PREFIX + site + "." + DEFAULT_CHANNEL;

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id;

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return id;

        String name = label == null || label.isEmpty() ? siteId : label;

        // The single shared group, and the one channel a site used to have in
        // it. Neither can be moved, so both go.
        manager.deleteNotificationChannel(SITE_CHANNEL_PREFIX + site);
        manager.deleteNotificationChannelGroup(LEGACY_SITES_GROUP);

        String group = SITE_GROUP_PREFIX + site;
        manager.createNotificationChannelGroup(new NotificationChannelGroup(group, name));

        NotificationChannel channel = new NotificationChannel(
            id,
            "Notifications",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setGroup(group);
        manager.createNotificationChannel(channel);
        return id;
    }
}
