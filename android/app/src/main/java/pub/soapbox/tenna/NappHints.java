package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * What a site asked for beyond what the Notifications API can say.
 *
 * A web notification is a title, a line of text and a tag. Android's is a
 * conversation with faces on it, a progress bar, a bundle, a reply box. The
 * difference is not something {@code showNotification} has anywhere to put, so
 * a site puts it in {@code options.data.napp} — a member every other browser
 * ignores, which is what keeps a site written for Tenna a site that still
 * works anywhere else. It rides in {@code data} rather than beside it so that
 * it comes back to the worker on {@code notificationclick} along with
 * everything else the site attached.
 *
 * Everything here is untrusted. A site can say anything, and some of it
 * becomes a channel name the user sees in system settings for as long as the
 * app is installed, so every string is clamped and stripped of the control
 * characters that would let one line pretend to be two. Nothing is rejected
 * outright: a hint that makes no sense is dropped and the notification is
 * still shown, because the alternative is a site whose users silently stop
 * hearing from it.
 */
final class NappHints {

    /** Lines one notification can carry, whether messages or inbox rows. */
    static final int MAX_LINES = 8;

    /** Buttons. Android draws three and ignores the rest. */
    static final int MAX_ACTIONS = 3;

    private static final int MAX_TEXT = 512;
    private static final int MAX_TITLE = 160;
    private static final int MAX_NAME = 64;
    private static final int MAX_ID = 128;
    private static final int MAX_IMAGE = 4096;

    // -----------------------------------------------------------------------

    /** Somebody a notification is from: the large icon, and a messaging face. */
    static final class Person {
        /** Stable across notifications, so Android can tell two senders apart. */
        @Nullable final String id;
        @NonNull final String name;
        @Nullable final String icon;

        Person(@Nullable String id, @NonNull String name, @Nullable String icon) {
            this.id = id;
            this.name = name;
            this.icon = icon;
        }
    }

    /** One line of a conversation. */
    static final class Message {
        @NonNull final String text;
        /** Milliseconds. Zero means "when it was posted". */
        final long timestamp;
        /** Null for the user's own line, which is what MessagingStyle wants. */
        @Nullable final Person from;

        Message(@NonNull String text, long timestamp, @Nullable Person from) {
            this.text = text;
            this.timestamp = timestamp;
            this.from = from;
        }
    }

    /** A channel of the site's own, under the site's group in system settings. */
    static final class Channel {
        @NonNull final String id;
        @NonNull final String name;
        /** One of the {@code NotificationManager.IMPORTANCE_*} values. */
        final int importance;

        Channel(@NonNull String id, @NonNull String name, int importance) {
            this.id = id;
            this.name = name;
            this.importance = importance;
        }
    }

    /**
     * A button, and whether pressing it opens a reply box first.
     *
     * Read from the standard {@code options.actions}, not from the {@code napp}
     * member: the Notifications API already has exactly this, down to
     * {@code type: "text"} for an inline reply and {@code event.reply} for what
     * was typed. There was nothing here worth inventing.
     */
    static final class Action {
        @NonNull final String action;
        @NonNull final String title;
        final boolean input;
        @Nullable final String placeholder;

        Action(@NonNull String action, @NonNull String title, boolean input, @Nullable String placeholder) {
            this.action = action;
            this.title = title;
            this.input = input;
            this.placeholder = placeholder;
        }
    }

    static final int STYLE_TEXT = 0;
    static final int STYLE_MESSAGE = 1;
    static final int STYLE_INBOX = 2;
    static final int STYLE_PICTURE = 3;

    // -----------------------------------------------------------------------

    /** Where a tap goes, as a site-absolute path. */
    @Nullable final String url;

    /** Whether this payload adds to what is already shown, or replaces it. */
    final boolean append;

    @Nullable final Channel channel;
    @Nullable final String group;
    @Nullable final Person person;

    final int style;

    /** {@link #STYLE_MESSAGE}: the conversation's name, or null for a 1:1. */
    @Nullable final String conversation;
    /** {@link #STYLE_MESSAGE}: whether more than two people are in it. */
    final boolean groupConversation;
    /** {@link #STYLE_MESSAGE}: this payload's lines. */
    @NonNull final List<Message> messages;
    /** {@link #STYLE_MESSAGE}: who the user is, for their own lines. */
    @Nullable final Person me;

    /** {@link #STYLE_INBOX}: this payload's rows. */
    @NonNull final List<String> lines;

    /** {@link #STYLE_PICTURE}: the picture, and the line under it when expanded. */
    @Nullable final String image;
    @Nullable final String summary;

    @NonNull final List<Action> actions;

    final boolean ongoing;
    /** True when a progress bar was asked for at all. */
    final boolean progress;
    final int progressValue;
    final int progressMax;
    /** Zero when the site named no count. */
    final int count;

    private NappHints(Builder b) {
        this.url = b.url;
        this.append = b.append;
        this.channel = b.channel;
        this.group = b.group;
        this.person = b.person;
        this.style = b.style;
        this.conversation = b.conversation;
        this.groupConversation = b.groupConversation;
        this.messages = b.messages;
        this.me = b.me;
        this.lines = b.lines;
        this.image = b.image;
        this.summary = b.summary;
        this.actions = b.actions;
        this.ongoing = b.ongoing;
        this.progress = b.progress;
        this.progressValue = b.progressValue;
        this.progressMax = b.progressMax;
        this.count = b.count;
    }

    private static final class Builder {
        @Nullable String url;
        boolean append;
        @Nullable Channel channel;
        @Nullable String group;
        @Nullable Person person;
        int style = STYLE_TEXT;
        @Nullable String conversation;
        boolean groupConversation;
        List<Message> messages = new ArrayList<>();
        @Nullable Person me;
        List<String> lines = new ArrayList<>();
        @Nullable String image;
        @Nullable String summary;
        List<Action> actions = new ArrayList<>();
        boolean ongoing;
        boolean progress;
        int progressValue = -1;
        int progressMax = 100;
        int count;
    }

    // -----------------------------------------------------------------------

    /**
     * Read everything out of a notification's options that the builder needs
     * beyond a title and a line of text.
     *
     * Never null: the buttons come from the standard {@code options.actions},
     * and {@code data.url} is honoured on its own with no {@code napp} member
     * at all — it is what every push service worker on Nostr already writes,
     * and knowing where a tap goes is worth more than insisting on a spelling.
     * A payload with none of it produces hints that say nothing, which is a
     * plain notification.
     */
    @NonNull
    static NappHints parse(@Nullable JSONObject options) {
        Builder b = new Builder();
        if (options == null) return new NappHints(b);

        actions(b, options.optJSONArray("actions"));

        JSONObject data = options.optJSONObject("data");
        if (data == null) return new NappHints(b);

        String legacyUrl = path(data.optString("url", null));
        JSONObject napp = data.optJSONObject("napp");

        if (napp == null) {
            b.url = legacyUrl;
            return new NappHints(b);
        }

        String url = path(napp.optString("url", null));
        b.url = url != null ? url : legacyUrl;
        b.append = "append".equals(napp.optString("merge", "replace"));
        b.channel = channel(napp.optJSONObject("channel"));
        b.group = text(napp.optString("group", null), MAX_ID);
        b.person = person(napp.optJSONObject("person"));
        b.ongoing = napp.optBoolean("ongoing", false);
        b.count = Math.max(0, Math.min(napp.optInt("count", 0), 9999));

        JSONObject progress = napp.optJSONObject("progress");
        if (progress != null) {
            b.progress = true;
            b.progressMax = Math.max(1, Math.min(progress.optInt("max", 100), 1_000_000));
            // Absent means indeterminate, which is a real answer for a job
            // that has started and cannot say how far along it is.
            b.progressValue = progress.has("value") && !progress.isNull("value")
                ? Math.max(0, Math.min(progress.optInt("value", 0), b.progressMax))
                : -1;
        }

        style(b, napp.optJSONObject("style"));

        return new NappHints(b);
    }

    private static void style(Builder b, @Nullable JSONObject style) {
        if (style == null) return;

        switch (style.optString("type", "")) {
            case "message": {
                JSONArray messages = style.optJSONArray("messages");
                if (messages == null) return;

                for (int i = 0; i < messages.length() && b.messages.size() < MAX_LINES; i++) {
                    JSONObject entry = messages.optJSONObject(i);
                    if (entry == null) continue;

                    String text = text(entry.optString("text", null), MAX_TEXT);
                    if (text == null) continue;

                    b.messages.add(new Message(
                        text,
                        Math.max(0, entry.optLong("timestamp", 0)),
                        person(entry.optJSONObject("from"))
                    ));
                }

                if (b.messages.isEmpty()) return;

                b.style = STYLE_MESSAGE;
                b.conversation = text(style.optString("conversation", null), MAX_TITLE);
                b.groupConversation = style.optBoolean("group", b.conversation != null);
                b.me = person(style.optJSONObject("me"));
                return;
            }
            case "inbox": {
                JSONArray lines = style.optJSONArray("lines");
                if (lines == null) return;

                for (int i = 0; i < lines.length() && b.lines.size() < MAX_LINES; i++) {
                    String line = text(lines.optString(i, null), MAX_TEXT);
                    if (line != null) b.lines.add(line);
                }

                if (!b.lines.isEmpty()) b.style = STYLE_INBOX;
                return;
            }
            case "picture": {
                String image = image(style.optString("image", null));
                if (image == null) return;

                b.style = STYLE_PICTURE;
                b.image = image;
                b.summary = text(style.optString("summary", null), MAX_TEXT);
                return;
            }
            default:
                // "text", or a style from a later version of this document.
                // Either way the notification is still a title and a body.
        }
    }

    private static void actions(Builder b, @Nullable JSONArray actions) {
        if (actions == null) return;

        for (int i = 0; i < actions.length() && b.actions.size() < MAX_ACTIONS; i++) {
            JSONObject entry = actions.optJSONObject(i);
            if (entry == null) continue;

            String action = text(entry.optString("action", null), MAX_ID);
            String title = text(entry.optString("title", null), MAX_NAME);
            if (action == null || title == null) continue;

            boolean input = "text".equals(entry.optString("type", "button"));
            b.actions.add(new Action(
                action,
                title,
                input,
                input ? text(entry.optString("placeholder", null), MAX_NAME) : null
            ));
        }
    }

    @Nullable
    private static Person person(@Nullable JSONObject json) {
        if (json == null) return null;

        String name = text(json.optString("name", null), MAX_NAME);
        if (name == null) return null;

        return new Person(
            text(json.optString("id", null), MAX_ID),
            name,
            image(json.optString("icon", null))
        );
    }

    @Nullable
    private static Channel channel(@Nullable JSONObject json) {
        if (json == null) return null;

        String id = text(json.optString("id", null), MAX_ID);
        String name = text(json.optString("name", null), MAX_NAME);
        if (id == null || name == null) return null;

        // Only the id has to survive being a channel id, which is opaque to
        // the user but is compared against every other channel the app has.
        String safe = id.replaceAll("[^A-Za-z0-9._-]", "_");
        return new Channel(safe, name, importance(json.optString("importance", "default")));
    }

    private static int importance(@Nullable String importance) {
        if (importance == null) return android.app.NotificationManager.IMPORTANCE_DEFAULT;
        switch (importance) {
            case "min": return android.app.NotificationManager.IMPORTANCE_MIN;
            case "low": return android.app.NotificationManager.IMPORTANCE_LOW;
            case "high": return android.app.NotificationManager.IMPORTANCE_HIGH;
            default: return android.app.NotificationManager.IMPORTANCE_DEFAULT;
        }
    }

    // -----------------------------------------------------------------------
    // The lines a notification carries, to and from storage
    // -----------------------------------------------------------------------

    /**
     * This payload's lines, in the shape they are stored and merged in.
     *
     * Messages as objects and inbox rows as strings — already cleaned, so what
     * comes back out of the store needs no second pass over a site's strings.
     * Empty for a style that has no lines, which is most of them.
     */
    @NonNull
    static JSONArray linesOf(@NonNull NappHints hints) {
        JSONArray out = new JSONArray();

        if (hints.style == STYLE_MESSAGE) {
            for (Message message : hints.messages) {
                JSONObject json = new JSONObject();
                try {
                    json.put("text", message.text);
                    if (message.timestamp > 0) json.put("timestamp", message.timestamp);
                    if (message.from != null) {
                        JSONObject from = new JSONObject();
                        from.put("name", message.from.name);
                        if (message.from.id != null) from.put("id", message.from.id);
                        if (message.from.icon != null) from.put("icon", message.from.icon);
                        json.put("from", from);
                    }
                } catch (JSONException e) {
                    continue;
                }
                out.put(json);
            }
            return out;
        }

        if (hints.style == STYLE_INBOX) {
            for (String line : hints.lines) out.put(line);
        }

        return out;
    }

    /** The stored lines read back as messages, skipping anything unreadable. */
    @NonNull
    static List<Message> messagesOf(@NonNull JSONArray lines) {
        List<Message> messages = new ArrayList<>(lines.length());

        for (int i = 0; i < lines.length(); i++) {
            JSONObject json = lines.optJSONObject(i);
            if (json == null) continue;

            String text = json.optString("text", null);
            if (text == null || text.isEmpty()) continue;

            messages.add(new Message(
                text,
                Math.max(0, json.optLong("timestamp", 0)),
                person(json.optJSONObject("from"))
            ));
        }

        return messages;
    }

    /** The standard {@code icon} option, kept only if it is a shape we resolve. */
    @Nullable
    static String imageOf(@Nullable String value) {
        return image(value);
    }

    // -----------------------------------------------------------------------

    /**
     * A string as a notification may show it: trimmed, clamped, and with the
     * control characters taken out.
     *
     * Newlines included. A body may have them — Android wraps on them and that
     * is often the point — but a title, a name or a channel label may not, and
     * this is the only string cleaner there is, so it takes the strict rule
     * and the body is put back together from the lines it was given.
     */
    @Nullable
    private static String text(@Nullable String value, int max) {
        if (value == null) return null;

        StringBuilder out = new StringBuilder(Math.min(value.length(), max));
        for (int i = 0; i < value.length() && out.length() < max; i++) {
            char c = value.charAt(i);
            // Everything below the space, plus the delete and the directional
            // overrides that would let a name read backwards.
            if (c < ' ' || c == 0x7f || (c >= 0x202a && c <= 0x202e)) {
                out.append(' ');
            } else {
                out.append(c);
            }
        }

        String cleaned = out.toString().trim();
        return cleaned.isEmpty() ? null : cleaned;
    }

    /** A site-absolute path, or null for anything that is not one. */
    @Nullable
    static String path(@Nullable String value) {
        if (value == null || value.isEmpty()) return null;
        // No scheme, no authority, no room for one: a site names a place
        // inside itself, and "//elsewhere.example" is not one.
        if (!value.startsWith("/") || value.startsWith("//")) return null;
        if (value.length() > 1024) return null;

        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= ' ' || c == 0x7f) return null;
        }

        return value;
    }

    /**
     * An image reference, kept only if it is one of the three shapes
     * {@link NappImages} knows how to resolve.
     *
     * The length cap is what makes a {@code data:} URL usable but small: the
     * whole payload rides in a URL, so a site inlining artwork is spending a
     * budget it also needs for words.
     */
    @Nullable
    private static String image(@Nullable String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_IMAGE) return null;
        if (value.startsWith("/") && !value.startsWith("//")) return value;
        if (value.startsWith("https://")) return value;
        if (value.startsWith("data:image/")) return value;
        return null;
    }
}
