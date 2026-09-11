package pub.soapbox.tenna;

import android.content.Context;
import android.util.Log;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * A store of its own for every nsite: its cookies, its storage, its cache and
 * its service workers, kept apart from every other site's and from Tenna's.
 *
 * Without this there is one store for the whole app, and sites are separated
 * only by origin. That is nearly enough, and the gap is the parent domain.
 * {@code nsite.localhost} is not a public suffix — nothing outside this app
 * has ever heard of it — so nothing stops one site writing a cookie scoped to
 * it, which is then sent with every sibling's requests and read back by any of
 * them. A profile has a cookie jar of its own, so there are no siblings to
 * share one with.
 *
 * It also gives a site's data an end. Everything a site stored belongs to its
 * profile and to nothing else, so {@link #forget} is the whole of it going at
 * once — whereas the single store had no way to take one site's storage out of
 * it and leave the rest.
 *
 * <p><b>A profile is not a sandbox.</b> Every WebView in this app, whichever
 * profile it is on, is rendered by one renderer process. What this separates
 * is what Chromium stores and hands back; it is no answer at all to a renderer
 * exploit, which reaches the whole process and everything in it — Tenna's own
 * document, and the key on its heap, included. Closing that needs the sites
 * moved into a process of their own, which this is not.
 *
 * Profiles are named after the site's record key, the sha256 of its id, for
 * the reason {@link NsiteSites} names files that way: a named site's id ends
 * in its {@code d} tag, which is arbitrary text off a stranger's event, and a
 * profile name is a directory name. The default profile is left to Tenna, and
 * every site is moved off it.
 *
 * Multi-profile arrived in WebView 114. On anything older every call here is a
 * no-op and the app behaves as it did before: one store, shared.
 */
final class NsiteProfiles {

    private static final String TAG = "NsiteProfiles";

    /** What marks a profile as a site's, and not the default one. */
    private static final String PREFIX = "site-";

    /** Profiles whose service worker client has been set, this process. */
    private static final Set<String> served = new HashSet<>();

    private NsiteProfiles() {}

    /** Whether this WebView can keep sites apart at all. */
    static boolean isSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
    }

    /**
     * Put a WebView on its site's profile, and say whether it worked.
     *
     * Must be the first thing done to a newly made WebView: a profile can only
     * be set on one that has not been used yet, and settings, listeners and
     * {@code loadUrl} all count as use.
     *
     * A false answer means the WebView is on the default profile and shares it
     * with everything else — either because this WebView has no profiles, or
     * because setting one failed. Nothing is broken by that; it is what the
     * app did before profiles, and the caller may need to know because a
     * worker registered under one profile is invisible from another.
     */
    @MainThread
    static boolean attach(@NonNull WebView view, @NonNull String siteId) {
        if (!isSupported()) return false;

        String name = nameFor(siteId);
        try {
            // Before setProfile, so that no worker in this profile can start
            // before the thing that serves it is in place.
            serve(view.getContext().getApplicationContext(), ProfileStore.getInstance().getOrCreateProfile(name));
            WebViewCompat.setProfile(view, name);
            return true;
        } catch (RuntimeException e) {
            // A WebView that offers the feature and then refuses it, or a view
            // already used. The site still works; it is only not kept apart.
            Log.w(TAG, "Could not give " + siteId + " a store of its own", e);
            return false;
        }
    }

    /**
     * Drop a site's profile, and everything the site put in it.
     *
     * Best effort, and deliberately quiet about failing: a profile in use by a
     * live WebView cannot be deleted, and the commonest way to forget a site
     * is to close its own window, which is exactly that case. What is left
     * behind is a profile belonging to a site with no record, which is what
     * {@link #sweep} deletes at the next start, when nothing holds it.
     */
    static void forget(@NonNull Context context, @NonNull String siteId) {
        if (!isSupported()) return;

        String name = nameFor(siteId);
        // ProfileStore is the UI thread's. The caller is usually a plugin
        // method, which is not on it.
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                ProfileStore.getInstance().deleteProfile(name);
            } catch (RuntimeException e) {
                Log.i(TAG, "The store for " + siteId + " is still in use; sweeping it later");
            }
        });
    }

    /**
     * Delete every profile whose site is gone.
     *
     * Runs at startup, before any WebView exists, because that is the one
     * moment nothing holds a profile open — {@link #forget} is called while a
     * site's own window is closing, and often cannot delete anything. It is
     * also the sweep that catches a record removed by any other route: a site
     * swept off the wall, storage cleared, an install restored.
     */
    @MainThread
    static void sweep(@NonNull Context context) {
        if (!isSupported()) return;

        try {
            ProfileStore store = ProfileStore.getInstance();
            List<String> names = store.getAllProfileNames();

            Set<String> live = null;
            for (String name : names) {
                if (name == null || !name.startsWith(PREFIX)) continue;
                // Read once, and only if there is anything to judge.
                if (live == null) live = NsiteSites.keys(context);
                if (live.contains(name.substring(PREFIX.length()))) continue;

                store.deleteProfile(name);
                Log.i(TAG, "Swept the store of a site nothing is left of");
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not sweep old stores", e);
        }
    }

    // -----------------------------------------------------------------------

    @NonNull
    private static String nameFor(@NonNull String siteId) {
        return PREFIX + NsiteSites.key(siteId);
    }

    /**
     * Answer this profile's service workers.
     *
     * A worker belongs to a profile rather than to a WebView, and each profile
     * has a client slot of its own — so the process-wide one that {@link
     * NsiteServiceWorkers} takes reaches only the default profile, and a site
     * moved off it would have no worker at all. Same router either way.
     */
    private static void serve(@NonNull Context app, @NonNull Profile profile) {
        if (!served.add(profile.getName())) return;

        try {
            ServiceWorkerController controller = profile.getServiceWorkerController();
            controller.setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                @Nullable
                public WebResourceResponse shouldInterceptRequest(@NonNull WebResourceRequest request) {
                    return NsiteRequests.serve(app, request);
                }
            });
        } catch (RuntimeException e) {
            served.remove(profile.getName());
            Log.w(TAG, "Could not serve workers in " + profile.getName(), e);
        }
    }
}
