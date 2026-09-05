package pub.soapbox.tenna;

import android.app.ActivityManager;
import android.app.ActivityOptions;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Gives an nsite a window of its own, puts one on the launcher, and tells the
 * web layer which site a window was opened for.
 *
 * Kept apart from {@link NsiteWebViewPlugin}, which hosts a site's WebView;
 * this one talks to the launcher, the task list and the filesystem, and never
 * touches a view. Both are registered in both activities — Tenna's home screen
 * is where a site gets opened and pinned, and the window it opens needs to ask
 * what it was opened for.
 *
 * The icon is drawn in React rather than here. The tile on the channel wall is
 * already the site's artwork on the site's own colour, worked out from its
 * HTML by {@code useNsiteApp}, and an icon that didn't match it would announce
 * itself as a shortcut to something rather than as the thing.
 */
@CapacitorPlugin(name = "NsiteShortcuts")
public class NsiteShortcutsPlugin extends Plugin {

    private static final String TAG = "NsiteShortcuts";

    /**
     * The share sheet buckets a site may be put in.
     *
     * One per {@code <share-target>} in {@code res/xml/shortcuts.xml}, and the
     * two lists have to agree: a category the manifest never declares makes a
     * shortcut the sheet can see but will never offer. Mirrored a third time in
     * {@code src/lib/nsiteShareTarget.ts}, which is what decides which of them
     * a given site has earned.
     */
    private static final Set<String> SHARE_CATEGORIES = new HashSet<>(Arrays.asList(
        "pub.soapbox.tenna.category.SHARE_TEXT",
        "pub.soapbox.tenna.category.SHARE_IMAGE",
        "pub.soapbox.tenna.category.SHARE_VIDEO",
        "pub.soapbox.tenna.category.SHARE_AUDIO",
        "pub.soapbox.tenna.category.SHARE_FILE"
    ));

    /**
     * Whether this launcher will take a pinned shortcut.
     *
     * False below API 26, and on launchers that decline — Android has no
     * fallback worth offering, so the web layer hides the action entirely
     * rather than putting up a button that does nothing.
     */
    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", ShortcutManagerCompat.isRequestPinShortcutSupported(getContext()));
        call.resolve(result);
    }

    /**
     * Open a site in a window of its own, or bring the one it has forward.
     *
     * A site is not a page of Tenna's: it gets its own task, its own card in
     * the recents switcher under its own name and icon, and the whole screen.
     * That is the same window a pinned shortcut opens, keyed on the same site
     * id, so a site opened from the wall and then pressed on the home screen
     * lands back in the window it already had rather than a second one.
     *
     * The record is written first because it is what the window reads: the
     * manifest to serve from, and the label and icon for its recents card.
     */
    @PluginMethod
    public void open(PluginCall call) {
        String siteId = call.getString("siteId");
        String label = call.getString("label");
        String event = call.getString("event");
        String icon = call.getString("icon");
        String shareTarget = call.getString("shareTarget");
        final String shareToken = call.getString("shareToken");
        final int channel = call.getInt("channel", 0);

        if (siteId == null || label == null || label.isEmpty() || event == null) {
            call.reject("siteId, label and event are required");
            return;
        }

        Context context = getContext();

        try {
            NsiteSites.save(context, siteId, label, event, decode(icon), shareTarget);
        } catch (IOException e) {
            call.reject("Could not save the site for launch", e);
            return;
        }

        final String site = siteId;
        getActivity().runOnUiThread(() -> {
            // A share is the one thing that must reach the site rather than
            // merely reach its window, so it goes in as an intent even when the
            // task is already up; everything else resumes the task untouched,
            // because `intoExisting` clears the one it matches and a cleared
            // task is a site reloaded out from under whoever was using it.
            if (shareToken != null) {
                getActivity().startActivity(
                    NsiteAppActivity.shareIntentFor(context, site, shareToken),
                    ActivityOptions.makeCustomAnimation(context, 0, 0).toBundle()
                );
                // Handed on, so the wall stops holding it: this activity's
                // intent outlives the picker, and would otherwise put a spent
                // share back on screen the next time it is read.
                Intent held = getActivity().getIntent();
                if (held != null) held.removeExtra(NsiteShareActivity.EXTRA_SHARE_TOKEN);
            } else if (!resumeWindow(site)) {
                getActivity().startActivity(
                    NsiteAppActivity.intentFor(context, site, channel, true),
                    // The tune-in is the animation. See `silenceTransitions`.
                    ActivityOptions.makeCustomAnimation(context, 0, 0).toBundle()
                );
            }
            call.resolve();
        });
    }

    /**
     * Tell the system a site was opened.
     *
     * The share sheet shows only a few of an app's targets at once, and picks
     * which few by rank. Left alone that rank is the order the wall happened
     * to publish sites in — alphabetical, near enough — so without this the
     * sheet offers whichever sites sort first rather than the ones the user
     * actually opens. Harmless for a site with no shortcut to rank.
     */
    static void reportUsed(@NonNull Context context, @NonNull String siteId) {
        try {
            ShortcutManagerCompat.reportShortcutUsed(context, NsiteSites.key(siteId));
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not report a site as used", e);
        }
    }

    /** Bring a site's existing window forward, if it has one. */
    private boolean resumeWindow(@NonNull String siteId) {
        ActivityManager manager =
            (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return false;

        try {
            for (ActivityManager.AppTask task : manager.getAppTasks()) {
                Intent base = task.getTaskInfo().baseIntent;
                if (base == null) continue;
                if (!siteId.equals(base.getStringExtra(NsiteAppActivity.EXTRA_SITE_ID))) continue;
                task.moveToFront();
                // The one way in that never reaches NsiteAppActivity.onCreate.
                reportUsed(getContext(), siteId);
                return true;
            }
        } catch (RuntimeException e) {
            // No task list, or one we're not allowed to move. Opening a second
            // window is a worse outcome than most, but not a failure.
            return false;
        }

        return false;
    }

    /**
     * Ask the launcher to add a site to the home screen.
     *
     * The system puts up its own confirmation on API 26+, so a resolved call
     * means the request was made, not that a shortcut exists. Pinning a site
     * that is already pinned updates it in place: the shortcut id is derived
     * from the site id, not generated.
     */
    @PluginMethod
    public void pin(PluginCall call) {
        String siteId = call.getString("siteId");
        String label = call.getString("label");
        String event = call.getString("event");
        String icon = call.getString("icon");
        String shareTarget = call.getString("shareTarget");

        if (siteId == null || label == null || label.isEmpty() || event == null) {
            call.reject("siteId, label and event are required");
            return;
        }

        Context context = getContext();
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
            call.reject("This launcher does not accept pinned shortcuts");
            return;
        }

        Bitmap bitmap = decode(icon);

        try {
            // Written before the request, not after it: the launcher may pin
            // silently and the user may press the shortcut before any callback
            // would have run, and a site with no record cannot be served.
            NsiteSites.save(context, siteId, label, event, bitmap, shareTarget);
        } catch (IOException e) {
            call.reject("Could not save the site for offline launch", e);
            return;
        }

        // Deliberately not a sharing shortcut yet, whatever the site declared.
        // Pinning is a request the system answers behind its own dialog, and a
        // site the user turned down has no business in their share menu; the
        // web layer calls `setShareTarget` once it has seen the shortcut land.
        ShortcutInfoCompat shortcut = shortcutFor(context, siteId, label, bitmap, null);

        JSObject result = new JSObject();
        result.put("requested", ShortcutManagerCompat.requestPinShortcut(context, shortcut, null));
        call.resolve(result);
    }

    /**
     * The shortcut for a site, as the launcher and the share sheet both see it.
     *
     * One object serves both. Pressing it on the home screen fires the intent
     * built here; picking it out of the share sheet does not — the system
     * replaces the component with whatever the matching {@code <share-target>}
     * names and passes the shortcut's id along instead. So the two uses never
     * disagree about where they go, and a site needs only one shortcut.
     *
     * Categories are what make the difference. A shortcut with none is a
     * launcher icon; one carrying the categories declared in
     * {@code res/xml/shortcuts.xml} is also offered for the MIME types those
     * entries match. Long-lived, because the sheet may hold on to it.
     */
    private static ShortcutInfoCompat shortcutFor(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String label,
        @Nullable Bitmap bitmap,
        @Nullable Set<String> categories
    ) {
        ShortcutInfoCompat.Builder builder = new ShortcutInfoCompat.Builder(
            context,
            NsiteSites.key(siteId)
        )
            .setShortLabel(label)
            .setLongLabel(label)
            // Adaptive, so the launcher masks it to whatever shape the rest of
            // the home screen is and lights it the same way. A plain bitmap
            // would sit on the wallpaper as a square among circles.
            .setIcon(bitmap != null
                ? IconCompat.createWithAdaptiveBitmap(bitmap)
                : IconCompat.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(NsiteAppActivity.intentFor(context, siteId));

        if (categories != null && !categories.isEmpty()) {
            builder.setCategories(categories).setLongLived(true);
        }

        return builder.build();
    }

    /** Whether a site already has a shortcut on the home screen. */
    @PluginMethod
    public void isPinned(PluginCall call) {
        String siteId = call.getString("siteId");
        if (siteId == null) {
            call.reject("siteId is required");
            return;
        }

        JSObject result = new JSObject();
        // Some launchers refuse to enumerate. Not knowing costs nothing worse
        // than offering to pin something that is already pinned.
        result.put("pinned", Boolean.TRUE.equals(isPinned(siteId)));
        call.resolve(result);
    }

    /**
     * Whether a shortcut for this site is on the home screen — or null when the
     * launcher won't say.
     *
     * The difference matters to whoever is about to act on the answer: offering
     * to pin a site twice is a small thing, and throwing away the manifest of a
     * site that is still on the home screen is not.
     */
    @Nullable
    private Boolean isPinned(@NonNull String siteId) {
        String key = NsiteSites.key(siteId);

        try {
            List<ShortcutInfoCompat> shortcuts = ShortcutManagerCompat.getShortcuts(
                getContext(),
                ShortcutManagerCompat.FLAG_MATCH_PINNED
            );
            for (ShortcutInfoCompat shortcut : shortcuts) {
                if (key.equals(shortcut.getId())) return true;
            }
        } catch (RuntimeException e) {
            return null;
        }

        return false;
    }

    /**
     * The site this activity was opened for, if it is a site's window rather
     * than Tenna itself.
     *
     * The manifest comes back with it so the site can start from disk on a cold
     * press, with no relay dialled and nothing fetched. The channel number and
     * where it was opened from come back too: the first is what the tune-in
     * announces, and the second is what decides whether leaving plays the
     * shutoff or simply closes.
     */
    @PluginMethod
    public void getLaunchSite(PluginCall call) {
        JSObject result = new JSObject();

        Intent intent = getActivity().getIntent();
        String siteId = intent == null
            ? null
            : intent.getStringExtra(NsiteAppActivity.EXTRA_SITE_ID);

        if (siteId == null) {
            call.resolve(result);
            return;
        }

        result.put("siteId", siteId);
        result.put("fromWall", intent.getBooleanExtra(NsiteAppActivity.EXTRA_FROM_WALL, false));

        int channel = intent.getIntExtra(NsiteAppActivity.EXTRA_CHANNEL, 0);
        if (channel > 0) result.put("channel", channel);

        String shareToken = intent.getStringExtra(NsiteAppActivity.EXTRA_SHARE_TOKEN);
        if (shareToken != null) result.put("shareToken", shareToken);

        NsiteSites.Record record = NsiteSites.load(getContext(), siteId);
        if (record != null) {
            // JSON text, for the same reason the signer's params are: a
            // manifest's `path` tags are an arbitrarily shaped array, and
            // Capacitor's object coercion does not survive the round trip.
            result.put("event", record.event);
            result.put("label", record.label);
            if (record.shareTarget != null) result.put("shareTarget", record.shareTarget);
        }

        call.resolve(result);
    }

    /**
     * Store a newer manifest for a site, if it still has a record.
     *
     * A record outlives the manifest it was made from — the site publishes
     * again and the record on disk still names the old blobs. The web layer
     * re-queries the relay while the site is open and hands the result back
     * here, so the next cold start serves what the site is now rather than
     * what it was the day its window was made.
     */
    @PluginMethod
    public void refresh(PluginCall call) {
        String siteId = call.getString("siteId");
        String label = call.getString("label");
        String event = call.getString("event");

        if (siteId == null || label == null || label.isEmpty() || event == null) {
            call.reject("siteId, label and event are required");
            return;
        }

        JSObject result = new JSObject();
        try {
            result.put("updated", NsiteSites.refresh(getContext(), siteId, label, event));
        } catch (IOException e) {
            call.reject("Could not update the pinned site", e);
            return;
        }
        call.resolve(result);
    }

    /**
     * Leave a site's window.
     *
     * {@code finishAndRemoveTask} rather than {@code finish}: the task is the
     * site, so a back gesture off its first page should take the recents card
     * with it the way closing an app does, not leave an empty one behind.
     *
     * The record goes with it, unless the site is on the home screen or has
     * asked for notifications. A window opened from the wall is resumed from
     * its record for as long as it exists, and once it doesn't the wall is how
     * the site gets opened again — but a pinned shortcut has no wall behind it
     * and must keep its manifest, so a launcher that won't say whether a site
     * is pinned is taken at its worst.
     */
    @PluginMethod
    public void finish(PluginCall call) {
        Intent intent = getActivity().getIntent();
        String siteId = intent == null
            ? null
            : intent.getStringExtra(NsiteAppActivity.EXTRA_SITE_ID);
        final boolean fromWall =
            intent != null && intent.getBooleanExtra(NsiteAppActivity.EXTRA_FROM_WALL, false);

        // A site with subscriptions keeps its record too: its worker is
        // served from that manifest when an event arrives for it.
        if (siteId != null
            && Boolean.FALSE.equals(isPinned(siteId))
            && !NappSubscriptions.has(getContext(), siteId)) {
            NsiteSites.forget(getContext(), siteId);
            // A site with no record cannot be served, so it must not go on
            // being offered a share it would have nowhere to put.
            ShortcutManagerCompat.removeDynamicShortcuts(
                getContext(),
                Collections.singletonList(NsiteSites.key(siteId))
            );
        }

        getActivity().runOnUiThread(() -> {
            getActivity().finishAndRemoveTask();
            // The shutoff has already played. On 34 and up the same thing is
            // said once, in `silenceTransitions`.
            if (fromWall && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                //noinspection deprecation
                getActivity().overridePendingTransition(0, 0);
            }
        });
        call.resolve();
    }

    // -- The OS share sheet ---------------------------------------------------

    /**
     * Put a site in the share sheet, or take it back out.
     *
     * Being in the sheet means being a *dynamic* shortcut: the sheet only
     * offers what the app currently publishes, and a shortcut that is merely
     * pinned is invisible to it. The same id serves both, so a site has one
     * shortcut with one icon wherever it appears.
     *
     * Withdrawing is safe. Removing a dynamic shortcut leaves a pinned copy on
     * the home screen, still enabled and still pointing at the same site — so
     * the worst this can do is cost a site its place in the share menu.
     *
     * This is also where a site's {@code share_target} is written down. The
     * wall is the only place a web app manifest is ever read, and it reads one
     * long after the site was pinned — a site put on the home screen before
     * Tenna knew about share targets at all has a record with nothing in that
     * field, and the picker reads records rather than the wall.
     */
    @PluginMethod
    public void setShareTarget(PluginCall call) {
        String siteId = call.getString("siteId");
        if (siteId == null) {
            call.reject("siteId is required");
            return;
        }

        Context context = getContext();
        String id = NsiteSites.key(siteId);

        String shareTarget = call.getString("shareTarget");
        if (shareTarget != null) {
            try {
                NsiteSites.setShareTarget(context, siteId, shareTarget);
            } catch (IOException e) {
                Log.w(TAG, "Could not record a share target", e);
            }
        }

        if (!Boolean.TRUE.equals(call.getBoolean("enabled", false))) {
            ShortcutManagerCompat.removeDynamicShortcuts(context, Collections.singletonList(id));
            call.resolve();
            return;
        }

        Set<String> categories = categories(call.getArray("shareCategories", null));
        if (categories.isEmpty()) {
            call.reject("A share target needs at least one category");
            return;
        }

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        String label = call.getString("label", record != null ? record.label : siteId);
        Bitmap bitmap = decode(call.getString("icon"));
        if (bitmap == null) bitmap = NsiteSites.taskIcon(context, siteId);

        try {
            ShortcutManagerCompat.pushDynamicShortcut(
                context,
                shortcutFor(context, siteId, label == null ? siteId : label, bitmap, categories)
            );
        } catch (IllegalArgumentException | IllegalStateException e) {
            // Past the per-app cap, or the launcher is in a mood. The site
            // keeps its home screen icon either way.
            Log.w(TAG, "Could not publish a share target", e);
        }

        call.resolve();
    }

    /**
     * Every pinned site that says it will take a share.
     *
     * For the picker, which is the way in when the sheet's own per-site entries
     * don't surface — their ranking is the system's business, and on a share
     * that Android decides to show as a flat app list they are simply absent.
     */
    @PluginMethod
    public void listShareTargets(PluginCall call) {
        Context context = getContext();
        JSArray sites = new JSArray();

        for (NsiteSites.Record record : NsiteSites.list(context)) {
            if (record.shareTarget == null) continue;
            if (Boolean.FALSE.equals(isPinned(record.siteId))) continue;

            JSObject site = new JSObject();
            site.put("siteId", record.siteId);
            site.put("label", record.label);
            site.put("event", record.event);
            site.put("shareTarget", record.shareTarget);

            String icon = encode(NsiteSites.taskIcon(context, record.siteId));
            if (icon != null) site.put("icon", icon);

            sites.put(site);
        }

        JSObject result = new JSObject();
        result.put("sites", sites);
        call.resolve(result);
    }

    /** A share that came to Tenna itself, waiting for the user to place it. */
    @PluginMethod
    public void getPendingShare(PluginCall call) {
        Intent intent = getActivity().getIntent();
        String token = intent == null
            ? null
            : intent.getStringExtra(NsiteShareActivity.EXTRA_SHARE_TOKEN);

        call.resolve(pending(token));
    }

    /** What was staged under a token. Metadata only — the bytes go to the site. */
    @PluginMethod
    public void getSharePayload(PluginCall call) {
        String token = call.getString("token");
        if (token == null) {
            call.reject("token is required");
            return;
        }

        JSObject payload = payload(token);
        if (payload == null) {
            call.reject("That share is no longer staged");
            return;
        }

        call.resolve(payload);
    }

    /** Throw a staged share away, delivered or not. */
    @PluginMethod
    public void releaseShare(PluginCall call) {
        String token = call.getString("token");
        if (token != null) NsiteShares.release(getContext(), token);
        call.resolve();
    }

    /**
     * Tell the web layer that a share arrived at a window already up.
     *
     * Static, and reached through the bridge, because the caller is an activity
     * rather than the plugin: {@code onNewIntent} is where a share lands when
     * nothing had to restart to receive it.
     */
    static void deliver(@Nullable Bridge bridge, @Nullable Intent intent) {
        if (bridge == null || intent == null) return;
        if (intent.getStringExtra(NsiteShareActivity.EXTRA_SHARE_TOKEN) == null) return;

        PluginHandle handle = bridge.getPlugin("NsiteShortcuts");
        if (handle == null) return;

        Plugin plugin = handle.getInstance();
        if (plugin instanceof NsiteShortcutsPlugin) {
            NsiteShortcutsPlugin shortcuts = (NsiteShortcutsPlugin) plugin;
            shortcuts.notifyListeners(
                "nsiteShare",
                shortcuts.pending(intent.getStringExtra(NsiteShareActivity.EXTRA_SHARE_TOKEN))
            );
        }
    }

    /** A pending share as the web layer wants it: the token, and what's in it. */
    private JSObject pending(@Nullable String token) {
        JSObject result = new JSObject();
        if (token == null) return result;

        JSObject payload = payload(token);
        if (payload == null) return result;

        result.put("token", token);
        result.put("payload", payload);
        return result;
    }

    @Nullable
    private JSObject payload(@NonNull String token) {
        NsiteShares.Payload staged = NsiteShares.load(getContext(), token);
        if (staged == null) return null;

        JSObject payload = new JSObject();
        if (staged.title != null) payload.put("title", staged.title);
        if (staged.text != null) payload.put("text", staged.text);

        JSArray files = new JSArray();
        for (NsiteShares.StagedFile file : staged.files) {
            JSObject json = new JSObject();
            json.put("index", file.index);
            json.put("name", file.name);
            json.put("type", file.type);
            json.put("size", file.size);
            files.put(json);
        }
        payload.put("files", files);

        return payload;
    }

    /** The categories a call named, kept to the ones this app actually declares. */
    private static Set<String> categories(@Nullable JSArray declared) {
        Set<String> categories = new LinkedHashSet<>();
        if (declared == null) return categories;

        try {
            for (Object entry : declared.toList()) {
                if (entry instanceof String && SHARE_CATEGORIES.contains(entry)) {
                    categories.add((String) entry);
                }
            }
        } catch (JSONException e) {
            // A malformed list is an empty one; the caller rejects on that.
        }

        return categories;
    }

    // -----------------------------------------------------------------------

    /** Base64 PNG of a bitmap, without a data URL prefix. */
    @Nullable
    private static String encode(@Nullable Bitmap bitmap) {
        if (bitmap == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    @Nullable
    private static Bitmap decode(@Nullable String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            // An undecodable icon is not a reason to refuse the shortcut; the
            // launcher gets the app icon instead.
            return null;
        }
    }
}
