package pub.soapbox.tenna;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.BridgeActivity;

/**
 * One nsite, in a window of its own.
 *
 * A site has to behave like the app it appears to be: opening it must not drop
 * the user into Tenna's channel wall, and two open sites must be able to sit
 * side by side in the recents switcher rather than taking turns in one card.
 * {@code documentLaunchMode="intoExisting"} gives exactly that — the system
 * keys a task on this activity's component and the intent's data URI, so a
 * distinct URI per site means a task per site.
 *
 * Both ways in lead here and to the same window: a shortcut on the home screen
 * fires this intent, and so does a tile on the channel wall. Which one it was
 * is remembered ({@link #EXTRA_FROM_WALL}) only because it decides what
 * leaving looks like — a site opened from the wall collapses back to it, and
 * one opened from the launcher just closes, because the shutoff would be
 * playing over the launcher's own animation.
 *
 * It is a {@link BridgeActivity} rather than a bare WebView host on purpose.
 * Everything a site can ask of Tenna beyond its own files — {@code
 * window.nostr}, the permission prompts behind it, the tune-in — is React's,
 * and a site that could not sign anything would be a worse site for having its
 * own window. So the whole web app boots here too; it just skips the router
 * and goes straight to the site (see {@code useNsiteLaunch}).
 *
 * The activity must be exported for the launcher to start it, which means any
 * app on the device can too. That grants nothing beyond opening a window: the
 * site id in the intent is only ever looked up in {@link NsiteSites}, so the
 * most a caller can do is open a site the user has already opened or pinned,
 * with everything the site then asks for still behind the same prompts.
 */
public class NsiteAppActivity extends BridgeActivity {

    /** The nsite subdomain this task is for. */
    static final String EXTRA_SITE_ID = "pub.soapbox.tenna.SITE_ID";

    /** Channel number the site sits on, for the tune-in. Absent for a shortcut. */
    static final String EXTRA_CHANNEL = "pub.soapbox.tenna.CHANNEL";

    /** Whether the channel wall is what's behind this window. */
    static final String EXTRA_FROM_WALL = "pub.soapbox.tenna.FROM_WALL";

    /** Scheme for the per-site data URI that separates one task from another. */
    private static final String TASK_SCHEME = "tenna-nsite";

    /** Recents card tint, matching the app's own background. */
    private static final int TASK_COLOR = 0xFF150609;

    /** The intent a pinned shortcut fires. */
    static Intent intentFor(@NonNull Context context, @NonNull String siteId) {
        return intentFor(context, siteId, 0, false);
    }

    /** The intent for a site, opened from wherever it was opened from. */
    static Intent intentFor(
        @NonNull Context context,
        @NonNull String siteId,
        int channel,
        boolean fromWall
    ) {
        Intent intent = new Intent(context, NsiteAppActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        // Opaque, and derived from a hash, so nothing a manifest event says
        // ends up in a URI. Its only job is to be different per site — and to
        // be the same one for a site however it was opened, so that the wall
        // and the home screen reach the same window rather than two.
        intent.setData(Uri.fromParts(TASK_SCHEME, NsiteSites.key(siteId), null));
        intent.putExtra(EXTRA_SITE_ID, siteId);
        if (channel > 0) intent.putExtra(EXTRA_CHANNEL, channel);
        if (fromWall) intent.putExtra(EXTRA_FROM_WALL, true);
        // NEW_DOCUMENT is what the manifest's documentLaunchMode already says;
        // stating it here too keeps the shortcut correct if that ever moves.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NEW_DOCUMENT);
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must precede super.onCreate: BridgeActivity builds the bridge at the
        // end of it, and only plugins registered by then are reachable.
        registerPlugin(NsiteWebViewPlugin.class);
        registerPlugin(NsiteShortcutsPlugin.class);
        registerPlugin(NappPushPlugin.class);
        super.onCreate(savedInstanceState);

        silenceTransitions();
        describeTask();
        // See MainActivity: whichever window comes up first brings it back.
        NappPushService.sync(this);
    }

    /**
     * Open and close with no animation of the system's own.
     *
     * The tune-in and the shutoff are React's, and they are already whole: both
     * play against the viewer's own opaque backdrop rather than against the
     * wall, so they cross a task boundary unchanged. A window animation on top
     * would be a second one fighting the first.
     *
     * Only for a window opened from the wall. A pinned site never plays the
     * shutoff, so the system's close animation is all it has, and taking that
     * away would leave it vanishing on the spot.
     */
    private void silenceTransitions() {
        if (getIntent() == null || !getIntent().getBooleanExtra(EXTRA_FROM_WALL, false)) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0);
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0);
        }
        // Below 34 the close is silenced from `NsiteShortcutsPlugin.finish`,
        // where `overridePendingTransition` still has a finish to attach to.
    }

    /**
     * A relaunch of a task that already exists.
     *
     * {@code intoExisting} routes a shortcut here rather than starting a second
     * task, and the URI it matched on is the one this task was created for — so
     * it is always the same site, already loaded. Replacing the intent keeps
     * {@code getIntent()} honest; nothing else needs to happen.
     *
     * The channel wall doesn't come through here at all: it looks for the
     * task itself and brings it forward, which resumes the window rather than
     * routing an intent into it. See {@code NsiteShortcutsPlugin.open}.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    /**
     * Put the site's own name and icon on the recents card.
     *
     * Without this a site is indistinguishable from Tenna the moment it leaves
     * the screen, which undoes most of what the separate task was for. The
     * label is known immediately; the icon is whatever was drawn when the site
     * was opened or pinned.
     */
    private void describeTask() {
        String siteId = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_SITE_ID);
        if (siteId == null) return;

        NsiteSites.Record record = NsiteSites.load(this, siteId);
        if (record == null) return;

        Bitmap icon = NsiteSites.taskIcon(this, siteId);
        setTaskDescription(taskDescription(record.label, icon));
    }

    @SuppressWarnings("deprecation")
    private ActivityManager.TaskDescription taskDescription(
        @NonNull String label,
        @Nullable Bitmap icon
    ) {
        // The Builder form arrives in API 33 and this module's floor is 24, so
        // the three-argument constructor is the one that reaches every device
        // the app runs on. It is deprecated, not withdrawn. The colour has to
        // be fully opaque or it is rejected.
        return new ActivityManager.TaskDescription(label, icon, TASK_COLOR);
    }
}
