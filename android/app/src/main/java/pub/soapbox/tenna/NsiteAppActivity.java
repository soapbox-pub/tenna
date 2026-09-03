package pub.soapbox.tenna;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.BridgeActivity;

/**
 * One pinned nsite, in a task of its own.
 *
 * A shortcut on the home screen has to behave like the app it appears to be:
 * pressing it must not drop the user into Tenna's channel wall, and two pinned
 * sites must be able to sit side by side in the recents switcher rather than
 * taking turns in one card. {@code documentLaunchMode="intoExisting"} gives
 * exactly that — the system keys a task on this activity's component and the
 * intent's data URI, so a distinct URI per site means a task per site, and the
 * same URI again resumes the one already there instead of stacking a second.
 *
 * It is a {@link BridgeActivity} rather than a bare WebView host on purpose.
 * Everything a site can ask of Tenna beyond its own files — {@code
 * window.nostr}, the permission prompts behind it, the tune-in — is React's,
 * and a pinned site that could not sign anything would be a worse site than
 * the one on the channel wall. So the whole web app boots here too; it just
 * skips the router and goes straight to the site (see {@code useNsiteLaunch}).
 *
 * The activity must be exported for the launcher to start it, which means any
 * app on the device can too. That grants nothing: the site id in the intent is
 * only ever looked up in {@link NsitePinnedSites}, so the most a caller can do
 * is open a site the user pinned themselves.
 */
public class NsiteAppActivity extends BridgeActivity {

    /** The nsite subdomain this task is for. */
    static final String EXTRA_SITE_ID = "pub.soapbox.tenna.SITE_ID";

    /** Scheme for the per-site data URI that separates one task from another. */
    private static final String TASK_SCHEME = "tenna-nsite";

    /** Recents card tint, matching the app's own background. */
    private static final int TASK_COLOR = 0xFF150609;

    /** The intent a pinned shortcut fires. */
    static Intent intentFor(@NonNull Context context, @NonNull String siteId) {
        Intent intent = new Intent(context, NsiteAppActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        // Opaque, and derived from a hash, so nothing a manifest event says
        // ends up in a URI. Its only job is to be different per site.
        intent.setData(Uri.fromParts(TASK_SCHEME, NsitePinnedSites.key(siteId), null));
        intent.putExtra(EXTRA_SITE_ID, siteId);
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
        super.onCreate(savedInstanceState);

        describeTask();
    }

    /**
     * A relaunch of a task that already exists.
     *
     * {@code intoExisting} routes the shortcut here rather than starting a
     * second task, and the URI it matched on is the one this task was created
     * for — so it is always the same site, already loaded. Replacing the
     * intent keeps {@code getIntent()} honest; nothing else needs to happen.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    /**
     * Put the site's own name and icon on the recents card.
     *
     * Without this a pinned site is indistinguishable from Tenna the moment it
     * leaves the home screen, which undoes most of what the separate task was
     * for. The label is known immediately; the icon is whatever was drawn when
     * the shortcut was made.
     */
    private void describeTask() {
        String siteId = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_SITE_ID);
        if (siteId == null) return;

        NsitePinnedSites.Record record = NsitePinnedSites.load(this, siteId);
        if (record == null) return;

        Bitmap icon = NsitePinnedSites.taskIcon(this, siteId);
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
