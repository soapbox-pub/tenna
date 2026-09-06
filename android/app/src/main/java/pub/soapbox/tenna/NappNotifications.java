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
 * <b>A site is a conversation.</b> Everything a site sends goes into one
 * notification of its own, drawn in the layout Android built for messaging
 * apps: the <i>site's</i> icon large on the left with Tenna's badged into its
 * corner, the site's name at the head of the row, and each push listed inside
 * it as its own line with its own sender and its own face. That is the only
 * layout the platform has where the app's mark is the small one — since
 * Android 12 an ordinary notification puts the app's icon on the left and
 * exiles anything the notification itself supplied to the far corner, which
 * for a browser of other people's sites is exactly backwards.
 *
 * So one OS notification per site, rebuilt from the site's live notifications
 * every time one arrives, is taken back, or is closed. A site's {@code tag}
 * still names a notification, still replaces the last one with that name, and
 * is still what {@code getNotifications()} and {@code close()} work on; it is
 * only the row in the shade that is shared. See {@link #render}.
 *
 * The exception is a notification carrying an {@code image}. A photograph has
 * nowhere to go inside a conversation, so those stand alone, and the per-site
 * group summary is what keeps them together — see {@link #summarize}.
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
     * The tags of the two notifications a site does not post itself.
     *
     * A site's own are filed under {@code <site>/<tag>}, so nothing a site can
     * say produces either of these — which is what stops a site from closing
     * or replacing the row its notifications live in.
     */
    private static final String CONVERSATION_SUFFIX = "!conversation";
    private static final String SUMMARY_SUFFIX = "!summary";

    /** Titles listed on the summary before the system's own count takes over. */
    private static final int SUMMARY_LINES = 6;

    /**
     * Lines shown in a site's conversation.
     *
     * The platform keeps the last 25 of a {@code MessagingStyle} and drops the
     * rest, so sending more is only a bigger parcel over the binder.
     */
    private static final int MAX_MESSAGES = 25;

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

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) {
            Log.i(TAG, "No record for " + siteId + "; dropping its notification");
            return false;
        }

        JSONObject json = payload.optJSONObject("options");
        if (json == null) json = new JSONObject();

        NappOptions options = NappOptions.parse(json);

        // A photograph cannot be drawn inside a conversation; everything else
        // can, and everything else is better off there.
        boolean conversation = options.image == null;
        if (conversation) discardStale(context, siteId);

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
            conversation,
            System.currentTimeMillis()
        ));

        // Web semantics: replacing a tagged notification is quiet unless the
        // site asks otherwise. Anything the site has not said before alerts.
        boolean alert = !options.silent && (!replacing || options.renotify);

        long deadline = System.currentTimeMillis() + PICTURE_DEADLINE_MS;
        boolean shown = conversation
            ? render(context, siteId, alert, deadline)
            : standalone(context, siteId, key, alert, deadline);

        if (!shown) {
            NappNotificationStore.remove(context, siteId, key);
            return false;
        }

        if (!conversation) summarize(context, siteId, record.label, key);
        return true;
    }

    /**
     * Show a notification again without alerting, because something it was
     * waiting on has arrived.
     *
     * Only ever called by {@link NappImages} once a picture has been decoded.
     * Everything shown is read back from the records written when the
     * notifications were posted, so this cannot show anything a site did not
     * already say.
     */
    static void repost(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        if (!isEnabled(context)) return;

        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null) return;

        if (entry.conversation) {
            // The user swiped the whole conversation away while the picture
            // was in the air.
            if (!isActive(context, conversationKey(siteId))) return;
            render(context, siteId, false, 0);
        } else {
            if (!isActive(context, key)) return;
            standalone(context, siteId, key, false, 0);
        }
    }

    // -----------------------------------------------------------------------
    // The site's conversation
    // -----------------------------------------------------------------------

    /**
     * Draw everything the site currently has to say as one conversation.
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
     * its corner. So the shortcut is the site — its icon, its name — and each
     * of the site's live notifications is a message inside it, spoken by
     * whoever the notification's title names and wearing whatever face its
     * {@code icon} points at. Expanded, that is the site's notifications one
     * under another, which is what a site with four things to say ought to
     * look like.
     *
     * Rebuilt from the store rather than added to, because that is the only
     * thing that stays true: a notification the site closed, or the user
     * swiped, or replaced by tag, has to leave the row it was in.
     */
    private static boolean render(Context context, String siteId, boolean alert, long deadline) {
        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) return false;

        String key = conversationKey(siteId);
        List<NappNotificationStore.Entry> entries = conversationEntries(context, siteId);

        if (entries.isEmpty()) {
            NotificationManagerCompat.from(context).cancel(key, 0);
            return false;
        }

        // The application's, so a picture still in the air cannot hold a
        // window's context alive behind it.
        Context app = context.getApplicationContext();

        NappNotificationStore.Entry newest = entries.get(entries.size() - 1);
        NappOptions options = optionsOf(newest);
        NappImages.OnLoaded again = () -> repost(app, siteId, newest.key);

        NotificationCompat.Builder builder =
            new NotificationCompat.Builder(context, ensureChannel(context, siteId, record.label))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setSilent(!alert)
                .setOnlyAlertOnce(!alert)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setWhen(options.timestamp > 0 ? options.timestamp : newest.postedAt)
                .setShowWhen(true)
                // The tap goes where the newest one pointed: it is the one the
                // user is answering, and the only one the row is showing in
                // full when it is collapsed.
                .setContentIntent(openSite(context, siteId, newest.key, options.url))
                .setDeleteIntent(conversationDismissed(context, siteId));

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
            // A group of its own, which is a group of one. Android lifts a
            // conversation out of the shade's ordinary section entirely, so it
            // can neither join the site's bundle nor be swept into the pile
            // Android makes of four loose notifications from one app — and an
            // explicit key is how it opts out of the second without asking for
            // the first.
            builder.setShortcutId(shortcut).setGroup(shortcut);
        } else if (mark != null) {
            // No shortcut, so no icon on the left; the corner is all that is
            // left to put the site's mark in.
            builder.setLargeIcon(mark);
        }

        NotificationCompat.MessagingStyle style =
            new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").build())
                // The site names the conversation, and each notification
                // inside it speaks for itself. Without this the system draws
                // the whole row as one person talking, and the titles of
                // everything but the newest are lost.
                .setGroupConversation(true)
                .setConversationTitle(record.label);

        for (int i = Math.max(0, entries.size() - MAX_MESSAGES); i < entries.size(); i++) {
            style.addMessage(message(context, siteId, record, entries.get(i), deadline, again));
        }

        builder.setStyle(style);

        // The newest one's, because they are what the user is being asked
        // about; a button under a row of four cannot answer all of them.
        actions(context, siteId, builder, newest.key, options, deadline, again);

        try {
            NotificationManagerCompat.from(context).notify(key, 0, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS was revoked between the check and the post.
            return false;
        }

        if (alert) Log.i(TAG, "Posted a notification for " + record.label);
        return true;
    }

    /**
     * One of the site's notifications, as a line in its conversation.
     *
     * A web notification is a title and a body, and a message is a sender and
     * what they said, which line up: the title is nearly always who or what
     * the notification is about and the body is the words. A notification with
     * no body has only the one line to give, so it is spoken by the site
     * itself rather than by a name repeated twice.
     */
    private static NotificationCompat.MessagingStyle.Message message(
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

        Person.Builder sender = new Person.Builder()
            .setName(name)
            // By name, so the same sender across two notifications is the same
            // person to the system and its messages are drawn as one run.
            .setKey("napp.sender." + name);

        // No stand-in: a message with no face gets the system's own lettered
        // circle, which says more than the site's icon repeated down the row.
        Bitmap face = NappImages.awaited(
            context, siteId, options.icon, NappImages.SHAPE_ROUND, deadline, again
        );
        if (face != null) sender.setIcon(IconCompat.createWithBitmap(face));

        long at = options.timestamp > 0 ? options.timestamp : entry.postedAt;
        return new NotificationCompat.MessagingStyle.Message(text, at, sender.build());
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

    /** The site's live notifications that belong in its conversation, oldest first. */
    @NonNull
    private static List<NappNotificationStore.Entry> conversationEntries(Context context, String siteId) {
        List<NappNotificationStore.Entry> entries = new ArrayList<>();
        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            if (entry.conversation) entries.add(entry);
        }
        return entries;
    }

    /**
     * Forget a site's conversation when the conversation is no longer there.
     *
     * The store outlives the tray: notifications do not survive a reboot and
     * their records do. Without this the first push after one would arrive
     * with a week of old ones stacked underneath it, none of which the user
     * has been able to see since the phone came back up.
     */
    private static void discardStale(Context context, String siteId) {
        java.util.Set<String> active = activeKeys(context);
        // Unreadable, or the conversation is up and its records are current.
        if (active == null || active.contains(conversationKey(siteId))) return;

        for (NappNotificationStore.Entry entry : conversationEntries(context, siteId)) {
            NappNotificationStore.remove(context, siteId, entry.key);
        }
    }

    @NonNull
    private static String conversationKey(String siteId) {
        return NsiteSites.key(siteId) + CONVERSATION_SUFFIX;
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

    // -----------------------------------------------------------------------
    // A notification that stands alone
    // -----------------------------------------------------------------------

    /**
     * A notification carrying a photograph, drawn on its own.
     *
     * {@code BigPictureStyle} and {@code MessagingStyle} are alternatives, and
     * a picture is the thing the site went to the trouble of sending, so it
     * wins the row. These join the site's bundle instead of its conversation.
     */
    private static boolean standalone(Context context, String siteId, String key, boolean alert, long deadline) {
        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) return false;

        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null) return false;

        NappOptions options = optionsOf(entry);

        Context app = context.getApplicationContext();
        NappImages.OnLoaded again = () -> repost(app, siteId, key);

        NotificationCompat.Builder builder =
            new NotificationCompat.Builder(context, ensureChannel(context, siteId, record.label))
                .setContentTitle(entry.title)
                // Whose notification this is, whatever the site put in the title.
                .setSubText(record.label)
                .setAutoCancel(true)
                .setSilent(!alert)
                .setOnlyAlertOnce(!alert)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setGroup(NsiteSites.key(siteId))
                .setContentIntent(openSite(context, siteId, key, options.url))
                .setDeleteIntent(dismissed(context, siteId, key));

        smallIcon(builder, context, siteId, options.badge, deadline, again);

        if (options.timestamp > 0) builder.setWhen(options.timestamp).setShowWhen(true);

        if (options.vibrate != null && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setVibrate(options.vibrate);
        }

        NsiteSites.TaskIcon tile = NsiteSites.taskIcon(context, siteId);
        if (tile != null) builder.setColor(tile.color).setColorized(false);

        Bitmap large = NappImages.awaited(
            context, siteId, options.icon, NappImages.SHAPE_PLAIN, deadline, again
        );
        builder.setLargeIcon(large != null ? large : (tile == null ? null : tile.bitmap));

        Bitmap picture = NappImages.awaited(
            context, siteId, options.image, NappImages.SHAPE_PLAIN, deadline, again
        );
        if (picture != null) {
            NotificationCompat.BigPictureStyle big = new NotificationCompat.BigPictureStyle()
                .bigPicture(picture)
                // The large icon would otherwise be redrawn over the top of
                // the photograph when the notification is expanded.
                .bigLargeIcon((Bitmap) null);
            if (!options.body.isEmpty()) builder.setContentText(options.body);
            builder.setStyle(big);
        } else if (!options.body.isEmpty()) {
            // Not decoded yet: flat for now, and it expands when it lands.
            builder
                .setContentText(options.body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(options.body));
        }

        actions(context, siteId, builder, key, options, deadline, again);

        try {
            NotificationManagerCompat.from(context).notify(key, 0, builder.build());
        } catch (SecurityException e) {
            return false;
        }

        if (alert) Log.i(TAG, "Posted a notification for " + record.label);
        return true;
    }

    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // The bundle
    // -----------------------------------------------------------------------

    /**
     * The header a site's standalone notifications sit under, posted or taken
     * down to match what the site currently has out.
     *
     * Android will bundle several notifications from one app on its own, but
     * it bundles them as <i>the app</i> — which for Tenna means every site's
     * notifications in one pile under one name. A summary per site is what
     * makes the pile per site instead, and it wears the site's own mark so the
     * pile is recognisable before it is opened.
     *
     * Only the ones drawn on their own are counted. A conversation is lifted
     * by Android into its own section above the shade, where it neither joins
     * a group nor counts towards one.
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
     * The titles of the site's standalone notifications that are actually on
     * screen, oldest first.
     *
     * What the system says is on screen wins over what is written down, with
     * the one just posted taken on trust: {@code notify()} is answered by a
     * handler in the notification service, and asking it a moment later can be
     * asking too early.
     */
    @NonNull
    private static List<String> live(Context context, String siteId, @Nullable String posted) {
        java.util.Set<String> active = activeKeys(context);
        List<String> titles = new ArrayList<>();

        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            // In the conversation, and so not in the bundle.
            if (entry.conversation) continue;
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
        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null || !entry.conversation) NotificationManagerCompat.from(context).cancel(key, 0);
        forget(context, siteId, key);
    }

    /**
     * Forget a notification that is no longer in the tray.
     *
     * Either the site closed it or the user swiped it away. What is left is
     * the record, and the row it was a line of: a conversation is redrawn
     * without it, and the header above a bundle comes down if that was the
     * last of them.
     */
    static void forget(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        NappNotificationStore.remove(context, siteId, key);

        if (entry != null && entry.conversation) {
            render(context, siteId, false, 0);
            return;
        }

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        summarize(context, siteId, record == null ? siteId : record.label, null);
    }

    /**
     * The site's notifications that its conversation is currently showing.
     *
     * For the swipe that takes the whole row away: each one is a notification
     * the site is owed a {@code notificationclose} for.
     */
    @NonNull
    static List<String> conversationKeys(@NonNull Context context, @NonNull String siteId) {
        List<String> keys = new ArrayList<>();
        for (NappNotificationStore.Entry entry : conversationEntries(context, siteId)) {
            keys.add(entry.key);
        }
        return keys;
    }

    /**
     * Forget the whole of a site's conversation, the user having swiped it.
     *
     * Nothing is redrawn and nothing is cancelled: the system has already
     * taken the row away, and posting it again minus one line is not what a
     * swipe asked for.
     */
    static void forgetConversation(@NonNull Context context, @NonNull String siteId) {
        for (NappNotificationStore.Entry entry : conversationEntries(context, siteId)) {
            NappNotificationStore.remove(context, siteId, entry.key);
        }
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
        manager.cancel(conversationKey(siteId), 0);
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

    /** Fired when the user swipes a standalone notification away. */
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

    /**
     * Fired when the user swipes a site's whole conversation away.
     *
     * Which is several notifications at once, and the site is owed a
     * {@code notificationclose} for each of them.
     */
    private static PendingIntent conversationDismissed(Context context, String siteId) {
        Intent intent = new Intent(context, NappNotificationReceiver.class)
            .setAction(NappNotificationReceiver.ACTION_CONVERSATION_DISMISSED)
            .setData(android.net.Uri.parse("tenna-napp:" + conversationKey(siteId)))
            .putExtra(NappNotificationReceiver.EXTRA_SITE_ID, siteId);

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
