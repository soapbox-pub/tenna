package pub.soapbox.tenna;

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
        super.onCreate(savedInstanceState);

        // The push service is sticky, but an update or a force-stop takes it
        // down until something asks again; the app coming up is that something.
        NappPushService.sync(this);
    }
}
