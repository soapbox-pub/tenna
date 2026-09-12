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

import org.json.JSONArray;
import org.json.JSONObject;

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

    /**
     * A request the user has not answered yet.
     *
     * <p>Either an intent from an app on the phone, in which case {@link
     * #parsed} is set and the answer goes back as an activity result, or a
     * request that came off a relay, in which case {@link #bunker} is set and
     * the answer goes back to the push service to be published. The sheet in
     * between does not know the difference and does not need to: it is the
     * same question about the same key.
     */
    static final class Pending {
        @Nullable final SignerRequests.Parsed parsed;
        @Nullable final NappBunker.Pending bunker;
        /** The client's own id for this, echoed back with the answer. */
        @NonNull final String id;
        @NonNull final TennaSigning.Request request;
        /** The account that would answer, or null if this device has no key. */
        @Nullable final String accountPubkey;
        /** The calling package or client pubkey; null for a web page. */
        @Nullable final String requesterId;
        @NonNull final String appName;
        @NonNull final String appKind;
        /** The caller's launcher icon as a data URI, or null. */
        @Nullable final String icon;

        /** From an intent. */
        Pending(
            @NonNull SignerRequests.Parsed parsed,
            @Nullable String accountPubkey,
            @Nullable String requesterId,
            @NonNull String appName,
            @NonNull String appKind,
            @Nullable String icon
        ) {
            this.parsed = parsed;
            this.bunker = null;
            this.id = parsed.id;
            this.request = parsed.toRequest();
            this.accountPubkey = accountPubkey;
            this.requesterId = requesterId;
            this.appName = appName;
            this.appKind = appKind;
            this.icon = icon;
        }

        /** From a relay. */
        Pending(@NonNull NappBunker.Pending bunker) {
            this.parsed = null;
            this.bunker = bunker;
            this.id = bunker.requestId;
            this.request = bunker.request;
            this.accountPubkey = bunker.accountPubkey;
            this.requesterId = bunker.clientPubkey;
            this.appName = bunker.appName;
            this.appKind = SignerApps.KIND_BUNKER;
            // A remote client's icon is a URL it gave us, and fetching one on
            // the strength of a signing request would tell whoever hosts it
            // when the user is being asked to sign. Its initial will do.
            this.icon = null;
        }
    }

    private final Deque<Pending> queue = new ArrayDeque<>();

    /** Every answer given in this window, for a client that batched — see {@link #batched}. */
    private final JSONArray answered = new JSONArray();

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
        // A notification about a remote request, rather than an app on the
        // phone asking directly. Nothing here is decided again — it was judged
        // when it arrived, and only got this far because nobody had.
        String bunkerId = bunkerRequestId(intent);
        if (bunkerId != null) {
            NappBunker.Pending waiting = NappBunker.take(bunkerId);
            if (waiting == null) {
                // Answered elsewhere, or old enough that the client has given
                // up. Either way there is nothing to ask about.
                Log.i(TAG, "A remote request is no longer waiting for an answer");
                return !additional;
            }
            NappNotifications.cancelSignerRequest(this, bunkerId);
            queue.addLast(new Pending(waiting));
            return false;
        }

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
        if (pending == null || !pending.id.equals(id)) return;
        queue.pollFirst();

        // A request that came off a relay is answered by the service, which
        // owns the socket it has to go out on. Everything about the decision —
        // the grant, the signing — happens there too, so that the answer and
        // the publish are one step and neither can happen without the other.
        if (pending.bunker != null) {
            NappPushService.resolveBunker(this, pending.bunker, allowed, remember);
            if (queue.isEmpty()) finish();
            return;
        }

        String account = pending.accountPubkey;
        String permission = pending.request.method.permission;

        if (account != null && remember && permission != null
                && pending.requesterId != null && !pending.requesterId.isEmpty()) {
            SignerApps.grant(
                this, account, pending.requesterId, pending.appKind, pending.appName,
                permission, pending.request.eventKind(), allowed
            );
        }

        if (!allowed || account == null) {
            refuse(pending.parsed);
        } else {
            TennaSigning.Outcome outcome = TennaSigning.run(this, account, pending.request);
            if (outcome.isResult()) {
                deliver(pending.parsed, outcome, pending.requesterId, account);
            } else {
                Log.i(TAG, "Could not answer an approved request: " + outcome.error);
                setResult(Activity.RESULT_CANCELED);
            }
        }

        // Anything else waiting that the answer just settled.
        //
        // A client that sent four requests at once had all four judged as they
        // arrived, when none of them had an answer on record. Saying "remember"
        // to the first one decides the rest, and asking again about a question
        // the user has this second answered is the sort of thing that teaches
        // people to press Allow without reading.
        drain();

        if (queue.isEmpty()) finish();
    }

    /** Answer everything at the front of the queue that no longer needs asking. */
    private void drain() {
        Pending next = queue.peekFirst();
        while (next != null && next.accountPubkey != null && next.parsed != null) {
            TennaSigning.Outcome outcome = TennaSigning.answer(
                this, next.accountPubkey, next.requesterId, next.request);

            if (outcome.status == TennaSigning.Outcome.Status.NEEDS_APPROVAL) break;

            queue.pollFirst();
            if (outcome.isResult()) {
                deliver(next.parsed, outcome, next.requesterId, next.accountPubkey);
            } else {
                refuse(next.parsed);
            }
            next = queue.peekFirst();
        }
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
        Intent result = SignerRequests.success(parsed, value, outcome.eventJson, getPackageName());
        setResult(Activity.RESULT_OK, batched(result, parsed, value, false));

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
        setResult(Activity.RESULT_OK, batched(SignerRequests.rejection(parsed), parsed, null, true));
    }

    /**
     * Everything answered in this window, for a client that sent several.
     *
     * <p>An activity can hand back exactly one result, and NIP-55 lets a client
     * put several requests into one window — so a batch is answered with a
     * {@code results} array alongside the extras for the last one. Clients that
     * send one request at a time never look at it and are unaffected; clients
     * that batch would otherwise get one answer out of four and wait forever
     * for the rest.
     */
    @NonNull
    private Intent batched(
        @NonNull Intent result,
        @NonNull SignerRequests.Parsed parsed,
        @Nullable String value,
        boolean rejected
    ) {
        try {
            JSONObject entry = new JSONObject();
            entry.put("id", parsed.id);
            entry.put("package", getPackageName());
            if (rejected) {
                entry.put("rejected", true);
            } else {
                entry.put("result", value);
                entry.put("signature", value);
            }
            answered.put(entry);
        } catch (org.json.JSONException e) {
            // The individual extras are still on the intent; only a batching
            // client loses anything, and only this one entry of it.
            Log.i(TAG, "Could not record an answer for a batch");
        }

        if (answered.length() > 1) result.putExtra("results", answered.toString());
        return result;
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
            if (pending.parsed != null) {
                refuse(pending.parsed);
            } else if (pending.bunker != null) {
                // A remote client is holding the request open, so a dismissal
                // has to be said out loud rather than left to time out. Never
                // remembered — see the note above.
                NappPushService.resolveBunker(this, pending.bunker, false, false);
            }
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

    // ── Requests that came off a relay ───────────────────────────────────────

    /** The scheme a notification about a remote request opens this with. */
    private static final String BUNKER_SCHEME = "tenna-signer";

    /**
     * An intent that opens the sheet for a request raised off a relay.
     *
     * <p>A NIP-46 request has no activity behind it, so a notification is the
     * only thing that can carry it to the user, and a notification needs a
     * task of its own.
     *
     * <p>The id is in the URI rather than an extra so that two notifications
     * make two distinct {@code PendingIntent}s — extras alone do not tell them
     * apart, and the second would silently replace the first.
     */
    @NonNull
    static Intent bunkerIntent(@NonNull android.content.Context context, @NonNull String requestId) {
        return new Intent(context, SignerActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.fromParts(BUNKER_SCHEME, requestId, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    /** The request id a notification named, or null if this is not one. */
    @Nullable
    private static String bunkerRequestId(@NonNull Intent intent) {
        Uri data = intent.getData();
        if (data == null || !BUNKER_SCHEME.equals(data.getScheme())) return null;

        String id = data.getSchemeSpecificPart();
        return id == null || id.isEmpty() ? null : id;
    }
}
