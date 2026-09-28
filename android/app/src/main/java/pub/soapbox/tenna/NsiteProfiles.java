package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebStorage;
import android.webkit.WebView;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
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

    /**
     * Profiles whose service worker client has been set, this process.
     *
     * Emptied of a profile when the profile is deleted, because deleting one
     * takes its client with it: a name left in here after that is a site whose
     * next profile would be made without a client and whose worker would then
     * be unreachable — no script to install from, and no notifications — until
     * the app was restarted. See {@link #serve}.
     */
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
        // Opened again since its storage was cleared: what it writes now is
        // new, and the delete owed from before must not take it. See `clear`.
        markForDeletion(view.getContext(), name, false);
        try {
            // Before setProfile, so that no worker in this profile can start
            // before the thing that serves it is in place.
            serve(
                view.getContext().getApplicationContext(),
                siteId,
                ProfileStore.getInstance().getOrCreateProfile(name)
            );
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
                // The client went with it. A site can be forgotten and opened
                // again inside one run of the app — taken off the wall and put
                // back — and the profile it gets then is a new one needing a
                // client of its own.
                served.remove(name);
            } catch (RuntimeException e) {
                Log.i(TAG, "The store for " + siteId + " is still in use; sweeping it later");
            }
        });
    }

    /**
     * How much of the device a site's store takes up, in bytes.
     *
     * Measured on disk, the way the system's own App info measures an app,
     * because that is the number the question is really about. Chromium's
     * quota figure would be the documented way to ask, and it leaves out both
     * local storage and the HTTP cache — and the cache is where a site that
     * shows a lot of pictures keeps most of what it has, a hundred megabytes
     * and more of it.
     *
     * Which directories are a profile's is Chromium's to say, and it says so
     * only in its own preferences file. Read from there; a WebView that ever
     * stops writing it down gets the quota figure instead, which is smaller
     * but not wrong about what it counts.
     *
     * Answered on the main thread.
     */
    static void usage(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull ValueCallback<Long> callback
    ) {
        Handler main = new Handler(Looper.getMainLooper());
        String name = nameFor(siteId);

        new Thread(() -> {
            long bytes = -1;
            if (isSupported()) {
                String path = directoryOf(context, name);
                if (path != null) {
                    bytes = sizeOf(new File(context.getDir("webview", Context.MODE_PRIVATE), path))
                        + sizeOf(new File(new File(context.getCacheDir(), "WebView"), path));
                }
            }

            if (bytes >= 0) {
                long measured = bytes;
                main.post(() -> callback.onReceiveValue(measured));
                return;
            }

            main.post(() -> quotaUsage(siteId, callback));
        }, "nsite-usage").start();
    }

    /**
     * Wipe what a site stored for itself, and keep the site.
     *
     * Two steps, because Chromium will not delete a profile this process has
     * loaded — and after one visit to the site in this run, or one call to
     * this, that is the profile in question.
     *
     * Now: its local and session storage, IndexedDB, Cache API, cookies and
     * HTTP cache, which is everything the site keeps that WebView has a call
     * to remove. Its service worker registrations are not among them; there
     * is no native call for that, and a page cannot make one without being
     * a document the worker would answer.
     *
     * At the next start: the profile itself, deleted whole by {@link #sweep}
     * before any WebView exists, which takes the registrations and the empty
     * databases left behind with it. Unless the site is opened again first —
     * see {@link #attach}. What it writes after a clear is new, and a delete
     * waiting for the next start must not take it.
     *
     * What Tenna holds about the site is not the site's storage and is left
     * alone: its record, its permissions, whether it is muted.
     *
     * {@code done} is run on the main thread once the cookies, the last to go,
     * are gone.
     */
    @MainThread
    static void clear(@NonNull Context context, @NonNull String siteId, @NonNull Runnable done) {
        if (!isSupported()) {
            // One store for every site, so only what is kept per origin can be
            // taken out of it. Cookies are kept per domain and there is no way
            // to reach one domain's without the rest.
            WebStorage.getInstance().deleteOrigin(NsiteOrigins.originFor(siteId));
            done.run();
            return;
        }

        String name = nameFor(siteId);

        // Whole and straight away if nothing has loaded it this run, which is
        // the one case in which Chromium allows it. Before anything else here
        // touches it, since that would load it. False is a profile that does
        // not exist: never opened, so nothing stored.
        try {
            ProfileStore.getInstance().deleteProfile(name);
            served.remove(name);
            markForDeletion(context, name, false);
            done.run();
            return;
        } catch (RuntimeException e) {
            // In use. The two steps, then.
        }

        Profile profile;
        try {
            profile = ProfileStore.getInstance().getProfile(name);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not reach the store for " + siteId, e);
            done.run();
            return;
        }
        if (profile == null) {
            done.run();
            return;
        }

        markForDeletion(context, name, true);

        // The HTTP cache is only reachable through a WebView, and any WebView
        // on the profile reaches the whole of it. This one never loads
        // anything.
        WebView scratch = new WebView(context);
        try {
            serve(context.getApplicationContext(), siteId, profile);
            WebViewCompat.setProfile(scratch, name);
            scratch.clearCache(true);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not clear the cache for " + siteId, e);
        } finally {
            scratch.destroy();
        }

        profile.getWebStorage().deleteAllData();

        CookieManager cookies = profile.getCookieManager();
        cookies.removeAllCookies(removed -> {
            cookies.flush();
            done.run();
        });
    }

    /** Where the profiles cleared but not yet deleted are written down. */
    private static final String PREFS = "nsite-profiles";
    private static final String PENDING = "pending-deletion";

    /** Write down, or cross off, a profile for {@link #sweep} to delete. */
    private static void markForDeletion(@NonNull Context context, @NonNull String name, boolean marked) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> pending = new HashSet<>(prefs.getStringSet(PENDING, Collections.emptySet()));
        if (marked ? !pending.add(name) : !pending.remove(name)) return;
        prefs.edit().putStringSet(PENDING, pending).apply();
    }

    /**
     * Delete every profile whose site is gone, and every one whose storage was
     * cleared since the last start.
     *
     * Runs at startup, before any WebView exists, because that is the one
     * moment nothing holds a profile open — {@link #forget} is called while a
     * site's own window is closing, and often cannot delete anything, and
     * {@link #clear} while the app has the profile loaded. It is also the
     * sweep that catches a record removed by any other route: a site swept
     * off the wall, storage cleared, an install restored.
     */
    @MainThread
    static void sweep(@NonNull Context context) {
        if (!isSupported()) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> pending = prefs.getStringSet(PENDING, Collections.emptySet());

        try {
            ProfileStore store = ProfileStore.getInstance();
            List<String> names = store.getAllProfileNames();

            Set<String> live = null;
            for (String name : names) {
                if (name == null || !name.startsWith(PREFIX)) continue;
                if (!pending.contains(name)) {
                    // Read once, and only if there is anything to judge.
                    if (live == null) live = NsiteSites.keys(context);
                    if (live.contains(name.substring(PREFIX.length()))) continue;
                }

                store.deleteProfile(name);
                // Nothing is in `served` yet at the moment this normally runs
                // — no WebView has been made — but the set is not allowed to
                // name a profile that no longer exists, whenever it is that a
                // profile stops existing.
                served.remove(name);
                Log.i(TAG, "Swept a store that was cleared, or whose site is gone");
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not sweep old stores", e);
        }

        // Done, or for a profile that no longer exists. Either way nothing is
        // left to delete; one that failed is left in use by nobody and is
        // cleared already, and a site opened later must not lose what it
        // writes to a delete owed from before.
        if (!pending.isEmpty()) prefs.edit().remove(PENDING).apply();
    }

    // -----------------------------------------------------------------------

    @NonNull
    private static String nameFor(@NonNull String siteId) {
        return PREFIX + NsiteSites.key(siteId);
    }

    /**
     * The directory Chromium keeps a profile in, as a name under both its data
     * and its cache directories, or null if it has none or will not say.
     *
     * Profiles are numbered in the order they were made, not named, and the
     * only record of which is which is Chromium's {@code pref_store}.
     */
    @Nullable
    private static String directoryOf(@NonNull Context context, @NonNull String name) {
        File prefs = new File(context.getDir("webview", Context.MODE_PRIVATE), "pref_store");
        try {
            byte[] bytes;
            try (FileInputStream in = new FileInputStream(prefs)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                bytes = out.toByteArray();
            }

            JSONArray list = new JSONObject(new String(bytes, StandardCharsets.UTF_8))
                .getJSONObject("profile")
                .getJSONArray("list");
            for (int i = 0; i < list.length(); i++) {
                JSONObject entry = list.getJSONObject(i);
                if (!name.equals(entry.optString("name"))) continue;
                String path = entry.optString("path");
                // A directory name, and never a way out of the directory.
                if (path.isEmpty() || path.contains("/") || path.startsWith(".")) return null;
                return path;
            }
        } catch (IOException | JSONException e) {
            Log.i(TAG, "Could not read which store is whose", e);
        }
        return null;
    }

    /** Everything under a file, in bytes. Symlinks inside it are not followed. */
    private static long sizeOf(@NonNull File file) {
        // Canonical first: the app's own directories are reached through a
        // symlink ({@code /data/user/0} is {@code /data/data}), and below a
        // canonical directory a child whose path changes when resolved is a
        // link.
        try {
            return sizeUnder(file.getCanonicalFile());
        } catch (IOException e) {
            return 0;
        }
    }

    private static long sizeUnder(@NonNull File file) {
        if (!file.exists()) return 0;
        if (!file.isDirectory()) return file.length();

        long total = 0;
        File[] children = file.listFiles();
        if (children == null) return 0;
        for (File child : children) {
            try {
                if (!child.getCanonicalPath().equals(child.getAbsolutePath())) continue;
            } catch (IOException e) {
                continue;
            }
            total += sizeUnder(child);
        }
        return total;
    }

    /**
     * What Chromium's quota system says a site uses: its IndexedDB, Cache API
     * and service workers, but not its local storage, cookies or HTTP cache.
     * The fallback for a WebView whose profiles cannot be measured on disk.
     */
    @MainThread
    private static void quotaUsage(@NonNull String siteId, @NonNull ValueCallback<Long> callback) {
        WebStorage storage = WebStorage.getInstance();
        if (isSupported()) {
            try {
                Profile profile = ProfileStore.getInstance().getProfile(nameFor(siteId));
                if (profile == null) {
                    callback.onReceiveValue(0L);
                    return;
                }
                storage = profile.getWebStorage();
            } catch (RuntimeException e) {
                callback.onReceiveValue(0L);
                return;
            }
        }
        storage.getUsageForOrigin(NsiteOrigins.originFor(siteId), callback);
    }

    /**
     * Answer this profile's service workers.
     *
     * A worker belongs to a profile rather than to a WebView, and each profile
     * has a client slot of its own — so the process-wide one that {@link
     * NsiteServiceWorkers} takes reaches only the default profile, and a site
     * moved off it would have no worker at all. Same router either way.
     *
     * <p>Without one, a site moved to its own profile would have no worker at
     * all: its {@code sw.js} would be looked up in DNS, and nothing resolves
     * {@code *.nsite.localhost}.
     */
    private static void serve(@NonNull Context app, @NonNull String siteId, @NonNull Profile profile) {
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
