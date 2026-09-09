package pub.soapbox.tenna;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.IOException;

/**
 * The native half of {@code window.napp.push}.
 *
 * A site's {@code set()} and {@code get()} arrive here by way of the web
 * layer, which has already asked the user whether the site may send
 * notifications at all. What's stored is what the push service listens for;
 * the service is nudged after every change so it can start, stop, or
 * re-subscribe.
 *
 * Subscriptions cross the bridge as JSON text, for the reason a signed
 * event's tags do: a filter's tag lists are arbitrarily shaped, and
 * Capacitor's object coercion does not keep them intact.
 */
@CapacitorPlugin(
    name = "NappPush",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = NappPushPlugin.NOTIFICATIONS)
    }
)
public class NappPushPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    /** Replace a site's subscriptions. */
    @PluginMethod
    public void set(PluginCall call) {
        String siteId = call.getString("siteId");
        String label = call.getString("label");
        String subscriptions = call.getString("subscriptions");

        if (siteId == null || label == null || label.isEmpty() || subscriptions == null) {
            call.reject("siteId, label and subscriptions are required");
            return;
        }

        JSONArray normalized;
        try {
            normalized = NappSubscriptions.normalize(new JSONArray(subscriptions));
        } catch (JSONException e) {
            call.reject("subscriptions must be a JSON array");
            return;
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage());
            return;
        }

        // The worker that will be woken is served from the site's stored
        // manifest, so a site without a record could subscribe but never be
        // told anything.
        if (normalized.length() > 0 && NsiteSites.load(getContext(), siteId) == null) {
            call.reject("The site has no stored manifest to serve its worker from");
            return;
        }

        try {
            NappSubscriptions.set(getContext(), siteId, label, normalized);
        } catch (IOException e) {
            call.reject("Could not store the subscriptions", e);
            return;
        }

        // Clearing is how the shield revokes the permission, and a revoked
        // permission that left the site's notifications sitting in the shade
        // would not have revoked much.
        if (normalized.length() == 0) {
            NappNotifications.cancelAll(getContext(), siteId);
        }

        NappPushService.sync(getContext());

        JSObject result = new JSObject();
        result.put("subscriptions", normalized.toString());
        call.resolve(result);
    }

    /** A site's subscriptions as stored, or an empty list. */
    @PluginMethod
    public void get(PluginCall call) {
        String siteId = call.getString("siteId");
        if (siteId == null) {
            call.reject("siteId is required");
            return;
        }

        NappSubscriptions.Record record = NappSubscriptions.get(getContext(), siteId);
        JSObject result = new JSObject();
        result.put("subscriptions", record == null ? "[]" : record.subscriptions.toString());
        call.resolve(result);
    }

    /**
     * Turn a site's notifications off, or back on.
     *
     * The user's answer rather than the site's, so it is kept away from the
     * subscriptions a site replaces at will and outlives them — see
     * {@link NappMuted}. Turning them off takes down whatever the site has in
     * the shade and drops the relays that were being held open for it; turning
     * them back on brings those relays up again, against the subscriptions the
     * site set before it was muted — starting from now, not from where they
     * left off.
     */
    @PluginMethod
    public void setMuted(PluginCall call) {
        String siteId = call.getString("siteId");
        Boolean muted = call.getBoolean("muted");

        if (siteId == null || muted == null) {
            call.reject("siteId and muted are required");
            return;
        }

        NappMuted.set(getContext(), siteId, muted);

        if (muted) {
            NappNotifications.cancelAll(getContext(), siteId);
        } else {
            // Coming back to the present rather than to wherever the site's
            // subscriptions last got to. See NappSubscriptions#skipToNow.
            NappSubscriptions.skipToNow(getContext(), siteId);
        }

        NappPushService.sync(getContext());

        call.resolve();
    }

    /** Whether the user has turned a site's notifications off. */
    @PluginMethod
    public void getMuted(PluginCall call) {
        String siteId = call.getString("siteId");
        if (siteId == null) {
            call.reject("siteId is required");
            return;
        }

        JSObject result = new JSObject();
        result.put("muted", NappMuted.isMuted(getContext(), siteId));
        call.resolve(result);
    }

    /**
     * Ask for the OS notification permission, if the OS has one to ask for.
     *
     * Before Android 13 notifications need no permission; there, and when
     * the permission was already given, this resolves at once.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            resolvePermission(call);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "onPermissionResult");
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        resolvePermission(call);
    }

    private void resolvePermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", NappNotifications.isEnabled(getContext()));
        call.resolve(result);
    }

    /** Whether anything a site subscribes to could be shown. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", NappNotifications.isEnabled(getContext()));
        result.put("running", NappPushService.isRunning());
        // Without a service worker client there are no workers to deliver to.
        result.put("supported", NsiteServiceWorkers.isSupported());
        call.resolve(result);
    }
}
