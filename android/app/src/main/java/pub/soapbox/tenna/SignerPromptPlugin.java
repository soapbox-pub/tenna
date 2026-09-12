package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The wire between {@link SignerActivity} and the sheet it draws.
 *
 * Only registered when there is something to ask about — the activity skips it
 * entirely on the path where a remembered answer is handed back with no window
 * loaded — so a call arriving here always has a question behind it.
 *
 * <p>The request crosses as JSON text rather than as a Capacitor object, for
 * the same reason events do everywhere else in this app: an event's tags are
 * arbitrarily shaped and object coercion does not keep them intact. Here that
 * would be worse than lossy. The sheet shows the user the tags to decide by,
 * and a tag list that arrived mangled is a sheet describing an event that is
 * not the one about to be signed.
 */
@CapacitorPlugin(name = "SignerPrompt")
public class SignerPromptPlugin extends Plugin {

    /**
     * What is being asked, or {@code {}} when nothing is.
     *
     * <p>Asked once as the sheet loads and again after every answer, since a
     * client may have sent several at once.
     */
    @PluginMethod
    public void getPending(PluginCall call) {
        SignerActivity activity = activity();
        if (activity == null) {
            call.resolve(new JSObject());
            return;
        }

        SignerActivity.Pending pending = activity.peek();
        if (pending == null) {
            call.resolve(new JSObject());
            return;
        }

        call.resolve(describe(activity, pending));
    }

    /** What the user pressed. */
    @PluginMethod
    public void resolve(PluginCall call) {
        String id = call.getString("id");
        Boolean allowed = call.getBoolean("allowed");
        if (id == null || allowed == null) {
            call.reject("id and allowed are required");
            return;
        }

        SignerActivity activity = activity();
        if (activity == null) {
            call.reject("There is nothing to answer");
            return;
        }

        boolean remember = Boolean.TRUE.equals(call.getBoolean("remember", false));
        // Onto the main thread: this may finish the activity, and the answer
        // it hands back travels with it.
        activity.runOnUiThread(() -> activity.resolve(id, allowed, remember));
        call.resolve();
    }

    /** Close the sheet without answering. Every dismissal is a no. */
    @PluginMethod
    public void dismiss(PluginCall call) {
        SignerActivity activity = activity();
        if (activity != null) activity.runOnUiThread(activity::finish);
        call.resolve();
    }

    // ── Describing a request ─────────────────────────────────────────────────

    @NonNull
    private static JSObject describe(
        @NonNull SignerActivity activity,
        @NonNull SignerActivity.Pending pending
    ) {
        SignerRequests.Parsed parsed = pending.parsed;
        TennaSigning.Request request = parsed.toRequest();

        JSObject json = new JSObject();
        json.put("id", parsed.id);
        json.put("method", parsed.method.wire);
        json.put("permission", parsed.method.permission);
        json.put("appName", pending.appName);
        json.put("appKind", pending.appKind);
        json.put("requesterId", pending.requesterId);
        json.put("icon", pending.icon);
        json.put("account", pending.accountPubkey);
        json.put("peer", parsed.peer);

        Integer kind = request.eventKind();
        if (kind != null) json.put("kind", (int) kind);

        // The event as text, exactly as it arrived. The sheet parses it
        // itself; nothing on the way through gets to reshape what the user is
        // being shown.
        if (parsed.method == SignerTypes.Method.SIGN_EVENT) {
            json.put("event", parsed.payload);
        }

        // Whether "remember this" is worth offering. It is not for a caller
        // with no package, because every web page shares that one identity and
        // a grant given to one would answer for the next.
        json.put("canRemember",
            pending.requesterId != null && !pending.requesterId.isEmpty()
                && parsed.method.permission != null);

        json.put("signedIn", pending.accountPubkey != null);
        if (pending.accountPubkey != null) {
            json.put("accountName", TennaAccounts.nameOf(activity, pending.accountPubkey));
        }

        // Somebody is signed in, but their key is not here — an extension, a
        // remote signer, or another signer app on this phone. Two different
        // situations that produce the same "no" and want different sentences:
        // one is fixed by signing in, and the other cannot be fixed at all,
        // because Tenna cannot pass the question along to whatever holds the
        // key without becoming a worse version of that thing.
        json.put("signedInElsewhere",
            pending.accountPubkey == null && !TennaAccounts.all(activity).isEmpty());

        return json;
    }

    // ── Telling the sheet a second request arrived ───────────────────────────

    /** Nudge the sheet to ask again, after a client added to the queue. */
    static void announce(@Nullable Bridge bridge) {
        if (bridge == null) return;

        PluginHandle handle = bridge.getPlugin("SignerPrompt");
        if (handle == null) return;

        Plugin plugin = handle.getInstance();
        if (!(plugin instanceof SignerPromptPlugin)) return;

        ((SignerPromptPlugin) plugin).notifyListeners("signerRequest", new JSObject());
    }

    @Nullable
    private SignerActivity activity() {
        return getActivity() instanceof SignerActivity ? (SignerActivity) getActivity() : null;
    }
}
