package pub.soapbox.tenna;

import android.app.ActivityManager;
import android.app.ActivityOptions;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.List;

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
        final int channel = call.getInt("channel", 0);

        if (siteId == null || label == null || label.isEmpty() || event == null) {
            call.reject("siteId, label and event are required");
            return;
        }

        Context context = getContext();

        try {
            NsiteSites.save(context, siteId, label, event, decode(icon));
        } catch (IOException e) {
            call.reject("Could not save the site for launch", e);
            return;
        }

        final String site = siteId;
        getActivity().runOnUiThread(() -> {
            // Resuming the task keeps the site exactly as it was left, which
            // routing another intent into it would not: `intoExisting` clears
            // the task it matches, and a cleared task is a site reloaded.
            if (!resumeWindow(site)) {
                getActivity().startActivity(
                    NsiteAppActivity.intentFor(context, site, channel, true),
                    // The tune-in is the animation. See `silenceTransitions`.
                    ActivityOptions.makeCustomAnimation(context, 0, 0).toBundle()
                );
            }
            call.resolve();
        });
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
            NsiteSites.save(context, siteId, label, event, bitmap);
        } catch (IOException e) {
            call.reject("Could not save the site for offline launch", e);
            return;
        }

        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(
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
            .setIntent(NsiteAppActivity.intentFor(context, siteId))
            .build();

        JSObject result = new JSObject();
        result.put("requested", ShortcutManagerCompat.requestPinShortcut(context, shortcut, null));
        call.resolve(result);
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

        NsiteSites.Record record = NsiteSites.load(getContext(), siteId);
        if (record != null) {
            // JSON text, for the same reason the signer's params are: a
            // manifest's `path` tags are an arbitrarily shaped array, and
            // Capacitor's object coercion does not survive the round trip.
            result.put("event", record.event);
            result.put("label", record.label);
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
     * The record goes with it, unless the site is on the home screen. A window
     * opened from the wall is resumed from its record for as long as it exists,
     * and once it doesn't the wall is how the site gets opened again — but a
     * pinned shortcut has no wall behind it and must keep its manifest, so a
     * launcher that won't say whether a site is pinned is taken at its worst.
     */
    @PluginMethod
    public void finish(PluginCall call) {
        Intent intent = getActivity().getIntent();
        String siteId = intent == null
            ? null
            : intent.getStringExtra(NsiteAppActivity.EXTRA_SITE_ID);
        final boolean fromWall =
            intent != null && intent.getBooleanExtra(NsiteAppActivity.EXTRA_FROM_WALL, false);

        if (siteId != null && Boolean.FALSE.equals(isPinned(siteId))) {
            NsiteSites.forget(getContext(), siteId);
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

    // -----------------------------------------------------------------------

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
