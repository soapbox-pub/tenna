package pub.soapbox.tenna;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

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

    private static final String TAG = "NsiteAppActivity";

    /** The nsite subdomain this task is for. */
    static final String EXTRA_SITE_ID = "pub.soapbox.tenna.SITE_ID";

    /** Channel number the site sits on, for the tune-in. Absent for a shortcut. */
    static final String EXTRA_CHANNEL = "pub.soapbox.tenna.CHANNEL";

    /** Whether the channel wall is what's behind this window. */
    static final String EXTRA_FROM_WALL = "pub.soapbox.tenna.FROM_WALL";

    /** A share staged for this site, if the window was opened to receive one. */
    static final String EXTRA_SHARE_TOKEN = NsiteShareActivity.EXTRA_SHARE_TOKEN;

    /** A site-absolute path to open the site at, instead of its front page. */
    static final String EXTRA_PATH = "pub.soapbox.tenna.PATH";

    /** The notification this window was opened from, for the worker's event. */
    static final String EXTRA_NOTIFICATION = "pub.soapbox.tenna.NOTIFICATION";

    /**
     * Proof that {@link #EXTRA_NOTIFICATION} was put there by this app.
     *
     * This activity is exported, because a pinned shortcut is started by the
     * launcher. Everything else it accepts only decides which of the user's
     * own sites opens and where; this one raises an event inside that site's
     * worker and opens the window in which the worker may then open more. See
     * {@link NappTokens#intentNonce}.
     */
    static final String EXTRA_NONCE = "pub.soapbox.tenna.NONCE";

    /** Scheme for the per-site data URI that separates one task from another. */
    private static final String TASK_SCHEME = "tenna-nsite";

    /** Recents card tint for a site with no icon, matching Tenna's background. */
    private static final int TASK_COLOR = 0xFF150609;

    /** The intent a pinned shortcut fires. */
    static Intent intentFor(@NonNull Context context, @NonNull String siteId) {
        return intentFor(context, siteId, 0, false);
    }

    /**
     * The intent that opens a site on a share.
     *
     * The same data URI as any other way in, so a site already open is the
     * window the share lands in rather than a second one beside it.
     */
    static Intent shareIntentFor(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String token
    ) {
        Intent intent = intentFor(context, siteId, 0, false);
        intent.putExtra(EXTRA_SHARE_TOKEN, token);
        return intent;
    }

    /**
     * The intent that opens a site at a place inside it, from the wall.
     *
     * What an {@code nsite://<site>/somewhere} link asks for. Like a share and
     * unlike every other way in from the wall, this has to reach the *site*
     * rather than merely reach its window, so it goes in as an intent even
     * when the task is already up — a window resumed without one would come
     * forward on whatever page it was left on, which is not the page the link
     * named.
     *
     * {@code fromWall} because a link arrives at Tenna, so Tenna's task is
     * what is behind the window and the shutoff has somewhere to collapse to.
     */
    static Intent pathIntentFor(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String path
    ) {
        Intent intent = intentFor(context, siteId, 0, true);
        intent.putExtra(EXTRA_PATH, path);
        return intent;
    }

    /**
     * The intent a notification's body fires, and the one a worker's
     * {@code clients.openWindow()} comes back out to.
     *
     * The same window as every other way in, keyed on the same data URI, so a
     * tap lands in the site the user already has open rather than beside it.
     * {@code path} is where inside the site it lands; null is its front page.
     *
     * {@code notification} is the key of the notification that was pressed, or
     * null when nothing was — a worker opening a window of its own accord has
     * no event to raise afterwards.
     */
    static Intent notificationIntentFor(
        @NonNull Context context,
        @NonNull String siteId,
        @Nullable String path,
        @Nullable String notification
    ) {
        Intent intent = intentFor(context, siteId, 0, false);
        if (path != null) intent.putExtra(EXTRA_PATH, path);
        if (notification != null) {
            intent.putExtra(EXTRA_NOTIFICATION, notification);
            intent.putExtra(EXTRA_NONCE, NappTokens.intentNonce(context));
        }
        return intent;
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
        // Here as much as on the wall: this window is where a site does its
        // asking, and a `signEvent` that arrived to find no signer would be
        // the one thing a site's own window could not do.
        registerPlugin(TennaSignerPlugin.class);
        // And the store the answer is written to. A site's grants used to be
        // the web layer's `localStorage`, which every window has; they are
        // native now, so that a worker with no window can read them — and a
        // window without this plugin silently falls back to the old store
        // (see `native()` in `nsitePermissions.ts`). The decision then lives
        // somewhere nothing else looks: not the settings screen, not the
        // site's worker, and not the next launch, which migrates the stray
        // record out of localStorage and leaves the window asking again.
        registerPlugin(SignerAppsPlugin.class);
        super.onCreate(savedInstanceState);

        silenceTransitions();
        describeTask();
        reportUsed();
        // See MainActivity: whichever window comes up first brings it back.
        // Before the notification is announced, and not after: `sync` stops
        // the service outright when no site has subscriptions, and would
        // stop the one the announcement had just started.
        NappPushService.sync(this);
        announceNotification();
    }

    /**
     * Tell the site's worker that its notification was pressed.
     *
     * The window is already on its way — a tap has to land at once, and the
     * worker that would have routed it may not even be running — so this is
     * not what opens it. It is what makes {@code notificationclick} happen at
     * all, so a site that does its routing there, as a site written for a
     * browser does, still gets its say. Its {@code clients.openWindow()} and
     * {@code WindowClient.navigate()} then move the window that just opened
     * rather than making a second one.
     *
     * The extra is consumed, so a rotation or a task the system rebuilt from
     * its base intent doesn't raise the event a second time.
     */
    private void announceNotification() {
        Intent intent = getIntent();
        if (intent == null) return;

        String siteId = intent.getStringExtra(EXTRA_SITE_ID);
        String key = intent.getStringExtra(EXTRA_NOTIFICATION);
        if (siteId == null || key == null) return;

        // Only this app's own PendingIntents say a notification was pressed.
        // Anyone can send this activity an intent; nobody else can put the
        // nonce in it.
        if (!NappTokens.isIntentNonce(this, intent.getStringExtra(EXTRA_NONCE))) {
            Log.i(TAG, "Ignoring a notification event nobody here raised, for " + siteId);
            intent.removeExtra(EXTRA_NOTIFICATION);
            return;
        }

        intent.removeExtra(EXTRA_NOTIFICATION);
        intent.removeExtra(EXTRA_NONCE);
        NappPushService.dispatchNotificationEvent(this, siteId, "notificationclick", key, "", null);
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
     * {@code getIntent()} honest.
     *
     * The channel wall doesn't come through here at all: it looks for the
     * task itself and brings it forward, which resumes the window rather than
     * routing an intent into it. See {@code NsiteShortcutsPlugin.open}.
     *
     * A share does, though, and is the one thing that has to be acted on
     * rather than merely recorded — the site is already up and would otherwise
     * never learn there was anything to open. Whether it arrives here at all is
     * the system's to decide: {@code intoExisting} is documented to match a
     * task by its data URI, and observed to clear it and start over as often as
     * it delivers here. Both are covered, since a cleared task reads the token
     * off its fresh intent on the way up.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        reportUsed();
        announceNotification();
        NsiteShortcutsPlugin.deliver(getBridge(), intent);
    }

    /**
     * Record that this site was opened, whichever way it was.
     *
     * Every cold way into a site comes through here — a tile on the wall, an
     * icon on the home screen, a share — so it is the one place that sees them
     * all. What it is for is the share sheet's ranking; see
     * {@code NsiteShortcutsPlugin.reportUsed}.
     */
    private void reportUsed() {
        String siteId = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_SITE_ID);
        if (siteId != null) NsiteShortcutsPlugin.reportUsed(this, siteId);
    }

    /**
     * Put the site's own name and icon on the recents card.
     *
     * Without this a site is indistinguishable from Tenna the moment it leaves
     * the screen, which undoes most of what the separate task was for. The
     * label is known immediately; the icon is whatever was drawn when the site
     * was opened or pinned.
     *
     * The colour goes with the icon rather than being Tenna's own, because the
     * switcher draws one behind the other — see {@link NsiteSites#taskIcon}.
     *
     * What the label reaches is only the card's accessibility description; the
     * name printed on the card is the launcher reading this activity's
     * {@code android:label} off the manifest, which is the same string for
     * every site and not ours to vary per task.
     */
    private void describeTask() {
        String siteId = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_SITE_ID);
        if (siteId == null) return;

        NsiteSites.Record record = NsiteSites.load(this, siteId);
        if (record == null) return;

        NsiteSites.TaskIcon icon = NsiteSites.taskIcon(this, siteId);
        setTaskDescription(taskDescription(
            record.label,
            icon == null ? null : icon.bitmap,
            icon == null ? TASK_COLOR : icon.color
        ));
    }

    @SuppressWarnings("deprecation")
    private ActivityManager.TaskDescription taskDescription(
        @NonNull String label,
        @Nullable Bitmap icon,
        int color
    ) {
        // The Builder form arrives in API 33 and this module's floor is 24, so
        // the three-argument constructor is the one that reaches every device
        // the app runs on. It is deprecated, not withdrawn. The colour has to
        // be fully opaque or it is rejected.
        return new ActivityManager.TaskDescription(label, icon, color);
    }
}
