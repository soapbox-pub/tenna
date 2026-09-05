package pub.soapbox.tenna;

import android.app.Application;

/**
 * Process-wide setup that no one activity can own.
 *
 * Every nsite is served from one loopback HTTP server, and a site's service
 * worker may need serving when the only thing running is the push service.
 * So the server is started here, before any activity or service has asked
 * for a site.
 */
public class TennaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        NsiteHttpServer.start(this);
    }
}
