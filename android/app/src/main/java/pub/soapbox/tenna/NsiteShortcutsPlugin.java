package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

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
 * Puts an nsite on the launcher, and tells the web layer when it was launched
 * from there.
 *
 * Kept apart from {@link NsiteWebViewPlugin}, which hosts a site's WebView;
 * this one talks to the launcher and the filesystem and never touches a view.
 * Both are registered in both activities — Tenna's home screen is where a site
 * gets pinned, and a pinned site needs to ask what it was opened for.
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
            NsitePinnedSites.save(context, siteId, label, event, bitmap);
        } catch (IOException e) {
            call.reject("Could not save the site for offline launch", e);
            return;
        }

        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(
            context,
            NsitePinnedSites.key(siteId)
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

        String key = NsitePinnedSites.key(siteId);
        boolean pinned = false;

        try {
            List<ShortcutInfoCompat> shortcuts = ShortcutManagerCompat.getShortcuts(
                getContext(),
                ShortcutManagerCompat.FLAG_MATCH_PINNED
            );
            for (ShortcutInfoCompat shortcut : shortcuts) {
                if (key.equals(shortcut.getId())) {
                    pinned = true;
                    break;
                }
            }
        } catch (RuntimeException e) {
            // Some launchers refuse to enumerate. Not knowing costs nothing
            // worse than offering to pin something that is already pinned.
            pinned = false;
        }

        JSObject result = new JSObject();
        result.put("pinned", pinned);
        call.resolve(result);
    }

    /**
     * The site this activity was launched for, if it was launched from a
     * shortcut rather than from the launcher icon.
     *
     * The manifest comes back with it so the site can start from disk on a
     * cold press, with no relay dialled and nothing fetched.
     */
    @PluginMethod
    public void getLaunchSite(PluginCall call) {
        JSObject result = new JSObject();

        String siteId = getActivity().getIntent() == null
            ? null
            : getActivity().getIntent().getStringExtra(NsiteAppActivity.EXTRA_SITE_ID);

        if (siteId == null) {
            call.resolve(result);
            return;
        }

        result.put("siteId", siteId);

        NsitePinnedSites.Record record = NsitePinnedSites.load(getContext(), siteId);
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
     * Store a newer manifest for a site, if it is pinned.
     *
     * A shortcut outlives the manifest it was made from — the site publishes
     * again and the record on disk still names the old blobs. The web layer
     * re-queries the relay while the site is open and hands the result back
     * here, so the next cold press starts from what the site is now rather
     * than from what it was the day it was pinned.
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
            result.put("updated", NsitePinnedSites.refresh(getContext(), siteId, label, event));
        } catch (IOException e) {
            call.reject("Could not update the pinned site", e);
            return;
        }
        call.resolve(result);
    }

    /**
     * Leave a pinned site.
     *
     * {@code finishAndRemoveTask} rather than {@code finish}: the task is the
     * site, so a back gesture off its first page should take the recents card
     * with it the way closing an app does, not leave an empty one behind.
     */
    @PluginMethod
    public void finish(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().finishAndRemoveTask());
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
