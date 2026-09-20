package pub.soapbox.tenna;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewFeature;

/**
 * Serves every service worker in the process.
 *
 * A worker belongs to an origin rather than to a WebView — several WebViews at
 * one origin share one — so Chromium cannot route its fetches to any
 * particular {@code WebViewClient}. They go instead to a single client
 * registered here, which is also where the fetch of a worker's own script
 * lands. Without one, an nsite's {@code sw.js} is looked up in DNS, and
 * nothing resolves {@code *.nsite.localhost}: no site could register a worker
 * at all, and a worker is what a push notification is delivered to.
 *
 * <p>This is the client for the default profile, which on a WebView with
 * profiles is Tenna's own and no site's: {@link NsiteProfiles} gives every
 * site a profile with a worker client of its own, and it is that one a site's
 * workers reach. What is left here is the fallback — a WebView too old for
 * profiles keeps every site in the default one, and this is what serves them,
 * as it served them all before.
 *
 * <p><b>There is exactly one such client per profile, and it is a single
 * slot.</b> Capacitor sets its own from {@code Bridge}, pointed at the local
 * asset server, which answers for {@code localhost} and returns null for
 * everything else — including every nsite. Whichever is set last wins, and the
 * bridge is built long after this. So {@code android.resolveServiceWorkerRequests}
 * is false in {@code capacitor.config.ts}, leaving the slot to this. Tenna
 * itself registers no worker, so nothing is lost by that.
 */
final class NsiteServiceWorkers {

    private static final String TAG = "NsiteServiceWorkers";

    private static boolean installed;

    private NsiteServiceWorkers() {}

    /**
     * Take the process's service worker client.
     *
     * Must run before any worker starts — before any WebView is made, in
     * practice — which is why {@link TennaApplication} is what calls it.
     */
    static synchronized void install(@NonNull Context context) {
        if (installed) return;

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            Log.w(TAG, "This WebView cannot serve service workers; nsites will have none");
            return;
        }

        final Context app = context.getApplicationContext();

        try {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                new ServiceWorkerClientCompat() {
                    @Override
                    @Nullable
                    public WebResourceResponse shouldInterceptRequest(@NonNull WebResourceRequest request) {
                        // A worker, and that is the whole of what this can
                        // say: every site left on the default profile shares
                        // this one client, so which site's worker it is has to
                        // come from the token. See NsiteRequests.Asker.
                        return NsiteRequests.serve(app, request, NsiteRequests.Asker.worker());
                    }
                }
            );
        } catch (RuntimeException e) {
            // A WebView that claims the feature and then refuses it. Sites
            // still work; only their workers are lost.
            Log.w(TAG, "Could not take the service worker client", e);
            return;
        }

        installed = true;
    }

    /** Whether service workers — and so notifications — can work at all here. */
    static synchronized boolean isSupported() {
        return installed;
    }
}
