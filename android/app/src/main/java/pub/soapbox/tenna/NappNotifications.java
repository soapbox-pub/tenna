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
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Turns a site's {@code showNotification(title, options)} into one of the
 * OS's.
 *
 * The options a browser understands are honoured as a browser honours them:
 * {@code body}, {@code tag}, {@code silent}, {@code renotify},
 * {@code timestamp}, {@code icon}. What Android can say and the web cannot —
 * a conversation with faces on it, a bundle, a progress bar, a reply box —
 * the site asks for in {@code data.napp}; see {@link NappHints} and
 * {@code NAPP.md}. A site that says nothing there gets exactly what it would
 * get in a browser.
 *
 * Each site gets a channel group of its own, named after the site, so that the
 * system's notification settings can mute one site without muting the rest —
 * the nearest Android has to a per-origin notification permission. Inside it
 * the site may name channels of its own, so a user can keep the mentions and
 * silence the reactions. The push service's own standing notification sits on
 * a separate, quiet channel outside all of that.
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
     * Sites used to share a single "Sites" group with one channel each, which
     * left nowhere to put a channel a site named for itself. Both the old
     * group and the old channel are deleted on the way past; a channel's
     * group cannot be changed once it exists, and neither can its name, so
     * moving them is the only way and it costs a site whatever importance the
     * user had set. Notifications were new enough when this changed that
     * almost nobody had set one.
     */
    private static final String SITE_GROUP_PREFIX = "napp.group.";
    private static final String SITE_CHANNEL_PREFIX = "napp.site.";
    private static final String DEFAULT_CHANNEL = "default";

    private static final String LEGACY_SITES_GROUP = "napp.sites";

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

        String title = payload.optString("title", "");
        JSONObject options = payload.optJSONObject("options");
        if (options == null) options = new JSONObject();

        String tag = options.has("tag") && !options.isNull("tag")
            ? options.optString("tag", "")
            : "";

        // A tagged notification replaces the last one with the same tag, as it
        // does on the web; an untagged one is always another.
        String key = tag.isEmpty()
            ? NsiteSites.key(siteId) + "/#" + UNTAGGED.getAndIncrement()
            : NsiteSites.key(siteId) + "/" + tag;

        NappHints hints = NappHints.parse(options);
        JSONArray lines = accumulate(context, siteId, key, hints);

        return post(context, siteId, title, options, key, tag, lines, false);
    }

    /**
     * Show a notification again without alerting, because something it was
     * waiting on has arrived.
     *
     * Only ever called by {@link NappImages} once a face or a photograph has
     * been decoded. Everything else about the notification is read back from
     * the record written when it was first posted, so this cannot append a
     * line twice or move a conversation on.
     */
    static void repost(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        if (!isEnabled(context)) return;

        NappNotificationStore.Entry entry = NappNotificationStore.get(context, siteId, key);
        if (entry == null) return;

        // The user swiped it away while the picture was in the air.
        if (!isActive(context, key)) return;

        try {
            post(
                context,
                siteId,
                entry.title,
                new JSONObject(entry.options),
                key,
                entry.tag,
                entry.lines,
                true
            );
        } catch (JSONException e) {
            // The record is unreadable; it will be replaced by the next post.
        }
    }

    /**
     * The lines this notification is to show, once merging has been settled.
     *
     * {@code merge: "append"} means the payload carries only what is new, and
     * the runtime remembers the rest — which is the whole reason it exists,
     * because a service worker is started for one event and killed shortly
     * after and has nowhere of its own to keep a conversation.
     *
     * A notification the user has already swiped away starts over. Appending
     * to it would resurrect lines they dismissed, which is Android's rule for
     * its own conversations and the right one.
     */
    @NonNull
    private static JSONArray accumulate(
        Context context,
        String siteId,
        String key,
        @NonNull NappHints hints
    ) {
        JSONArray fresh = NappHints.linesOf(hints);
        if (!hints.append) return fresh;

        NappNotificationStore.Entry previous = NappNotificationStore.get(context, siteId, key);
        if (previous == null || !isActive(context, key)) return fresh;

        JSONArray merged = new JSONArray();
        for (int i = 0; i < previous.lines.length(); i++) merged.put(previous.lines.opt(i));
        for (int i = 0; i < fresh.length(); i++) merged.put(fresh.opt(i));

        // Keep the newest, so a busy conversation stays readable rather than
        // becoming a wall.
        int drop = merged.length() - NappHints.MAX_LINES;
        if (drop <= 0) return merged;

        JSONArray capped = new JSONArray();
        for (int i = drop; i < merged.length(); i++) capped.put(merged.opt(i));
        return capped;
    }

    // -----------------------------------------------------------------------

    private static boolean post(
        Context context,
        String siteId,
        String title,
        JSONObject options,
        String key,
        String tag,
        JSONArray lines,
        boolean quiet
    ) {
        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) return false;

        NappHints hints = NappHints.parse(options);

        String body = options.optString("body", "");
        boolean silent = options.optBoolean("silent", false);
        boolean renotify = options.optBoolean("renotify", false);
        long timestamp = options.optLong("timestamp", 0);
        boolean ongoing = hints.ongoing;

        String channelId = ensureChannel(context, siteId, record.label, hints);

        // The application's, so a picture still in the air cannot hold a
        // window's context alive behind it.
        Context app = context.getApplicationContext();
        NappImages.OnLoaded again = () -> repost(app, siteId, key);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_napp)
            .setContentTitle(title.isEmpty() ? record.label : title)
            // Whose notification this is, whatever the site put in the title.
            .setSubText(record.label)
            .setAutoCancel(!ongoing)
            .setOngoing(ongoing)
            .setSilent(silent)
            // Web semantics: replacing a tagged notification is quiet unless
            // the site asks otherwise. A first post alerts either way.
            .setOnlyAlertOnce(quiet || !renotify)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(category(hints))
            .setContentIntent(openSite(context, siteId, key, hints.url))
            .setDeleteIntent(dismissed(context, siteId, key));

        if (timestamp > 0) builder.setWhen(timestamp).setShowWhen(true);
        if (hints.count > 0) builder.setNumber(hints.count);
        if (hints.group != null) builder.setGroup(NsiteSites.key(siteId) + "/" + hints.group);
        if (hints.progress) {
            builder.setProgress(
                hints.progressMax,
                Math.max(0, hints.progressValue),
                hints.progressValue < 0
            );
        }

        // The site's field colour, already worked out for the recents card, so
        // the shade tints the small icon and the site's name to match its tile.
        NsiteSites.TaskIcon tile = NsiteSites.taskIcon(context, siteId);
        if (tile != null) builder.setColor(tile.color).setColorized(false);

        Bitmap large = largeIcon(context, siteId, options, hints, again);
        builder.setLargeIcon(large != null ? large : (tile == null ? null : tile.bitmap));

        style(context, siteId, builder, record.label, title, body, hints, lines, again);
        actions(context, siteId, builder, key, hints);

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
            options.toString(),
            hints.url,
            lines,
            System.currentTimeMillis()
        ));

        if (!quiet) Log.i(TAG, "Posted a notification for " + record.label);
        return true;
    }

    private static String category(@NonNull NappHints hints) {
        if (hints.progress || hints.ongoing) return NotificationCompat.CATEGORY_PROGRESS;
        if (hints.style == NappHints.STYLE_MESSAGE) return NotificationCompat.CATEGORY_MESSAGE;
        return NotificationCompat.CATEGORY_SOCIAL;
    }

    /**
     * The picture beside the notification.
     *
     * The sender's face where the site named one, then whatever it passed as
     * the standard {@code icon}, then the site's own tile. A face is cut round
     * because that is how Android draws both a large icon and a messaging
     * avatar; a site's icon is left as it is, having already been drawn to the
     * launcher's shape.
     */
    @Nullable
    private static Bitmap largeIcon(
        Context context,
        String siteId,
        JSONObject options,
        @NonNull NappHints hints,
        NappImages.OnLoaded again
    ) {
        if (hints.person != null && hints.person.icon != null) {
            Bitmap face = NappImages.cached(context, siteId, hints.person.icon, true, again);
            if (face != null) return face;
        }

        String icon = options.optString("icon", null);
        if (icon == null || icon.isEmpty()) return null;
        return NappImages.cached(context, siteId, NappHints.imageOf(icon), false, again);
    }

    private static void style(
        Context context,
        String siteId,
        NotificationCompat.Builder builder,
        String label,
        String title,
        String body,
        @NonNull NappHints hints,
        JSONArray lines,
        NappImages.OnLoaded again
    ) {
        int style = hints.style;

        if (style == NappHints.STYLE_MESSAGE) {
            List<NappHints.Message> messages = NappHints.messagesOf(lines);
            if (!messages.isEmpty()) {
                messaging(context, siteId, builder, title, hints, messages, again);
                return;
            }
        }

        if (style == NappHints.STYLE_INBOX) {
            NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
            StringBuilder collapsed = new StringBuilder();
            for (int i = 0; i < lines.length(); i++) {
                String line = lines.optString(i, null);
                if (line == null) continue;
                inbox.addLine(line);
                if (collapsed.length() > 0) collapsed.append(" · ");
                collapsed.append(line);
            }
            if (!body.isEmpty()) inbox.setSummaryText(body);
            builder.setContentText(body.isEmpty() ? collapsed.toString() : body).setStyle(inbox);
            return;
        }

        if (style == NappHints.STYLE_PICTURE && hints.image != null) {
            Bitmap picture = NappImages.cached(context, siteId, hints.image, false, again);
            if (picture != null) {
                NotificationCompat.BigPictureStyle big = new NotificationCompat.BigPictureStyle()
                    .bigPicture(picture)
                    // The large icon would otherwise be redrawn over the top of
                    // the photograph when the notification is expanded.
                    .bigLargeIcon((Bitmap) null);
                if (hints.summary != null) big.setSummaryText(hints.summary);
                if (!body.isEmpty()) builder.setContentText(body);
                builder.setStyle(big);
                return;
            }
            // Not decoded yet: show it flat, and expand when it lands.
        }

        if (!body.isEmpty()) {
            builder.setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }
    }

    /**
     * A conversation, drawn the way Android draws its own.
     *
     * The title is the conversation's own where the site named one, and the
     * style is told it is a group; a two-person thread names neither, and the
     * system lays it out as the 1:1 it is.
     */
    private static void messaging(
        Context context,
        String siteId,
        NotificationCompat.Builder builder,
        String title,
        @NonNull NappHints hints,
        List<NappHints.Message> messages,
        NappImages.OnLoaded again
    ) {
        Person self = person(context, siteId, hints.me, "You", again);
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(self);

        if (hints.conversation != null) {
            style.setConversationTitle(hints.conversation);
            style.setGroupConversation(true);
        } else {
            style.setGroupConversation(hints.groupConversation);
        }

        for (NappHints.Message message : messages) {
            style.addMessage(new NotificationCompat.MessagingStyle.Message(
                message.text,
                message.timestamp > 0 ? message.timestamp : System.currentTimeMillis(),
                // Null is the user's own line, which is what the style wants.
                message.from == null ? null : person(context, siteId, message.from, title, again)
            ));
        }

        builder.setStyle(style);
    }

    @NonNull
    private static Person person(
        Context context,
        String siteId,
        @Nullable NappHints.Person from,
        String fallbackName,
        NappImages.OnLoaded again
    ) {
        String name = from != null ? from.name : fallbackName;
        Person.Builder builder = new Person.Builder().setName(name.isEmpty() ? "You" : name);

        if (from != null && from.id != null) builder.setKey(from.id);
        if (from != null && from.icon != null) {
            Bitmap face = NappImages.cached(context, siteId, from.icon, true, again);
            if (face != null) builder.setIcon(IconCompat.createWithBitmap(face));
        }

        return builder.build();
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
        @NonNull NappHints hints
    ) {
        for (NappHints.Action action : hints.actions) {
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

            NotificationCompat.Action.Builder button = new NotificationCompat.Action.Builder(
                IconCompat.createWithResource(context, R.drawable.ic_stat_napp),
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
    // The tray
    // -----------------------------------------------------------------------

    /** Take a notification down, as {@code Notification.close()} does on the web. */
    static void cancel(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        NotificationManagerCompat.from(context).cancel(key, 0);
        NappNotificationStore.remove(context, siteId, key);
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
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return true;

        try {
            for (StatusBarNotification posted : manager.getActiveNotifications()) {
                if (key.equals(posted.getTag())) return true;
            }
        } catch (RuntimeException e) {
            // Some OEM builds refuse to enumerate. Assume it is there rather
            // than throwing away a conversation the user can still see.
            return true;
        }

        return false;
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
        String key,
        @Nullable String path
    ) {
        return PendingIntent.getActivity(
            context,
            // Distinct per notification, or one would replace another's.
            key.hashCode(),
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
     * The channel this notification belongs on, made if it isn't there.
     *
     * A site's own channel where it named one, so the user can silence its
     * reactions and keep its mentions; the site's default channel otherwise.
     * Creating a channel that exists is a no-op and does not undo an
     * importance the user has changed, which is why this can run on every
     * post.
     */
    @NonNull
    private static String ensureChannel(
        Context context,
        String siteId,
        @Nullable String label,
        @NonNull NappHints hints
    ) {
        String site = NsiteSites.key(siteId);
        NappHints.Channel named = hints.channel;
        String id = SITE_CHANNEL_PREFIX + site + "." + (named == null ? DEFAULT_CHANNEL : named.id);

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
            named == null ? "Notifications" : named.name,
            named == null ? NotificationManager.IMPORTANCE_DEFAULT : named.importance
        );
        channel.setGroup(group);
        manager.createNotificationChannel(channel);
        return id;
    }
}
