package pub.soapbox.tenna;

import android.app.Application;

/**
 * Process-wide setup that no one activity can own.
 *
 * A service worker's fetches, its own script included, go to a client that has
 * to be set before any worker starts. That is earlier than any activity or
 * service can manage, so it happens here.
 *
 * The sweep wants the same moment for the opposite reason: a profile cannot be
 * deleted while a WebView is using it, and this is the one point in the life of
 * the process when none is.
 */
public class TennaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        NsiteServiceWorkers.install(this);
        NsiteProfiles.sweep(this);
    }
}
