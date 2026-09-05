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
        result.put("supported", NsiteHttpServer.port() > 0);
        call.resolve(result);
    }
}
