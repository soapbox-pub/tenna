package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A site's {@code showNotification(title, options)} arguments, read and
 * cleaned.
 *
 * Only what the Notifications API defines. Tenna once accepted an
 * {@code options.data.napp} member carrying conversations, bundles, progress
 * bars and channels of the site's own, and that was a mistake to reach for
 * before the ordinary thing worked: a site had to be written for Tenna to get
 * anything better than three options honoured, when what it should get for
 * being written for the web is everything the web says. So the extension is
 * gone and this reads the standard spelling of each thing instead — including
 * {@code badge}, {@code image} and each action's {@code icon}, which are the
 * ones a browser on Android already honours and Tenna previously threw away.
 *
 * Two things here are not on the standard's own page, and both are kept
 * deliberately. {@code data.url} is what every push service worker on Nostr
 * already writes, and it is the only thing that can route a tap when the
 * worker that would have routed it is not running. An action's
 * {@code type: "text"} with a {@code placeholder} is Chromium's addition
 * rather than the specification's, and it is the only way a reply is answered
 * from the shade.
 *
 * Everything is untrusted. Every string is clamped and stripped of the control
 * characters that would let one line pretend to be two. Nothing is refused
 * outright: an option that makes no sense is dropped and the notification is
 * still shown, because a site whose users silently stop hearing from it is the
 * worse failure.
 */
final class NappOptions {

    /** Buttons. Android draws three and ignores the rest. */
    static final int MAX_ACTIONS = 3;

    private static final int MAX_BODY = 2048;
    private static final int MAX_TITLE = 160;
    private static final int MAX_NAME = 64;
    private static final int MAX_ID = 128;
    private static final int MAX_IMAGE = 4096;

    /** Pairs of on/off milliseconds. Longer than this is not a pattern. */
    private static final int MAX_VIBRATE = 32;

    // -----------------------------------------------------------------------

    /**
     * A button, and whether pressing it opens a reply box first.
     *
     * {@code action} and {@code title} are the standard's; so is {@code icon},
     * which is drawn as a stencil the way the small icon is. {@code input} is
     * Chromium's {@code type: "text"}, and what the user types comes back as
     * {@code event.reply}.
     */
    static final class Action {
        @NonNull final String action;
        @NonNull final String title;
        @Nullable final String icon;
        final boolean input;
        @Nullable final String placeholder;

        Action(
            @NonNull String action,
            @NonNull String title,
            @Nullable String icon,
            boolean input,
            @Nullable String placeholder
        ) {
            this.action = action;
            this.title = title;
            this.icon = icon;
            this.input = input;
            this.placeholder = placeholder;
        }
    }

    // -----------------------------------------------------------------------

    /** The line under the title. May have newlines; Android wraps on them. */
    @NonNull final String body;

    /** The site's own name for this notification, opaque and unaltered. */
    @NonNull final String tag;

    /** The picture beside it. */
    @Nullable final String icon;

    /**
     * The stencil for the status bar.
     *
     * The standard says this is what represents the notification "when there
     * is not enough space to display the notification itself, such as a
     * device's notification bar", which is Android's small icon exactly. See
     * {@link NappBadges}.
     */
    @Nullable final String badge;

    /** The photograph it expands into. */
    @Nullable final String image;

    @NonNull final List<Action> actions;

    final boolean silent;
    final boolean renotify;

    /** Milliseconds. Zero means "when it was posted". */
    final long timestamp;

    /** On/off pattern, or null. Honoured below Android 8; above, it is the channel's. */
    @Nullable final long[] vibrate;

    /**
     * Where a tap goes, as a site-absolute path.
     *
     * From {@code data.url}. Not part of the standard, but honoured because a
     * tap has to land at once and the worker may be dead; a site that would
     * rather route in {@code notificationclick} still gets its say afterwards.
     */
    @Nullable final String url;

    private NappOptions(Builder b) {
        this.body = b.body;
        this.tag = b.tag;
        this.icon = b.icon;
        this.badge = b.badge;
        this.image = b.image;
        this.actions = b.actions;
        this.silent = b.silent;
        this.renotify = b.renotify;
        this.timestamp = b.timestamp;
        this.vibrate = b.vibrate;
        this.url = b.url;
    }

    private static final class Builder {
        String body = "";
        String tag = "";
        @Nullable String icon;
        @Nullable String badge;
        @Nullable String image;
        List<Action> actions = new ArrayList<>();
        boolean silent;
        boolean renotify;
        long timestamp;
        @Nullable long[] vibrate;
        @Nullable String url;
    }

    // -----------------------------------------------------------------------

    /**
     * Read a notification's options.
     *
     * Never null. A payload with nothing in it is a notification with a title
     * and no more, which is a perfectly good notification.
     *
     * {@code dir}, {@code lang} and {@code requireInteraction} are not read.
     * The first two have no Android counterpart at all, and the third is
     * ignored by Chrome on Android too — the closest Android has is a
     * notification that cannot be dismissed, which is not a power to hand a
     * site for saying one word.
     */
    @NonNull
    static NappOptions parse(@Nullable JSONObject options) {
        Builder b = new Builder();
        if (options == null) return new NappOptions(b);

        String body = body(options.optString("body", null));
        if (body != null) b.body = body;

        // Left exactly as the site wrote it: a tag is matched against what the
        // site passes next time and handed back through getNotifications(),
        // so it is an identifier rather than anything anybody reads.
        if (options.has("tag") && !options.isNull("tag")) {
            b.tag = options.optString("tag", "");
        }

        b.icon = image(options.optString("icon", null));
        b.badge = image(options.optString("badge", null));
        b.image = image(options.optString("image", null));

        b.silent = options.optBoolean("silent", false);
        b.renotify = options.optBoolean("renotify", false);
        b.timestamp = Math.max(0, options.optLong("timestamp", 0));
        b.vibrate = vibrate(options.opt("vibrate"));

        actions(b, options.optJSONArray("actions"));

        JSONObject data = options.optJSONObject("data");
        if (data != null) b.url = path(data.optString("url", null));

        return new NappOptions(b);
    }

    /** The title, cleaned. Falls back to the site's own name where it is empty. */
    @NonNull
    static String title(@Nullable String value, @NonNull String fallback) {
        String cleaned = text(value, MAX_TITLE);
        return cleaned == null ? fallback : cleaned;
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
                image(entry.optString("icon", null)),
                input,
                input ? text(entry.optString("placeholder", null), MAX_NAME) : null
            ));
        }
    }

    /** A vibration pattern: the standard allows one number or a list of them. */
    @Nullable
    private static long[] vibrate(@Nullable Object value) {
        if (value == null || value == JSONObject.NULL) return null;

        JSONArray array;
        if (value instanceof JSONArray) {
            array = (JSONArray) value;
        } else if (value instanceof Number) {
            array = new JSONArray();
            array.put(value);
        } else {
            return null;
        }

        int length = Math.min(array.length(), MAX_VIBRATE);
        if (length == 0) return null;

        // Android's pattern starts with a delay before the first buzz; the
        // web's starts with the buzz itself.
        long[] pattern = new long[length + 1];
        for (int i = 0; i < length; i++) {
            pattern[i + 1] = Math.max(0, Math.min(array.optLong(i, 0), 10_000));
        }
        return pattern;
    }

    // -----------------------------------------------------------------------

    /**
     * A string as a notification may show it: trimmed, clamped, and with the
     * control characters taken out.
     *
     * Newlines included, because a title, a name or a button's label may not
     * have them and pretending otherwise is how one line becomes two. The body
     * is the exception and has {@link #body} to itself.
     */
    @Nullable
    private static String text(@Nullable String value, int max) {
        return clean(value, max, false);
    }

    /** The body, which may wrap: newlines survive, everything else does not. */
    @Nullable
    private static String body(@Nullable String value) {
        return clean(value, MAX_BODY, true);
    }

    @Nullable
    private static String clean(@Nullable String value, int max, boolean newlines) {
        if (value == null) return null;

        StringBuilder out = new StringBuilder(Math.min(value.length(), max));
        for (int i = 0; i < value.length() && out.length() < max; i++) {
            char c = value.charAt(i);
            if (newlines && c == '\n') {
                out.append(c);
                continue;
            }
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
    static String image(@Nullable String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_IMAGE) return null;
        if (value.startsWith("/") && !value.startsWith("//")) return value;
        if (value.startsWith("https://")) return value;
        if (value.startsWith("data:image/")) return value;
        return null;
    }
}
