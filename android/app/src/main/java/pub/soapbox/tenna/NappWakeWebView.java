package pub.soapbox.tenna;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;

/**
 * A document at a site's origin, with no window, whose only job is to wake
 * the site's service worker and hand it an event.
 *
 * Nothing native can start a service worker. Only a document at the worker's
 * origin can, by posting to it — so the service keeps one of these per site
 * that has something to deliver, navigated to a page of Tenna's at the site's
 * origin ({@code res/raw/napp_wake.html}). It has to be a real navigation: a
 * document handed to the WebView as data, even with the site's origin as its
 * base, is not a service worker client and cannot see the registration. The
 * site's worker is what answers the navigation when it has a fetch handler,
 * which is why the shim knows the page too.
 *
 * The page relays in both directions: an event from here goes to the worker as
 * a message the shim turns into a real one — a {@code push}, or the
 * {@code notificationclick} the user just caused — and the shim's reply, once
 * every {@code waitUntil} has settled, comes back the same way. One delivery
 * at a time; a site with a burst of events gets them in order.
 */
final class NappWakeWebView {

    private static final String TAG = "NappWakeWebView";

    /** Injected object name the wake page talks through; the page looks for it by this name. */
    private static final String HOST_OBJECT = "nappHost";

    private static final long DELIVERY_TIMEOUT_MS = 20_000;
    private static final long READY_TIMEOUT_MS = 15_000;
    private static final long IDLE_MS = 30_000;

    interface OnIdle {
        void onIdle(@NonNull NappWakeWebView view);
    }

    private static final class Delivery {
        /** {@code push}, {@code notificationclick} or {@code notificationclose}. */
        final String kind;
        final String payload;
        final Runnable onDone;

        Delivery(String kind, String payload, Runnable onDone) {
            this.kind = kind;
            this.payload = payload;
            this.onDone = onDone;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final String siteId;
    private final OnIdle onIdle;
    private final Deque<Delivery> queue = new ArrayDeque<>();

    @Nullable private WebView webView;
    @Nullable private JavaScriptReplyProxy proxy;
    private boolean ready;
    private boolean destroyed;
    @Nullable private Delivery inFlight;
    private int nextId = 1;

    private final Runnable idle = this::idle;
    private final Runnable timeout = this::timedOut;

    @MainThread
    NappWakeWebView(@NonNull Context context, @NonNull String siteId, @NonNull OnIdle onIdle) {
        this.siteId = siteId;
        this.onIdle = onIdle;
        this.webView = build(context.getApplicationContext());
    }

    @NonNull
    String siteId() {
        return siteId;
    }

    /** Queue an event for the worker. {@code onDone} runs on the main thread, delivered or not. */
    @MainThread
    void deliver(@NonNull String kind, @NonNull String payload, @NonNull Runnable onDone) {
        if (destroyed) {
            onDone.run();
            return;
        }
        main.removeCallbacks(idle);
        queue.add(new Delivery(kind, payload, onDone));
        pump();
    }

    @MainThread
    void destroy() {
        if (destroyed) return;
        destroyed = true;
        main.removeCallbacks(idle);
        main.removeCallbacks(timeout);

        Delivery current = inFlight;
        inFlight = null;
        if (current != null) current.onDone.run();
        while (!queue.isEmpty()) queue.poll().onDone.run();

        WebView view = webView;
        webView = null;
        proxy = null;
        if (view != null) view.destroy();
    }

    // -----------------------------------------------------------------------

    private void pump() {
        if (destroyed || inFlight != null || !ready || proxy == null) return;

        Delivery next = queue.poll();
        if (next == null) {
            main.postDelayed(idle, IDLE_MS);
            return;
        }

        inFlight = next;
        int id = nextId++;
        try {
            JSONObject message = new JSONObject();
            message.put("type", "deliver");
            message.put("kind", next.kind);
            message.put("id", id);
            message.put("data", next.payload);
            proxy.postMessage(message.toString());
            main.postDelayed(timeout, DELIVERY_TIMEOUT_MS);
        } catch (JSONException e) {
            finish();
        }
    }

    private void finish() {
        main.removeCallbacks(timeout);
        Delivery done = inFlight;
        inFlight = null;
        if (done != null) done.onDone.run();
        pump();
    }

    private void timedOut() {
        Log.w(TAG, "Worker for " + siteId + " did not answer; moving on");
        finish();
    }

    private void idle() {
        if (destroyed || inFlight != null || !queue.isEmpty()) return;
        onIdle.onIdle(this);
    }

    private void onMessage(String data) {
        try {
            JSONObject message = new JSONObject(data);
            switch (message.optString("type", "")) {
                case "ready":
                    ready = true;
                    main.removeCallbacks(timeout);
                    pump();
                    break;
                case "done":
                    if (message.optBoolean("delivered", true)) {
                        Log.i(TAG, "Worker for " + siteId + " handled an event");
                    } else {
                        Log.i(TAG, "No active worker for " + siteId + "; event dropped");
                    }
                    finish();
                    break;
                default:
                    break;
            }
        } catch (JSONException ignored) {
            // Not ours.
        }
    }

    // -----------------------------------------------------------------------
    // The page
    // -----------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    @Nullable
    private WebView build(Context context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(TAG, "No web message listener; cannot wake workers");
            return null;
        }

        String origin = NsiteOrigins.originFor(siteId);

        WebView view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        final Context app = context;
        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                // Serves the wake page for a site whose worker doesn't claim
                // navigations. One that does answers this itself, from the
                // shim, and this is never reached.
                return NsiteRequests.serve(app, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                // The page has nowhere to go.
                return true;
            }
        });

        WebViewCompat.addWebMessageListener(view, HOST_OBJECT, Collections.singleton(origin), (v, message, sourceOrigin, isMainFrame, replyProxy) -> {
            if (!isMainFrame) return;
            proxy = replyProxy;
            String data = message.getData();
            if (data != null) onMessage(data);
        });

        view.loadUrl(origin + NsiteRequests.WAKE_PATH);
        main.postDelayed(timeout, READY_TIMEOUT_MS);
        return view;
    }
}
