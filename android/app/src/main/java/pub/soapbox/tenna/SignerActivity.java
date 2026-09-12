package pub.soapbox.tenna;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;

/**
 * The drawer another application's request appears in.
 *
 * A translucent window that draws nothing of its own, so what is behind it —
 * the app that asked — stays on screen underneath. That is the whole point of
 * the shape: a question about signing as somebody is a question you answer by
 * looking at what is asking, and an opaque screen that replaces the caller
 * takes that away.
 *
 * <p><b>A remembered answer costs no WebView.</b> {@link #settle} runs before
 * anything is loaded, and if the user has already decided this, it sets the
 * result and finishes — {@link #load()} never builds a bridge. The web layer
 * boots only on the path where somebody is going to read something, which is
 * the path where a few hundred milliseconds were going to be spent anyway.
 * Getting this the other way round is what makes background signing feel like
 * a signer app flashing on screen for every request.
 *
 * <p>{@code singleTop}, and deliberately not {@code singleTask}: this activity
 * runs inside the calling app's own task, which is what lets
 * {@code setResult} reach a client that used {@code startActivityForResult} at
 * all, and what makes the sheet appear over the caller rather than over a task
 * of its own. NIP-55 asks for {@code singleTop} by name, so that a client
 * sending several requests with {@code FLAG_ACTIVITY_SINGLE_TOP} gets them
 * delivered to {@link #onNewIntent} and answered one after another without the
 * window closing in between.
 */
public class SignerActivity extends BridgeActivity {

    private static final String TAG = "SignerActivity";

    /** A request the user has not answered yet. */
    static final class Pending {
        @NonNull final SignerRequests.Parsed parsed;
        /** The account that would answer, or null if this device has no key. */
        @Nullable final String accountPubkey;
        /** The calling package, or null for a web page with nothing behind it. */
        @Nullable final String requesterId;
        @NonNull final String appName;
        @NonNull final String appKind;
        /** The caller's launcher icon as a data URI, or null. */
        @Nullable final String icon;

        Pending(
            @NonNull SignerRequests.Parsed parsed,
            @Nullable String accountPubkey,
            @Nullable String requesterId,
            @NonNull String appName,
            @NonNull String appKind,
            @Nullable String icon
        ) {
            this.parsed = parsed;
            this.accountPubkey = accountPubkey;
            this.requesterId = requesterId;
            this.appName = appName;
            this.appKind = appKind;
            this.icon = icon;
        }
    }

    private final Deque<Pending> queue = new ArrayDeque<>();

    /** Whether everything was answered before anything had to be drawn. */
    private boolean silent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Intent intent = getIntent();

        // A tap in Recents re-delivers the intent that made the task. Without
        // this, a request the user answered days ago is asked again — and if
        // they had said remember, answered again, silently.
        if (intent != null && fromHistory(intent)) {
            setIntent(new Intent());
            intent = null;
        }

        silent = intent == null || settle(intent, false);

        if (!silent) registerPlugin(SignerPromptPlugin.class);
        super.onCreate(savedInstanceState);

        if (silent) {
            finish();
            return;
        }

        seeThrough();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        if (intent == null || intent.getData() == null) return;

        // Deliberately not rate limited. A client batching requests into one
        // window is the case that machinery exists to permit, not the one it
        // exists to stop — and the user is already looking at a sheet.
        if (settle(intent, true)) return;

        SignerPromptPlugin.announce(getBridge());
    }

    // ── Deciding before drawing ──────────────────────────────────────────────

    /**
     * Answer an intent if it can be answered without asking, and queue it if
     * it cannot.
     *
     * @return true when nothing is left to put in front of the user.
     */
    private boolean settle(@NonNull Intent intent, boolean additional) {
        SignerRequests.Parsed parsed = SignerRequests.parse(intent);
        if (parsed == null) {
            // Not a request this signer understands. A client waiting on a
            // result gets one rather than a window that closed for no reason.
            setResult(Activity.RESULT_CANCELED);
            return !additional;
        }

        String requesterId = getCallingPackage();

        if (!additional && !SignerRateLimiter.allow(requesterId, bucket(parsed))) {
            Log.i(TAG, "Refused a request that came too fast");
            Toast.makeText(this, "Too many signing requests", Toast.LENGTH_SHORT).show();
            setResult(Activity.RESULT_CANCELED);
            return !additional;
        }

        TennaSigning.Request request = parsed.toRequest();
        String account = TennaSigning.accountFor(this, parsed.currentUser, request);

        if (account != null) {
            TennaSigning.Outcome outcome =
                TennaSigning.answer(this, account, requesterId, request);

            if (outcome.isResult()) {
                deliver(parsed, outcome, requesterId, account);
                return !additional;
            }
            if (outcome.status == TennaSigning.Outcome.Status.REJECTED) {
                refuse(parsed);
                return !additional;
            }
            if (outcome.status == TennaSigning.Outcome.Status.ERROR) {
                Log.i(TAG, "Could not answer a request: " + outcome.error);
                setResult(Activity.RESULT_CANCELED);
                return !additional;
            }
        }

        if (account == null) {
            // Counts only, and worth keeping: the two numbers are the whole
            // difference between "nobody is signed in" and "everybody signed
            // in keeps their key somewhere else", and from the outside those
            // produce exactly the same sheet.
            Log.i(TAG, "Nothing here can answer: "
                + TennaAccounts.all(this).size() + " signed in, "
                + TennaKeys.pubkeys(this).size() + " with a key on this device");
        }

        // Either nobody decided, or there is no key here and the sheet is
        // going to have to say so.
        queue.addLast(describe(parsed, account, requesterId));
        return false;
    }

    /** Separate budgets per kind of question — see {@link SignerRateLimiter}. */
    private static String bucket(SignerRequests.Parsed parsed) {
        Integer kind = parsed.toRequest().eventKind();
        return parsed.method.wire + (kind == null ? "" : ":" + kind);
    }

    /**
     * Everything the sheet needs to draw the caller.
     *
     * <p>The icon and label are read now, while the request is live. Android
     * shows an app only the packages it is currently interacting with, so this
     * is the one moment they can be had — which is also why they are written
     * to disk here, for the settings screen to draw later.
     */
    @NonNull
    private Pending describe(
        @NonNull SignerRequests.Parsed parsed,
        @Nullable String account,
        @Nullable String requesterId
    ) {
        if (requesterId == null || requesterId.isEmpty()) {
            String name = parsed.appName.isEmpty() ? "A web page" : parsed.appName;
            return new Pending(parsed, account, null, name, SignerApps.KIND_WEB, null);
        }

        String label = requesterId;
        String icon = null;

        try {
            PackageManager packages = getPackageManager();
            ApplicationInfo info = packages.getApplicationInfo(requesterId, 0);
            label = packages.getApplicationLabel(info).toString();

            Bitmap bitmap = rasterize(packages.getApplicationIcon(info));
            if (bitmap != null) {
                icon = dataUri(bitmap);
                remember(requesterId, bitmap);
            }
        } catch (Exception e) {
            // An app we cannot see is still an app that asked. It is named by
            // its package, which is the part that matters for telling two
            // apart anyway.
            Log.i(TAG, "Could not read the caller's name or icon");
        }

        return new Pending(parsed, account, requesterId, label, SignerApps.KIND_PACKAGE, icon);
    }

    @Nullable
    private static Bitmap rasterize(@Nullable Drawable drawable) {
        if (drawable == null) return null;

        int size = 192;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, size, size);
        drawable.draw(canvas);
        return bitmap;
    }

    @Nullable
    private static String dataUri(@NonNull Bitmap bitmap) {
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
            return "data:image/png;base64,"
                + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** Keep the icon for the settings screen, which will not be able to ask. */
    private void remember(@NonNull String requesterId, @NonNull Bitmap bitmap) {
        try (FileOutputStream out = new FileOutputStream(SignerApps.iconFile(this, requesterId))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        } catch (Exception e) {
            // The list will draw an initial instead.
            Log.i(TAG, "Could not keep the caller's icon");
        }
    }

    // ── Answering ────────────────────────────────────────────────────────────

    /** The request at the front of the queue, or null. */
    @Nullable
    Pending peek() {
        return queue.peekFirst();
    }

    /**
     * What the user said about the request in front of them.
     *
     * <p>Called from the sheet. Remembering is only offered for a caller the
     * platform named — see {@link TennaSigning#decide}.
     */
    void resolve(@NonNull String id, boolean allowed, boolean remember) {
        Pending pending = queue.peekFirst();
        if (pending == null || !pending.parsed.id.equals(id)) return;
        queue.pollFirst();

        String account = pending.accountPubkey;
        String permission = pending.parsed.method.permission;

        if (account != null && remember && permission != null
                && pending.requesterId != null && !pending.requesterId.isEmpty()) {
            SignerApps.grant(
                this, account, pending.requesterId, pending.appKind, pending.appName,
                permission, pending.parsed.toRequest().eventKind(), allowed
            );
        }

        if (!allowed || account == null) {
            refuse(pending.parsed);
        } else {
            TennaSigning.Outcome outcome =
                TennaSigning.run(this, account, pending.parsed.toRequest());
            if (outcome.isResult()) {
                deliver(pending.parsed, outcome, pending.requesterId, account);
            } else {
                Log.i(TAG, "Could not answer an approved request: " + outcome.error);
                setResult(Activity.RESULT_CANCELED);
            }
        }

        if (queue.isEmpty()) finish();
    }

    /** Hand a result back the way the caller can receive one. */
    private void deliver(
        @NonNull SignerRequests.Parsed parsed,
        @NonNull TennaSigning.Outcome outcome,
        @Nullable String requesterId,
        @NonNull String account
    ) {
        if (requesterId != null && !requesterId.isEmpty()) {
            SignerApps.touch(this, account, requesterId);
        }

        String value = outcome.value == null ? "" : outcome.value;
        setResult(Activity.RESULT_OK,
            SignerRequests.success(parsed, value, outcome.eventJson, getPackageName()));

        // A web page cannot read an activity result, so it gets sent back to
        // itself with the answer on the end of the URL it named.
        Uri callback = SignerRequests.callback(parsed, value, outcome.eventJson);
        if (callback != null) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, callback));
            } catch (Exception e) {
                Log.i(TAG, "Nowhere to send the callback");
            }
        }
    }

    private void refuse(@NonNull SignerRequests.Parsed parsed) {
        setResult(Activity.RESULT_OK, SignerRequests.rejection(parsed));
    }

    /**
     * Every way out that is not a button is a no.
     *
     * <p>Back, the gesture, a tap outside, the system taking the window away.
     * None of them is an approval, and none of them writes anything down: a
     * dismissal that got away from somebody must not leave a decision behind
     * that the caller gets to keep.
     */
    @Override
    public void finish() {
        Pending pending = queue.peekFirst();
        while (pending != null) {
            refuse(pending.parsed);
            queue.pollFirst();
            pending = queue.peekFirst();
        }
        super.finish();
    }

    // ── The window ───────────────────────────────────────────────────────────

    /**
     * Make the window and the WebView draw nothing of their own.
     *
     * <p>Capacitor sets its own theme in {@code onCreate}, so the transparent
     * background from the manifest has to be put back afterwards. The dim
     * behind the sheet is drawn by the sheet itself rather than by the window,
     * which is what gives it the same fade as everywhere else in the app.
     */
    private void seeThrough() {
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        }
    }

    @Override
    protected void load() {
        // The whole background path is this line. Nothing has to be drawn, so
        // no bridge is built and no WebView is loaded.
        if (silent) return;

        announceSheet();
        super.load();
    }

    /**
     * Tell the page it is a sheet, before any of its own scripts run.
     *
     * <p>The window is transparent and the app that asked is behind it, so the
     * document must not paint a background — and it has to know that on the
     * first frame rather than one bridge call later, or there is a moment in
     * which Tenna's own dark red covers the caller and then uncovers it again.
     *
     * <p>A bridge call cannot be that early; a document-start script can. If
     * the WebView is too old to have them, the sheet still works — it comes up
     * over an opaque background instead, which is what every other signer app
     * looks like.
     */
    private void announceSheet() {
        WebView view = findViewById(com.getcapacitor.android.R.id.webview);
        if (view == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;

        try {
            WebViewCompat.addDocumentStartJavaScript(
                view,
                "document.documentElement.classList.add('signer-sheet');",
                Collections.singleton("*")
            );
        } catch (Exception e) {
            Log.i(TAG, "Could not tell the page it is a sheet");
        }
    }

    private static boolean fromHistory(@NonNull Intent intent) {
        return (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
    }
}
