package pub.soapbox.tenna;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * The apps already on the device, offered to the wall alongside the nsites.
 *
 * A phone's home screen is where its apps are, and Tenna's wall is a home
 * screen; a person who puts a site on it has no reason to expect their camera
 * to be somewhere else. So the wall takes both, and a tile is a tile either
 * way — the difference is only what pressing it opens.
 *
 * Icons come across one at a time rather than with the list. A device has a
 * couple of hundred launchable apps and each icon is a few kilobytes of PNG,
 * which is a slow first paint for a picker where the names are what is being
 * read; the list arrives at once and the artwork fills in behind it.
 */
@CapacitorPlugin(name = "NativeApps")
public class NativeAppsPlugin extends Plugin {

    /** Whether this platform can enumerate and launch installed apps at all. */
    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", true);
        call.resolve(result);
    }

    /** Every launchable app on the device, by name, without artwork. */
    @PluginMethod
    public void list(PluginCall call) {
        List<NativeApps.Entry> entries = NativeApps.list(getContext());

        JSArray apps = new JSArray();
        for (NativeApps.Entry entry : entries) {
            JSObject app = new JSObject();
            app.put("id", entry.id());
            app.put("packageName", entry.packageName);
            app.put("activityName", entry.activityName);
            app.put("label", entry.label);
            apps.put(app);
        }

        JSObject result = new JSObject();
        result.put("apps", apps);
        call.resolve(result);
    }

    /** One app's icon, as a base64 PNG without a data URL prefix. */
    @PluginMethod
    public void icon(PluginCall call) {
        String packageName = call.getString("packageName");
        if (packageName == null) {
            call.reject("packageName is required");
            return;
        }

        JSObject result = new JSObject();
        result.put("icon", NativeApps.icon(getContext(), packageName, call.getString("activityName")));
        call.resolve(result);
    }

    /**
     * Open an app.
     *
     * Resolving with {@code launched: false} rather than rejecting: an app that
     * has been uninstalled since it was put on the wall is an ordinary state of
     * affairs, and the tile answers it by taking itself off.
     */
    @PluginMethod
    public void launch(PluginCall call) {
        String packageName = call.getString("packageName");
        if (packageName == null) {
            call.reject("packageName is required");
            return;
        }

        JSObject result = new JSObject();
        result.put("launched", NativeApps.launch(getContext(), packageName, call.getString("activityName")));
        call.resolve(result);
    }

    /** Open the system's settings page for an app. */
    @PluginMethod
    public void settings(PluginCall call) {
        String packageName = call.getString("packageName");
        if (packageName == null) {
            call.reject("packageName is required");
            return;
        }

        JSObject result = new JSObject();
        result.put("opened", NativeApps.settings(getContext(), packageName));
        call.resolve(result);
    }

    /** Hand a URI to whatever on the device answers for its scheme. */
    @PluginMethod
    public void openUri(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri is required");
            return;
        }

        JSObject result = new JSObject();
        result.put("opened", NativeApps.openUri(getContext(), uri));
        call.resolve(result);
    }
}
