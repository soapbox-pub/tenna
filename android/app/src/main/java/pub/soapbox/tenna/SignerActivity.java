package pub.soapbox.tenna;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
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
        /** Whether that icon is a full square with a shape still to cut. */
        final boolean adaptive;

        /** From an intent. */
        Pending(
            @NonNull SignerRequests.Parsed parsed,
            @Nullable String accountPubkey,
            @Nullable String requesterId,
            @NonNull String appName,
            @NonNull String appKind,
            @Nullable String icon,
            boolean adaptive
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
            this.adaptive = adaptive;
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
            this.adaptive = false;
        }
    }

    private final Deque<Pending> queue = new ArrayDeque<>();

    /** Every answer given in this window, for a client that batched — see {@link #batched}. */
    private final JSONArray answered = new JSONArray();

    /**
     * Requests already allowed, waiting on another signer app to do the work.
     *
     * <p>Separate from {@link #queue}, which is requests waiting on a person.
     * These need no sheet and no WebView — only a window to launch from, which
     * is the one thing a content resolver and a relay socket have not got.
     */
    private final Deque<Pending> forwards = new ArrayDeque<>();

    /** The forward currently in front of the user, in the other app. */
    @Nullable private Pending forwarding;

    /** Any value not used by a Capacitor plugin. */
    private static final int FORWARD_REQUEST = 0x5167;

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

        boolean settled = intent == null || settle(intent, false);

        // Nothing to draw is not the same as nothing to do: a request being
        // handed to another signer keeps this window alive with no WebView in
        // it at all, which is the cheap path and the common one.
        silent = queue.isEmpty();

        if (!silent) registerPlugin(SignerPromptPlugin.class);
        super.onCreate(savedInstanceState);

        if (settled && forwards.isEmpty()) {
            finish();
            return;
        }

        seeThrough();
        pumpForwards();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        if (intent == null || intent.getData() == null) return;

        // Deliberately not rate limited. A client batching requests into one
        // window is the case that machinery exists to permit, not the one it
        // exists to stop — and the user is already looking at a sheet.
        boolean settled = settle(intent, true);
        pumpForwards();
        if (settled) return;

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
        // phone asking directly. It was judged when it arrived, so the only
        // question left is which of the two things a relay socket could not do
        // this needs: a person, or a window.
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

            Pending pending = new Pending(waiting);
            TennaSigning.Outcome outcome = TennaSigning.answer(
                this, waiting.accountPubkey, waiting.clientPubkey, waiting.request, false);

            if (outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
                // Allowed already, and only here because handing it to another
                // signer takes a window. Asking again would be asking a
                // question the user has answered and said to remember.
                forwards.addLast(pending);
                return !additional;
            }

            if (outcome.status != TennaSigning.Outcome.Status.NEEDS_APPROVAL) {
                // Decided in the time it took somebody to reach the
                // notification — by the same app being answered on another
                // request, most likely, with "remember" on it.
                answer(pending, outcome);
                return !additional;
            }

            queue.addLast(pending);
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
            // Never waiting: this is the thread that draws, and it is running
            // inside `onCreate` — an answer that has to come from another app
            // comes back as NEEDS_ACTIVITY and is asked for off it.
            TennaSigning.Outcome outcome =
                TennaSigning.answer(this, account, requesterId, request, false);

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
            if (outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
                // Allowed already; it just has to be asked of the signer
                // behind this account, and that takes a window.
                forwards.addLast(describe(parsed, account, requesterId));
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
            return new Pending(parsed, account, null, name, SignerApps.KIND_WEB, null, false);
        }

        String label = requesterId;
        String icon = null;
        boolean adaptive = false;

        try {
            PackageManager packages = getPackageManager();
            ApplicationInfo info = packages.getApplicationInfo(requesterId, 0);
            label = packages.getApplicationLabel(info).toString();

            // Uncut, and shared with the wall's own icon path rather than
            // drawn again here — an adaptive icon asked to draw itself comes
            // out in this device's mask, which is how a circle ends up inside
            // a squircle. See `NativeApps.layers`.
            NativeApps.Art art = NativeApps.artOf(packages.getApplicationIcon(info));
            icon = "data:image/png;base64," + art.png;
            adaptive = art.adaptive;
            remember(requesterId, art.png, art.adaptive);
        } catch (Exception e) {
            // An app we cannot see is still an app that asked. It is named by
            // its package, which is the part that matters for telling two
            // apart anyway.
            Log.i(TAG, "Could not read the caller's name or icon");
        }

        return new Pending(parsed, account, requesterId, label, SignerApps.KIND_PACKAGE, icon, adaptive);
    }

    /** Keep the icon for the settings screen, which will not be able to ask. */
    private void remember(@NonNull String requesterId, @NonNull String png, boolean adaptive) {
        try (FileOutputStream out =
                 new FileOutputStream(SignerApps.iconFile(this, requesterId, adaptive))) {
            out.write(Base64.decode(png, Base64.NO_WRAP));

            // The other shape, if this app was ever kept under it. An update
            // can change an icon's kind, and the reader prefers the adaptive
            // file, so a stale one left lying there would outlive its app.
            //noinspection ResultOfMethodCallIgnored
            SignerApps.iconFile(this, requesterId, !adaptive).delete();
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

        String account = pending.accountPubkey;
        String permission = pending.request.method.permission;

        // Written down before the work, so that a signature that then fails
        // somewhere else still leaves the decision the user made rather than
        // asking them again about something they have answered.
        if (account != null && remember && permission != null
                && pending.requesterId != null && !pending.requesterId.isEmpty()) {
            SignerApps.grant(
                this, account, pending.requesterId, pending.appKind, pending.appName,
                permission, pending.request.eventKind(), allowed
            );
        }

        TennaSigning.Outcome outcome;
        if (!allowed) {
            outcome = TennaSigning.Outcome.rejected();
        } else if (account == null) {
            outcome = TennaSigning.Outcome.error("Nobody is signed in");
        } else {
            outcome = TennaSigning.run(this, account, pending.request, false);
        }

        // Allowed here, and now the signer behind the account has to be asked
        // too. This window is the thing it needs and a relay socket has not
        // got, which is why a remote request that gets this far comes back
        // through the sheet rather than being answered where it arrived.
        if (outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
            forwards.addLast(pending);
            pumpForwards();
            return;
        }

        answer(pending, outcome);

        // Anything else waiting that the answer just settled.
        //
        // A client that sent four requests at once had all four judged as they
        // arrived, when none of them had an answer on record. Saying "remember"
        // to the first one decides the rest, and asking again about a question
        // the user has this second answered is the sort of thing that teaches
        // people to press Allow without reading.
        drain();

        pumpForwards();
    }

    /** Answer everything at the front of the queue that no longer needs asking. */
    private void drain() {
        Pending next = queue.peekFirst();
        while (next != null && next.accountPubkey != null && next.parsed != null) {
            TennaSigning.Outcome outcome = TennaSigning.answer(
                this, next.accountPubkey, next.requesterId, next.request, false);

            if (outcome.status == TennaSigning.Outcome.Status.NEEDS_APPROVAL) break;

            queue.pollFirst();
            if (outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
                // Decided, and now somebody else's to sign. Off the front of
                // the queue and into the other line — see `pumpForwards`,
                // which the caller runs once this is done.
                forwards.addLast(next);
            } else if (outcome.isResult()) {
                deliver(next.parsed, outcome, next.requesterId, next.accountPubkey);
            } else {
                refuse(next.parsed);
            }
            next = queue.peekFirst();
        }
    }

    // ── Handing it on to another signer ──────────────────────────────────────

    /**
     * Put the next waiting request to the signer app behind its account.
     *
     * <p>Quietly if that signer will have it — it may have been told to
     * remember this, in which case the whole thing happens with nothing on
     * screen — and in its own window if it will not. Asking which costs a call
     * into another process, so it happens off this thread; everything after it
     * comes back here.
     *
     * <p>One at a time, because the other signer shows its own sheet and two
     * of those at once is a window nobody can answer.
     */
    private void pumpForwards() {
        if (forwarding != null) return;

        Pending next = forwards.pollFirst();
        if (next == null) {
            if (queue.isEmpty()) finish();
            return;
        }

        TennaAccounts.Account account = next.accountPubkey == null
            ? null : TennaAccounts.find(this, next.accountPubkey);

        if (account == null || !AndroidSigner.canAsk(this, account.packageName)) {
            answerForward(next, TennaSigning.Outcome.error("That account's signer is not here"));
            return;
        }

        // Claimed from here, so nothing starts a second forward while this one
        // is in the air.
        forwarding = next;

        String packageName = account.packageName;
        String accountPubkey = next.accountPubkey;

        AndroidSigner.queryInBackground(this, packageName, accountPubkey, next.request,
            outcome -> runOnUiThread(() -> {
                // The window may have gone while that was in flight, and going
                // is what refuses everything it was holding. Then this answer
                // is nobody's, and giving it twice is worse than late.
                if (forwarding != next) return;

                if (outcome.status != TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
                    forwarding = null;
                    answerForward(next, outcome);
                    return;
                }

                ask(next, packageName, accountPubkey);
            }));
    }

    /** Put the question to the other signer's own user, in its own window. */
    private void ask(
        @NonNull Pending pending,
        @NonNull String packageName,
        @NonNull String accountPubkey
    ) {
        try {
            startActivityForResult(
                AndroidSigner.intentFor(packageName, accountPubkey, pending.request),
                FORWARD_REQUEST
            );
        } catch (Exception e) {
            forwarding = null;
            Log.i(TAG, "Could not open " + packageName, e);
            answerForward(pending, TennaSigning.Outcome.error("Could not open that account's signer"));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == FORWARD_REQUEST) {
            Pending pending = forwarding;
            forwarding = null;
            if (pending == null) return;

            // A result code other than OK means the other signer failed,
            // which NIP-55 keeps distinct from its user saying no — a refusal
            // comes back as OK with a flag on it.
            String account = pending.accountPubkey;
            answerForward(pending, resultCode == Activity.RESULT_OK && account != null
                ? AndroidSigner.read(account, pending.request, data)
                : TennaSigning.Outcome.error("That account's signer did not answer"));
            return;
        }

        // The bridge is absent on the path that never loaded a WebView, and
        // its own override would not know that.
        if (getBridge() != null) super.onActivityResult(requestCode, resultCode, data);
    }

    /** Pass a forwarded answer back to whoever asked us, then take the next. */
    private void answerForward(@NonNull Pending pending, @NonNull TennaSigning.Outcome outcome) {
        answer(pending, outcome);
        pumpForwards();
    }

    /**
     * Give one request its answer, by whichever road it arrived on.
     *
     * <p>An intent is answered with an activity result; something that came
     * off a relay is answered by the service, which owns the socket it has to
     * go out on and is told what the signer said rather than asked to work it
     * out a second time.
     */
    private void answer(@NonNull Pending pending, @NonNull TennaSigning.Outcome outcome) {
        if (pending.bunker != null) {
            // It came off a relay, so the answer goes back out on one. The
            // service owns the socket; it is told what the signer said rather
            // than asked to work it out again.
            NappPushService.resolveBunker(this, pending.bunker, outcome.isResult(), false, outcome);
        } else if (pending.parsed != null) {
            if (outcome.isResult() && pending.accountPubkey != null) {
                deliver(pending.parsed, outcome, pending.requesterId, pending.accountPubkey);
            } else if (outcome.status == TennaSigning.Outcome.Status.REJECTED) {
                refuse(pending.parsed);
            } else {
                Log.i(TAG, "Could not answer a request: " + outcome.error);
                setResult(Activity.RESULT_CANCELED);
            }
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
        // Everything still waiting, whether on a person or on another signer.
        // A window that goes away with a request in it owes somebody an
        // answer either way, and the one thing it must never be is silence.
        refuseAll(queue);
        refuseAll(forwards);

        Pending open = forwarding;
        forwarding = null;
        if (open != null) answer(open, TennaSigning.Outcome.rejected());

        super.finish();
    }

    private void refuseAll(@NonNull Deque<Pending> waiting) {
        Pending pending = waiting.pollFirst();
        while (pending != null) {
            // Never remembered — see the note above.
            answer(pending, TennaSigning.Outcome.rejected());
            pending = waiting.pollFirst();
        }
    }

    // ── The window ───────────────────────────────────────────────────────────

    /**
     * Make the window and the WebView draw nothing of their own.
     *
     * <p>Capacitor sets its own theme in {@code onCreate}, so the transparent
     * background from the manifest has to be put back afterwards. The dim
     * behind the sheet is drawn by the sheet itself rather than by the window,
     * which is what gives it the same fade as everywhere else in the app.
     *
     * <p><b>It does not make the app that asked visible underneath.</b> The
     * window is translucent as far as the framework is concerned — it does not
     * occlude its parent — and the document, the WebView and every view
     * between them have been checked to be transparent, and the screen above
     * the sheet is still a flat grey. Whatever paints it is below all of that.
     * So the sheet fills the window instead of rising partway up it, and the
     * emptiness this was meant to show something through is never on screen.
     * See {@code PermissionSheet}.
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
