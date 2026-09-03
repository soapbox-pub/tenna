package pub.soapbox.tenna;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Renders an nsite in a WebView of its own, layered over the Capacitor one.
 *
 * The point of the exercise is frame nesting. Safe-area insets belong to the
 * outermost main frame and to nothing else — not to a cross-origin iframe, not
 * to a same-origin one, not to an iframe in the Fullscreen API — and no API
 * exists to define an environment variable from inside a document. A site in
 * an iframe therefore has to be handed its insets by rewriting the CSS it is
 * served. A site that owns its WebView just asks the platform, and
 * {@code viewport-fit=cover} and {@code env(safe-area-inset-*)} mean what they
 * say.
 *
 * Everything else here follows from that one decision:
 *
 * <ul>
 *   <li>Files are served by {@link NsiteFileServer} on the WebView's own
 *       background thread, so no file bytes cross the Capacitor bridge. The
 *       bridge carries the manifest once and the signer calls, nothing more.
 *   <li>Each site gets its own origin under {@code *.nsite.localhost}, which
 *       separates localStorage and IndexedDB per site and keeps the document
 *       in a secure context.
 *   <li>The view sits above the Capacitor WebView so that touch, focus and the
 *       soft keyboard all behave normally. Tenna's own chrome stays in React
 *       underneath, and the transitions are run here to match.
 * </ul>
 */
@CapacitorPlugin(name = "NsiteWebView")
public class NsiteWebViewPlugin extends Plugin {

    /**
     * Parent domain for site origins.
     *
     * A {@code .localhost} name is treated as potentially trustworthy, so the
     * document is a secure context and can use crypto.subtle, service workers
     * and the rest. Nothing resolves it: every same-origin request is answered
     * by {@link NsiteFileServer}.
     *
     * Unlike the shared, public {@code iframe.diy} domain the iframe path uses,
     * this one is reachable only from inside this app's WebView, so the site
     * label can be the plain NIP-5A subdomain rather than an HMAC of it.
     */
    private static final String SITE_DOMAIN = "nsite.localhost";

    /** Injected object name the NIP-07 provider posts through. */
    private static final String HOST_OBJECT = "tennaHost";

    @Nullable private WebView webView;
    @Nullable private NsiteFileServer fileServer;
    @Nullable private JavaScriptReplyProxy replyProxy;
    @Nullable private String host;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    @PluginMethod
    @SuppressLint("SetJavaScriptEnabled")
    public void open(PluginCall call) {
        String siteId = call.getString("siteId");
        String providerScript = call.getString("providerScript");
        JSObject manifest = call.getObject("files");
        JSArray serverList = call.getArray("servers");

        if (siteId == null || manifest == null || serverList == null) {
            call.reject("siteId, files and servers are required");
            return;
        }

        final Map<String, String> files = new HashMap<>();
        for (Iterator<String> keys = manifest.keys(); keys.hasNext(); ) {
            String path = keys.next();
            String sha256 = manifest.optString(path, null);
            if (sha256 != null) files.put(path, sha256);
        }

        final List<String> servers = new ArrayList<>();
        try {
            for (Object server : serverList.toList()) {
                if (server instanceof String) servers.add((String) server);
            }
        } catch (JSONException e) {
            call.reject("Malformed servers list", e);
            return;
        }

        final String siteHost = siteId.toLowerCase() + "." + SITE_DOMAIN;
        final String origin = "https://" + siteHost;

        getActivity().runOnUiThread(() -> {
            destroyWebView();

            host = siteHost;
            fileServer = new NsiteFileServer(files, servers, new File(getContext().getCacheDir(), "nsite"));

            WebView view = new WebView(getContext());
            configure(view);
            installBridge(view, origin, providerScript);

            // Start invisible: React is painting tuning static underneath, and
            // the site fades up over it once it has something to show.
            view.setAlpha(0f);

            ViewGroup content = getActivity().findViewById(android.R.id.content);
            content.addView(view, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ));

            webView = view;
            view.loadUrl(origin + "/");
            call.resolve();
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WebView view = webView;
            if (view == null) {
                call.resolve();
                return;
            }

            // Approximates the `crt-off` keyframes the React layer uses: the
            // picture collapses to a line, then to a point, then goes out.
            view.animate()
                .scaleY(0.004f)
                .setDuration(300)
                .withEndAction(() -> view.animate()
                    .scaleX(0.002f)
                    .alpha(0f)
                    .setDuration(250)
                    .setListener(new AnimatorListenerAdapter() {
                        @Override
                        public void onAnimationEnd(Animator animation) {
                            destroyWebView();
                        }
                    })
                    .start())
                .start();

            call.resolve();
        });
    }

    /**
     * Step back through the site's own history, reporting whether it could.
     *
     * A back gesture belongs to the site while the site has somewhere to go;
     * only then does it mean "leave". The iframe implementation can't offer
     * this — the history of a cross-origin frame isn't readable — so back
     * closes the viewer outright there.
     */
    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            WebView view = webView;
            boolean moved = view != null && view.canGoBack();
            if (moved) view.goBack();
            result.put("moved", moved);
            call.resolve(result);
        });
    }

    /**
     * Hide the site without unloading it, for permission prompts.
     *
     * The prompt is drawn by React, underneath this view, so the site has to
     * get out of the way — which also means it cannot paint anything behind a
     * security decision the user is being asked to make.
     */
    @PluginMethod
    public void setConcealed(PluginCall call) {
        boolean concealed = Boolean.TRUE.equals(call.getBoolean("concealed", false));
        getActivity().runOnUiThread(() -> {
            if (webView != null) {
                webView.setVisibility(concealed ? View.INVISIBLE : View.VISIBLE);
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(this::destroyWebView);
    }

    private void destroyWebView() {
        WebView view = webView;
        webView = null;
        fileServer = null;
        replyProxy = null;
        host = null;
        if (view == null) return;

        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.destroy();
    }

    // -----------------------------------------------------------------------
    // WebView setup
    // -----------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);

        // Without this the viewport meta is ignored, which would take
        // `viewport-fit=cover` — the whole point — with it.
        settings.setUseWideViewPort(true);

        // Nothing an nsite is served comes from the device.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        // The window is edge to edge; let the site fill it, and report the
        // insets rather than eating them.
        view.setFitsSystemWindows(false);

        // Read off the manifest rather than BuildConfig, which this module
        // doesn't generate.
        boolean debuggable =
            (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                NsiteFileServer server = fileServer;
                String expected = host;
                if (server == null || expected == null) return null;
                return server.serve(expected, request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                String expected = host;
                // Keep the site inside its own origin. Anything else it tries
                // to navigate to is a link out, which is not ours to follow.
                return expected == null || !expected.equalsIgnoreCase(url.getHost());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                notifyListeners("nsiteLoad", new JSObject());
                v.animate().alpha(1f).setDuration(600).start();
            }
        });
    }

    /**
     * Install the NIP-07 provider and its transport.
     *
     * {@code addDocumentStartJavaScript} runs the script before any of the
     * page's own, which is what {@code window.nostr} has to promise: a site
     * that checks for a provider at module scope has to find one. Both APIs
     * are scoped to the site's origin, so no other document can reach them.
     */
    private void installBridge(WebView view, String origin, @Nullable String providerScript) {
        Set<String> allowed = Collections.singleton(origin);

        if (providerScript == null) return;

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Without both, the provider would either arrive too late to be
            // found or have no way to call home. Better no `window.nostr` than
            // one that hangs.
            return;
        }

        WebViewCompat.addWebMessageListener(view, HOST_OBJECT, allowed, (v, message, sourceOrigin, isMainFrame, proxy) -> {
            if (!isMainFrame) return;
            replyProxy = proxy;
            forwardRpc(message);
        });

        WebViewCompat.addDocumentStartJavaScript(view, providerScript, allowed);
    }

    private void forwardRpc(@NonNull WebMessageCompat message) {
        String data = message.getData();
        if (data == null) return;

        try {
            JSONObject request = new JSONObject(data);
            JSObject event = new JSObject();
            event.put("id", request.optInt("id", -1));
            event.put("method", request.optString("method"));
            // Params travel as JSON text. A signed event's tags are an
            // arbitrarily shaped array, and round-tripping that through
            // Capacitor's object coercion loses types.
            event.put("params", request.opt("params") == null ? "{}" : request.get("params").toString());
            notifyListeners("nsiteRpc", event);
        } catch (JSONException ignored) {
            // A malformed message is the site's problem; it gets no reply.
        }
    }

    /** Deliver a JSON-RPC response for a call previously raised as `nsiteRpc`. */
    @PluginMethod
    public void respond(PluginCall call) {
        Integer id = call.getInt("id");
        String result = call.getString("result");
        String error = call.getString("error");

        JavaScriptReplyProxy proxy = replyProxy;
        if (id == null || proxy == null) {
            call.resolve();
            return;
        }

        try {
            JSONObject response = new JSONObject();
            response.put("jsonrpc", "2.0");
            response.put("id", id);
            if (error != null) {
                JSONObject detail = new JSONObject();
                detail.put("code", -1);
                detail.put("message", error);
                response.put("error", detail);
            } else {
                response.put("result", result == null ? JSONObject.NULL : new org.json.JSONTokener(result).nextValue());
            }
            final String payload = response.toString();
            getActivity().runOnUiThread(() -> proxy.postMessage(payload));
        } catch (JSONException e) {
            call.reject("Malformed response", e);
            return;
        }

        call.resolve();
    }
}
