package pub.soapbox.tenna;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Where the OS share sheet hands Tenna something.
 *
 * It arrives one of two ways. A pinned nsite that declared a
 * {@code share_target} appears in the sheet under its own name and icon, as a
 * sharing shortcut; picking it sends the share here with the shortcut's id
 * attached, and the site is already decided. Picking Tenna itself sends the
 * same share here with no id, and the choice is put to the user inside the app
 * instead — the sheet's own ranking decides whether the per-site entries
 * surface at all, so there has to be a way in that does not depend on it.
 *
 * Either way this activity draws nothing. It stages the payload while the URI
 * grants it was started with are still alive, and hands the token on. The
 * grants belong to this activity and die with it, which is exactly why the
 * copy cannot wait for the user to pick a site.
 */
public class NsiteShareActivity extends Activity {

    /** Names the staged share. Not the share itself — see {@link NsiteShares}. */
    static final String EXTRA_SHARE_TOKEN = "pub.soapbox.tenna.SHARE_TOKEN";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final Intent intent = getIntent();
        if (intent == null) {
            finish();
            return;
        }

        // Off the main thread, because a shared video is hundreds of megabytes
        // and copying one on it would be an ANR rather than a share. The
        // activity stays alive for the duration all the same: the URI grants it
        // was started with are revoked the moment it finishes, so the copy has
        // to happen while it is still here to hold them.
        new Thread(() -> {
            final String token = NsiteShares.stage(this, intent);
            runOnUiThread(() -> hand(intent, token));
        }, "nsite-share").start();
    }

    /** Pass the staged share on, and get out of the way. */
    private void hand(@NonNull Intent intent, @Nullable String token) {
        if (isFinishing() || isDestroyed()) {
            // Backed out from under us. Nobody is coming for these bytes.
            NsiteShares.release(this, token);
            return;
        }

        if (token == null) {
            // Nothing readable in it. Better to vanish than to open a window
            // onto an empty share.
            finish();
            return;
        }

        String siteId = siteFor(this, intent);

        if (siteId != null) {
            startActivity(NsiteAppActivity.shareIntentFor(this, siteId, token));
        } else {
            startActivity(pickerIntentFor(this, token));
        }

        finish();
    }

    /**
     * The site a shortcut id names, if it names one that still has a record.
     *
     * The id is a hash, and the record it names is looked up rather than
     * parsed, so an id from anywhere at all can only ever select a site the
     * user has already put on their home screen — or select nothing.
     */
    @Nullable
    private static String siteFor(@NonNull Context context, @NonNull Intent intent) {
        String shortcut = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        if (TextUtils.isEmpty(shortcut)) return null;

        for (NsiteSites.Record record : NsiteSites.list(context)) {
            if (record.shareTarget == null) continue;
            if (NsiteSites.key(record.siteId).equals(shortcut)) return record.siteId;
        }

        return null;
    }

    /** Bring Tenna up on the share, for the user to place it. */
    private static Intent pickerIntentFor(@NonNull Context context, @NonNull String token) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.putExtra(EXTRA_SHARE_TOKEN, token);
        // MainActivity is singleTask, so this reaches onNewIntent when Tenna is
        // already up and starts it when it is not. Either way the wall is what
        // the picker is drawn over.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }
}
