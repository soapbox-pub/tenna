package pub.soapbox.tenna;

import android.app.Application;

/**
 * Process-wide setup that no one activity can own.
 *
 * A service worker's fetches, its own script included, go to a single client
 * shared by the whole process, and it has to be set before any worker starts.
 * That is earlier than any activity or service can manage, so it happens here.
 */
public class TennaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        NsiteServiceWorkers.install(this);
    }
}
