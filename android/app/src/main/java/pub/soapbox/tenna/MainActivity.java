package pub.soapbox.tenna;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must precede super.onCreate: BridgeActivity builds the bridge at the
        // end of it, and only plugins registered by then are reachable.
        registerPlugin(NsiteWebViewPlugin.class);
        registerPlugin(NsiteShortcutsPlugin.class);
        registerPlugin(NappPushPlugin.class);
        registerPlugin(TennaSignerPlugin.class);
        // Only here. The wall is the one screen that puts an app on itself or
        // launches one, and it never runs in a site's window.
        registerPlugin(NativeAppsPlugin.class);
        // Likewise: who has been given a key is a settings screen, and
        // settings are only reachable from Tenna's own window.
        registerPlugin(SignerAppsPlugin.class);
        super.onCreate(savedInstanceState);

        // The push service is sticky, but an update or a force-stop takes it
        // down until something asks again; the app coming up is that something.
        NappPushService.sync(this);

        // A share nobody came back for leaves its bytes on disk. The app coming
        // up is a good enough clock for something that expires in a day.
        NsiteShares.sweep(this);
    }

    /**
     * A share sent to Tenna itself rather than to a site.
     *
     * This activity is {@code singleTask}, so a share that arrives while the
     * wall is already up lands here rather than in a new {@code onCreate}. The
     * intent is kept either way — the cold-start path reads it back off the
     * activity — and the web layer is told, so the picker can come up without
     * waiting for the window to be looked at again.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NsiteShortcutsPlugin.deliver(getBridge(), intent);
    }
}
