package pub.soapbox.tenna;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
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
 * <b>A site is a bundle of conversations.</b> Each thing a site says is an OS
 * notification of its own, drawn in the layout Android built for messaging
 * apps: the <i>site's</i> icon large on the left with Tenna's badged into its
 * corner, the site's name at the head of the row, and the notification inside
 * it with its own sender and its own face. That is the only layout the
 * platform has where the app's mark is the small one — since Android 12 an
 * ordinary notification puts the app's icon on the left and exiles anything
 * the notification itself supplied to the far corner, which for a browser of
 * other people's sites is exactly backwards.
 *
 * A site's rows share a group with a summary above them, so the shade draws
 * them as one bundle: swiped away together from its header, or one at a time,
 * each with its own tap and its own buttons. A site's {@code tag} is the OS
 * notification's tag, so replacing one by tag replaces that row and no other.
 * See {@link #post} and {@link #summary}.
 *
 * A photograph goes in too, as a line whose body is a picture rather than
 * words — see {@link NappPictures}.
 *
 * Each site also gets a channel group of its own in system settings, named
 * after the site, so a user can mute one site without muting the rest — the
 * nearest Android has to a per-origin notification permission. The push
 * service's own standing notification sits on a separate, quiet channel
 * outside all of that.
 *
 * A notification waits a moment for its pictures and no longer, because
 * Android binds a face the first time it draws the line it belongs to and
 * never goes back for it. See {@link NappImages#awaited}.
 */
final class NappNotifications {

    private static final String TAG = "NappNotifications";

    /** The push service's standing notification. */
    static final String SERVICE_CHANNEL = "napp.service";
    static final int SERVICE_NOTIFICATION_ID = 1;

    /**
     * A remote app waiting on an answer about the user's key.
     *
     * Its own channel, and a loud one, because it is the one thing here the
     * user has to act on for anything to happen: a client on the other end of
     * a relay is holding a request open, and a notification nobody notices is
     * a request that times out. Everything else this class posts is a site
     * saying something.
     */
    private static final String SIGNER_CHANNEL = "napp.signer";
    private static final String SIGNER_TAG_PREFIX = "signer/";

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
     * The tag of the header above a site's rows.
     *
     * A site's own notifications are filed under {@code <site>/<tag>}, so
     * nothing a site can say produces this — which is what stops a site from
     * closing or replacing the header its notifications gather under.
     */
    private static final String SUMMARY_SUFFIX = "!summary";

    /** The group a site's rows and their header share. */
    private static final String BUNDLE_PREFIX = "napp.bundle.";

    /**
     * The single row a version before this one drew every one of a site's
     * notifications into, as lines of one conversation. Taken down on the way
     * past so an upgrade does not leave one sitting in the shade forever.
     */
    private static final String LEGACY_CONVERSATION_SUFFIX = "!conversation";

    /** Draw a notification with its own small icon rather than the app's. */
    private static final String EXTRA_PREFER_SMALL_ICON = "android.app.preferSmallIcon";

    /** Lines listed in a header, for the places that draw one in full. */
    private static final int MAX_SUMMARY_LINES = 6;

    /**
     * How long a record is taken on trust before the tray has to vouch for it.
     *
     * {@code notify()} is queued rather than done, so a notification posted a
     * moment ago may not be in {@code getActiveNotifications()} yet, and a
     * second push landing right behind the first must not decide the first
     * was swiped.
     */
    private static final long SETTLE_MS = 10_000;

    /**
     * How long a notification will wait for its pictures before going out.
     *
     * Android binds a message's face the first time it draws that message and
     * never goes back for it, so a face that lands after the post is a face
     * nobody sees. A push is already asynchronous and nobody is watching the
     * clock; a fraction of a second buys the notification the thing it is
     * mostly made of. Shared by every picture on one notification — see
     * {@link NappImages#awaited}.
     */
    private static final long PICTURE_DEADLINE_MS = 2_000;

    /** For notifications the site gave no tag; each gets a slot of its own. */
    private static final AtomicInteger UNTAGGED = new AtomicInteger(1);

    /** A site's conversation shortcut, kept apart from the one it is pinned by. */
    private static final String CONVERSATION_PREFIX = "napp.conversation.";

    /**
     * Ranked last, so a full shortcut list loses a conversation rather than a
     * site's place in the share sheet. Higher is less important.
     */
    private static final int CONVERSATION_RANK = 1_000;

    /**
     * What was last published for a shortcut id, so an unchanged push can be
     * skipped rather than spent out of the day's quota.
     *
     * In memory only. A restarted process publishes once more per
     * conversation, which is right anyway — the system may have evicted them
     * meanwhile — and cannot go stale the way a written-down copy of somebody
     * else's state could.
     */
    private static final java.util.Map<String, String> PUBLISHED =
        new java.util.concurrent.ConcurrentHashMap<>();

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

    /**
     * Told whenever a site's row in the shade appears, changes or goes away.
     *
     * For the wall, which draws a dot on a site that has something out. There
     * is nothing to subscribe to in the platform for this — an app cannot
     * watch its own notifications without the listener service the user grants
     * for watching everybody's — so the places that move the tray say so, and
     * {@link #unread} is read again.
     *
     * In memory, and a list because a plugin is registered in more than one
     * activity. A watcher that outlives its bridge is the reason for
     * {@link #unwatch}.
     */
    interface OnChanged {
        void changed(@NonNull String siteId);
    }

    private static final java.util.List<OnChanged> WATCHERS =
        new java.util.concurrent.CopyOnWriteArrayList<>();

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

        // Nothing should be listening for a muted site in the first place, but
        // a worker is woken for other reasons too — a tap on an older
        // notification, say — and anything it posts from there is still a
        // notification the user said they did not want.
        if (NappMuted.isMuted(context, siteId)) {
            Log.i(TAG, "Notifications are off for " + siteId + "; dropping one");
            return false;
        }

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) {
            Log.i(TAG, "No record for " + siteId + "; dropping its notification");
            return false;
        }

        JSONObject json = payload.optJSONObject("options");
        if (json == null) json = new JSONObject();

        NappOptions options = NappOptions.parse(json);
        prune(context, siteId);

        // A tagged notification replaces the last one with the same tag, as it
        // does on the web; an untagged one is always another.
        boolean replacing = false;
        String key;
        if (options.tag.isEmpty()) {
            key = NsiteSites.key(siteId) + "/#" + UNTAGGED.getAndIncrement();
        } else {
            key = NsiteSites.key(siteId) + "/" + options.tag;
            replacing = NappNotificationStore.get(context, siteId, key) != null;
        }

        NappNotificationStore.put(context, siteId, new NappNotificationStore.Entry(
            key,
            options.tag,
            NappOptions.title(payload.optString("title", ""), record.label),
            json.toString(),
            options.url,
            System.currentTimeMillis()
        ));

        // Web semantics: replacing a tagged notification is quiet unless the
        // site asks otherwise. Anything the site has not said before alerts.
        boolean alert = !options.silent && (!replacing || options.renotify);

        if (!post(context, siteId, key, alert, System.currentTimeMillis() + PICTURE_DEADLINE_MS)) {
            NappNotificationStore.remove(context, siteId, key);
            return false;
        }

        return true;
    }

    /**
     * Show one of a site's rows again without alerting, because something it
     * was waiting on has arrived.
     *
     * Only ever called by {@link NappImages} once a picture has been decoded.
     * Everything shown is read back from the record written when the
     * notification was posted, so this cannot show anything a site did not
     * already say.
     *
     * Worth doing for a photograph and for the mark in the status bar, both of
     * which the shade will pick up late. A face it will not — which is what
     * the deadline on the way out is for.
     */
    static void repost(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        if (!isEnabled(context)) return;

        // Gone: closed by the site, or swiped away or tapped while the picture
        // was in the air.
        if (NappNotificationStore.get(context, siteId, key) == null) return;
        if (!isActive(context, key)) return;

        post(context, siteId, key, false, 0);
    }

    // -----------------------------------------------------------------------
    // The site's bundle
    // -----------------------------------------------------------------------

    /**
     * Draw one of the site's notifications as a row in the site's bundle.
     *
     * This is about where the pictures go. Since Android 12 a plain
     * notification is drawn with the <i>app's</i> icon in the circle on the
     * left and whatever was passed to {@code setLargeIcon} shrunk into the far
     * corner — so an nsite's notification led with Tenna's mark and put the
     * site's own in the smallest slot on the row. Nothing about the small icon
     * changes that; it is the status bar's, and the shade does not consult it.
     *
     * A {@code MessagingStyle} notification naming a long-lived shortcut is
     * the one layout that does what is wanted: the system draws the
     * <i>shortcut's</i> icon large on the left and badges the app's own into
     * its corner. So the shortcut is the site — its icon, its name — and the
     * notification is a message inside it, spoken by whoever its title names
     * and wearing whatever face its {@code icon} points at. Every row of a
     * site names the same shortcut, so a site costs one shortcut however much
     * it has to say.
     *
     * One row per notification rather than one row per site, so that each has
     * its own tap, its own buttons and its own swipe. What keeps them together
     * is the group: a conversation's group follows its children into the
     * shade's conversation section, header and all.
     */
    private static boolean post(
        Context context,
        String siteId,
        String key,
        boolean alert,
        long deadline
    ) {
        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) return false;

        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null) return false;

        // The application's, so a picture still in the air cannot hold a
        // window's context alive behind it.
        Context app = context.getApplicationContext();

        NappOptions options = optionsOf(entry);
        NappImages.OnLoaded again = () -> repost(app, siteId, key);
        String channel = ensureChannel(context, siteId, record.label);

        NotificationCompat.Builder builder =
            new NotificationCompat.Builder(context, channel)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setSilent(!alert)
                .setOnlyAlertOnce(!alert)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setWhen(options.timestamp > 0 ? options.timestamp : entry.postedAt)
                .setShowWhen(true)
                .setGroup(bundleKey(siteId))
                .setContentIntent(openSite(context, siteId, key, options.url))
                .setDeleteIntent(onDismiss(context, siteId, key));

        smallIcon(builder, context, siteId, options.badge, deadline, again);

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

        String shortcut = CONVERSATION_PREFIX + NsiteSites.key(siteId);
        Bitmap mark = tile == null ? null : tile.bitmap;

        if (publish(context, record, shortcut, mark)) {
            builder.setShortcutId(shortcut);
        } else if (mark != null) {
            // No shortcut, so no icon on the left; the corner is all that is
            // left to put the site's mark in.
            builder.setLargeIcon(mark);
        }

        NotificationCompat.MessagingStyle style =
            new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").build())
                // The site names the conversation and the notification speaks
                // for itself. Without this the system draws the row as the
                // site talking, and the sender's name is lost.
                .setGroupConversation(true)
                .setConversationTitle(record.label);

        for (NotificationCompat.MessagingStyle.Message line
            : messages(context, siteId, record, entry, deadline, again)) {
            style.addMessage(line);
        }

        builder.setStyle(style);
        actions(context, siteId, builder, key, options, deadline, again);

        NotificationManagerCompat manager = NotificationManagerCompat.from(context);

        try {
            manager.notify(key, 0, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS was revoked between the check and the post.
            return false;
        }

        summary(context, siteId, record, channel, tile, options.badge, deadline, again);

        // The single row a version before this one drew a site into.
        manager.cancel(NsiteSites.key(siteId) + LEGACY_CONVERSATION_SUFFIX, 0);

        changed(siteId);

        if (alert) Log.i(TAG, "Posted a notification for " + record.label);
        return true;
    }

    /**
     * The header above a site's rows.
     *
     * Android draws a group as its summary's header with the children under
     * it, and hides the header altogether while there is only one child — so a
     * site with one thing to say looks exactly like that one thing. Swiping the
     * header away takes every row with it, and each row's own delete intent
     * tells the site which ones went.
     *
     * The header's name line is Android's and says Tenna; the site's name goes
     * beside it as the sub-text. Its icon would be Tenna's too — the shade
     * draws a group header with the app's launcher icon — except where the
     * summary asks for its own small icon instead, which is the site's badge.
     * A header over one site's rows wearing Tenna's logo reads as Tenna's
     * notifications, which they are not. The small icon is drawn as a
     * silhouette there, so the badge is the most of the site that fits; its
     * full-colour tile cannot be put there at all. The lines
     * are for the places that draw a summary in full rather than as a header —
     * a watch, or an older shade.
     *
     * Silent always. It is posted again with every row, and only the row is
     * news.
     */
    private static void summary(
        Context context,
        String siteId,
        NsiteSites.Record record,
        String channel,
        @Nullable NsiteSites.TaskIcon tile,
        @Nullable String badge,
        long deadline,
        NappImages.OnLoaded again
    ) {
        List<NappNotificationStore.Entry> entries = NappNotificationStore.list(context, siteId);

        NotificationCompat.InboxStyle lines = new NotificationCompat.InboxStyle()
            .setBigContentTitle(record.label);
        for (int i = entries.size() - 1; i >= Math.max(0, entries.size() - MAX_SUMMARY_LINES); i--) {
            NappNotificationStore.Entry entry = entries.get(i);
            String body = optionsOf(entry).body;
            lines.addLine(body.isEmpty() ? entry.title : entry.title + ": " + body);
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
            .setGroup(bundleKey(siteId))
            .setGroupSummary(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentTitle(record.label)
            .setContentText(entries.size() == 1 ? "1 notification" : entries.size() + " notifications")
            .setSubText(record.label)
            .setStyle(lines)
            .setAutoCancel(true)
            .setContentIntent(openSite(context, siteId, null, null))
            .setDeleteIntent(onDismiss(context, siteId, null));

        // Notification.EXTRA_PREFER_SMALL_ICON, spelled out until the compile
        // SDK has it. Read by SystemUI's icon style provider before it reaches
        // for the app's icon, and ignored everywhere older.
        builder.getExtras().putBoolean(EXTRA_PREFER_SMALL_ICON, true);
        smallIcon(builder, context, siteId, badge, deadline, again);
        if (tile != null) builder.setColor(tile.color).setColorized(false);

        try {
            NotificationManagerCompat.from(context).notify(summaryKey(siteId), 0, builder.build());
        } catch (SecurityException e) {
            // The row is up; a missing header is not worth failing over.
        }
    }

    /**
     * One of the site's notifications, as the line or two it takes up.
     *
     * A web notification is a title and a body, and a message is a sender and
     * what they said, which line up: the title is nearly always who or what
     * the notification is about and the body is the words. A notification with
     * no body has only the one line to give, so it is spoken by the site
     * itself rather than by a name repeated twice.
     *
     * A photograph is a line of its own under the same name, because a message
     * carrying a picture is drawn <i>as</i> the picture and any words on it
     * are dropped. It goes <i>above</i> the words rather than below: the shade
     * lays a conversation out from the bottom and hides whatever will not fit,
     * so what is last is what survives — and a picture that pushed its own
     * caption off the row would be a strange thing to have built. Read down,
     * that is a photograph and then what was said about it, which is the order
     * they come in anyway.
     */
    @NonNull
    private static List<NotificationCompat.MessagingStyle.Message> messages(
        Context context,
        String siteId,
        NsiteSites.Record record,
        NappNotificationStore.Entry entry,
        long deadline,
        NappImages.OnLoaded again
    ) {
        NappOptions options = optionsOf(entry);

        boolean spoken = !options.body.isEmpty();
        String name = spoken ? entry.title : record.label;
        String text = spoken ? options.body : entry.title;

        Person.Builder builder = new Person.Builder()
            .setName(name)
            // By name, so the same sender across two notifications is the same
            // person to the system and its messages are drawn as one run.
            .setKey("napp.sender." + name);

        // No stand-in: a message with no face gets the system's own lettered
        // circle, which says more than the site's icon repeated down the row.
        Bitmap face = NappImages.awaited(
            context, siteId, options.icon, NappImages.SHAPE_ROUND, deadline, again
        );
        if (face != null) builder.setIcon(IconCompat.createWithBitmap(face));

        Person sender = builder.build();
        long at = options.timestamp > 0 ? options.timestamp : entry.postedAt;

        List<NotificationCompat.MessagingStyle.Message> lines = new ArrayList<>(2);

        android.net.Uri uri = options.image == null
            ? null
            : NappPictures.uri(context, siteId, options.image, deadline, again);
        if (uri != null) {
            lines.add(new NotificationCompat.MessagingStyle.Message("", at, sender)
                .setData(NappPictures.mimeType(uri), uri));
        }

        lines.add(new NotificationCompat.MessagingStyle.Message(text, at, sender));
        return lines;
    }

    /**
     * Publish the long-lived shortcut the conversation layout draws from.
     *
     * Best effort, and false when it could not be done — a notification is
     * worth more than the layout it would have had.
     *
     * Two things learned from the app this is imitating. A backgrounded app is
     * rate-limited to a handful of shortcut pushes a day, so a push that would
     * change nothing is skipped and none are attempted once the quota is gone;
     * that way what gets through is the set that changed rather than an
     * arbitrary prefix of it. And these rank below everything else Tenna
     * publishes, so when the list fills it is a conversation that is evicted
     * and not a site's place in the share sheet.
     */
    private static boolean publish(
        Context context,
        NsiteSites.Record record,
        String id,
        @Nullable Bitmap mark
    ) {
        String signature = record.label + "\u0000" + (mark != null);
        if (signature.equals(PUBLISHED.get(id))) return true;

        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager != null && manager.isRateLimitingActive()) {
                // Already published once; the layout stands even if the site
                // has renamed itself since.
                return PUBLISHED.containsKey(id);
            }

            // The site's name goes here, and the system shows it where it
            // would otherwise show the app's — so the row reads as the site
            // rather than as Tenna.
            ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(context, id)
                .setShortLabel(record.label)
                .setLongLabel(record.label)
                .setPerson(new Person.Builder().setName(record.label).setKey(id).build())
                .setLongLived(true)
                .setRank(CONVERSATION_RANK)
                // The site's front page. A shortcut outlives the notification
                // that made it — it can be launched from the launcher months
                // later — so it goes somewhere that will still be there,
                // rather than at whatever one push happened to point at.
                .setIntent(NsiteAppActivity.notificationIntentFor(context, record.siteId, null, null));

            // Plain, not adaptive: an adaptive bitmap is treated as a layer of
            // a 108dp canvas and cropped to the inner 72 of it, which zooms
            // into a picture that has already been cut to the icon's shape and
            // shaves its edges off.
            if (mark != null) shortcut.setIcon(IconCompat.createWithBitmap(mark));

            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());

            PUBLISHED.put(id, signature);
            return true;
        } catch (RuntimeException e) {
            Log.i(TAG, "Could not publish a conversation for " + record.label, e);
            return false;
        }
    }

    /**
     * Forget whichever of a site's notifications are no longer in the shade.
     *
     * The store outlives the tray: notifications do not survive a reboot and
     * their records do, and a tap takes a row away without anything of ours
     * hearing about it — {@code setAutoCancel} is the system's doing. Without
     * this the header would go on counting rows the user has already dealt
     * with, and {@code getNotifications()} would go on handing them back.
     */
    private static void prune(Context context, String siteId) {
        java.util.Set<String> active = activeKeys(context);
        // Unreadable: trust the records rather than deciding the shade is empty.
        if (active == null) return;

        long now = System.currentTimeMillis();
        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            if (active.contains(entry.key)) continue;
            if (now - entry.postedAt < SETTLE_MS) continue;
            NappNotificationStore.remove(context, siteId, entry.key);
        }
    }

    /**
     * Take the header down once there is nothing left under it.
     *
     * Android does not do this itself for a group an app posted: a header
     * whose rows were tapped or swiped one by one stays behind as a row of its
     * own, announcing a site with nothing to say. {@code gone} is a row
     * already on its way out that the tray may not have caught up with.
     */
    private static void tidy(Context context, String siteId, @Nullable String gone) {
        java.util.Set<String> active = activeKeys(context);
        String prefix = NsiteSites.key(siteId) + "/";

        boolean any = false;
        if (active == null) {
            for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
                if (!entry.key.equals(gone)) any = true;
            }
        } else {
            for (String tag : active) {
                if (tag.startsWith(prefix) && !tag.equals(gone)) any = true;
            }
        }

        if (!any) NotificationManagerCompat.from(context).cancel(summaryKey(siteId), 0);
        changed(siteId);
    }

    @NonNull
    private static String summaryKey(String siteId) {
        return NsiteSites.key(siteId) + SUMMARY_SUFFIX;
    }

    @NonNull
    private static String bundleKey(String siteId) {
        return BUNDLE_PREFIX + NsiteSites.key(siteId);
    }

    @NonNull
    private static NappOptions optionsOf(NappNotificationStore.Entry entry) {
        try {
            return NappOptions.parse(new JSONObject(entry.options));
        } catch (JSONException e) {
            // The record is unreadable; the title alone is still a notification.
            return NappOptions.parse(null);
        }
    }

    /**
     * The site's own mark in the status bar, or Tenna's where it has none.
     *
     * The notification's {@code badge} first, then the monochrome icon the
     * site declares in its web app manifest, then Tenna's sun. A badge still
     * being fetched shows the next one down and arrives on the repost.
     */
    private static void smallIcon(
        NotificationCompat.Builder builder,
        Context context,
        String siteId,
        @Nullable String badge,
        long deadline,
        NappImages.OnLoaded again
    ) {
        IconCompat icon = NappBadges.icon(context, siteId, badge, deadline, again);
        if (icon != null) builder.setSmallIcon(icon);
        else builder.setSmallIcon(R.drawable.ic_stat_napp);
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
        long deadline,
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
                : NappBadges.icon(context, siteId, action.icon, deadline, again);

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

    /**
     * Take a notification down, as {@code Notification.close()} does on the
     * web — and the header with it when it was the last one.
     */
    static void cancel(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        if (NappNotificationStore.get(context, siteId, key) == null) return;
        NappNotificationStore.remove(context, siteId, key);
        NotificationManagerCompat.from(context).cancel(key, 0);
        tidy(context, siteId, key);
    }

    /**
     * One of a site's rows swiped away.
     *
     * The site is told, then the record goes. Nothing is posted: the system
     * has already taken the row down, and when the swipe was at the header it
     * is taking the rest down too, each of which arrives here on its own.
     */
    static void dismissed(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        NappNotificationStore.Entry entry = NappNotificationStore.take(context, siteId, key);
        if (entry != null) {
            NappPushService.dispatchNotificationEvent(context, siteId, "notificationclose", entry, null, null);
        }
        tidy(context, siteId, key);
    }

    /**
     * The header swiped away, or the single row a version before this one
     * drew a site into.
     *
     * Every row under the header reports its own dismissal, so for the header
     * this is usually nothing left to do. It is what an old row's swipe still
     * means, though, and a record is taken before it is announced, so a
     * notification is never closed twice.
     */
    static void dismissedAll(@NonNull Context context, @NonNull String siteId) {
        for (NappNotificationStore.Entry listed : NappNotificationStore.list(context, siteId)) {
            NappNotificationStore.Entry entry = NappNotificationStore.take(context, siteId, listed.key);
            if (entry == null) continue;
            NappPushService.dispatchNotificationEvent(context, siteId, "notificationclose", entry, null, null);
        }
        changed(siteId);
    }

    /**
     * One of a site's rows tapped, which took it off the shade.
     *
     * The record stays — the site is about to be told about the tap, and may
     * look the notification up while it answers — but a header over nothing
     * does not.
     */
    static void opened(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        tidy(context, siteId, key);
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
        manager.cancel(summaryKey(siteId), 0);
        manager.cancel(NsiteSites.key(siteId) + LEGACY_CONVERSATION_SUFFIX, 0);

        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            manager.cancel(entry.key, 0);
        }

        NappNotificationStore.clear(context, siteId);
        changed(siteId);
    }

    // -----------------------------------------------------------------------
    // What the wall sees
    // -----------------------------------------------------------------------

    /**
     * Which of the given sites have something in the shade right now.
     *
     * Read from the tray and never written down, because the tray is the only
     * copy that stays true. A tap takes the row away without emptying the
     * store — {@code setAutoCancel} is the system's doing, and nothing of ours
     * runs to hear about it — so a dot drawn from the records would sit there
     * after the user had already answered it. The system's own launcher dot is
     * this same fact, which is why the wall and the launcher agree.
     *
     * An empty answer where the tray cannot be read: no dots is wrong in one
     * direction only, and a dot on a site with nothing behind it is the worse
     * of the two.
     */
    @NonNull
    static java.util.Set<String> unread(
        @NonNull Context context,
        @NonNull java.util.Collection<String> siteIds
    ) {
        java.util.Set<String> unread = new java.util.HashSet<>();
        java.util.Set<String> active = activeKeys(context);
        if (active == null || active.isEmpty()) return unread;

        for (String siteId : siteIds) {
            if (siteId == null) continue;
            String prefix = NsiteSites.key(siteId);

            for (String tag : active) {
                // One of its rows, or the single row a version before this one
                // drew. Not the header, which can outlive what was under it. A
                // site's keys all begin with its own hash, and the service and
                // signer notifications begin with neither.
                if (tag.equals(prefix + LEGACY_CONVERSATION_SUFFIX) || tag.startsWith(prefix + "/")) {
                    unread.add(siteId);
                    break;
                }
            }
        }

        return unread;
    }

    /** Watch for the shade changing. Every watcher must be handed back. */
    static void watch(@NonNull OnChanged watcher) {
        WATCHERS.add(watcher);
    }

    static void unwatch(@NonNull OnChanged watcher) {
        WATCHERS.remove(watcher);
    }

    /** Say that a site's row has appeared, changed or gone. */
    private static void changed(@NonNull String siteId) {
        for (OnChanged watcher : WATCHERS) {
            try {
                watcher.changed(siteId);
            } catch (RuntimeException e) {
                // A bridge torn down between the post and the call. The next
                // read of the wall is the answer either way.
                Log.i(TAG, "A notification watcher threw", e);
            }
        }
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
    static Notification serviceNotification(@NonNull Context context, int siteCount, int connectionCount) {
        ensureServiceChannel(context);

        String text = describeListening(siteCount, connectionCount);

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

    /**
     * What the standing notification says it is doing.
     *
     * <p>Both halves, because they are two different things to be told about
     * a notification that cannot be dismissed: one is sites the user
     * installed, the other is apps that can sign as them. Naming only the
     * first while the second is also running would be the more alarming of
     * the two going unmentioned.
     */
    @NonNull
    private static String describeListening(int siteCount, int connectionCount) {
        String sites = siteCount == 1 ? "1 site" : siteCount + " sites";
        String connections = connectionCount == 1 ? "1 app" : connectionCount + " apps";

        if (connectionCount == 0) return "Listening for notifications from " + sites;
        if (siteCount == 0) return "Signing for " + connections + " you connected";
        return "Listening for " + sites + " and signing for " + connections;
    }

    /**
     * Something is asking to use the key, and nobody has said yes or no.
     *
     * <p>There is no window to put this in. The request arrived on a relay
     * socket held by a service with the app closed, so a notification is the
     * only way it reaches anybody. Tapping it opens the sheet, at whatever
     * {@code open} says.
     *
     * <p>It says what was asked and never what was in it. A lock screen is
     * read by whoever is holding the phone.
     */
    static boolean showSignerRequest(
        @NonNull Context context,
        @NonNull String requestId,
        @NonNull String appName,
        @NonNull String what
    ) {
        return showSignerRequest(context, requestId, appName, what,
            SignerActivity.bunkerIntent(context, requestId));
    }

    static boolean showSignerRequest(
        @NonNull Context context,
        @NonNull String requestId,
        @NonNull String appName,
        @NonNull String what,
        @NonNull Intent intent
    ) {
        // Says so rather than failing quietly, because the caller has somebody
        // waiting for an answer. A request nobody can be shown is one that has
        // to be refused out loud; letting it hang until it expires tells the
        // caller nothing and the user less.
        if (!isEnabled(context)) return false;
        ensureSignerChannel(context);

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;

        PendingIntent open = PendingIntent.getActivity(
            context,
            requestId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(context, SIGNER_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_napp)
            .setContentTitle(appName)
            .setContentText(appName + " " + what)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(appName + " " + what))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(open)
            .setAutoCancel(true)
            // A request that has expired is a request nobody can answer, and
            // the notification for it should go with it rather than open a
            // sheet with nothing in it.
            .setTimeoutAfter(5 * 60_000)
            .build();

        try {
            manager.notify(SIGNER_TAG_PREFIX + requestId, 0, notification);
            return true;
        } catch (SecurityException e) {
            Log.i(TAG, "Could not post a signing request");
            return false;
        }
    }

    /** Take down the notification for a request that has been answered. */
    static void cancelSignerRequest(@NonNull Context context, @NonNull String requestId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(SIGNER_TAG_PREFIX + requestId, 0);
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
     *
     * A null {@code key} is the header's, which opens the site and announces
     * nothing.
     */
    private static PendingIntent openSite(
        Context context,
        String siteId,
        @Nullable String key,
        @Nullable String path
    ) {
        return PendingIntent.getActivity(
            context,
            // Distinct per row, or one row's tap would replace another's: the
            // intent's data is the site's, so only this tells them apart.
            (key != null ? key : summaryKey(siteId)).hashCode(),
            NsiteAppActivity.notificationIntentFor(context, siteId, path, key),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /**
     * Fired when the user swipes one of a site's rows away, or its header
     * when {@code key} is null.
     */
    private static PendingIntent onDismiss(Context context, String siteId, @Nullable String key) {
        Intent intent = new Intent(context, NappNotificationReceiver.class)
            .setAction(NappNotificationReceiver.ACTION_DISMISSED)
            .setData(android.net.Uri.parse("tenna-napp:" + (key != null ? key : summaryKey(siteId))))
            .putExtra(NappNotificationReceiver.EXTRA_SITE_ID, siteId);
        if (key != null) intent.putExtra(NappNotificationReceiver.EXTRA_KEY, key);

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

    private static void ensureSignerChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            SIGNER_CHANNEL,
            "Signing requests",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("An app you connected is asking to sign or decrypt something");
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
