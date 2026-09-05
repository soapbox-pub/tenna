package pub.soapbox.tenna;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.content.pm.ApplicationInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
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
 *       in a secure context. The site's service worker is served from the same
 *       manifest, but by {@link NsiteServiceWorkers} rather than from here.
 *   <li>The view sits above the Capacitor WebView so that touch, focus and the
 *       soft keyboard all behave normally. That buries React's copy of the
 *       chrome, so the shield over the site is drawn here instead — but only
 *       the button. Every panel is still React's, shown by concealing this
 *       view, and the transitions are run here to match.
 *   <li>A site that doesn't declare {@code viewport-fit=cover} is inset by the
 *       safe area rather than laid out under the system bars, so that the
 *       viewport it is written against is the one it gets. That is what
 *       {@code viewport-fit=auto} asks for and what Chrome only honours for
 *       display cutouts.
 * </ul>
 */
@CapacitorPlugin(name = "NsiteWebView")
public class NsiteWebViewPlugin extends Plugin {

    private static final String TAG = "NsiteWebView";

    /** Injected object name the NIP-07 provider posts through. */
    private static final String HOST_OBJECT = "tennaHost";

    /** Gap between the safe area and the floating shield, matching the React chrome. */
    private static final int CHROME_MARGIN_DP = 12;

    @Nullable private ViewGroup container;
    @Nullable private WebView webView;
    /** The floating shield, when the site has a signer to have granted anything. */
    @Nullable private View pill;
    @Nullable private NsiteFileServer fileServer;
    @Nullable private JavaScriptReplyProxy replyProxy;
    @Nullable private String host;

    /**
     * Where the system bars and the cutout are, in pixels.
     *
     * Kept because both things that depend on it — the letterbox and the
     * position of the floating shield — outlive any one inset dispatch, and
     * because the site's document may arrive before or after the first one.
     */
    @NonNull private Insets safeArea = Insets.NONE;

    /**
     * Whether the site said it would draw under the system bars itself.
     *
     * Assumed true until its document has been read, because that is the case
     * in which nothing has to happen: the WebView is already full-bleed, so a
     * site that turns out to want it never moves.
     */
    private boolean edgeToEdge = true;

    /**
     * Whether the shutoff animation is already playing.
     *
     * The frame is asked to close twice — once when the viewer starts its own
     * shutoff, and again when the component finally unmounts — and the second
     * ask arrives while the first animation is still running. Without this it
     * would start a second animation over the first and destroy the WebView
     * from two end actions, tearing a live surface out from under the render
     * thread.
     */
    private boolean shuttingDown;

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

        final String siteHost = NsiteOrigins.hostFor(siteId);
        final String origin = NsiteOrigins.originFor(siteId);

        getActivity().runOnUiThread(() -> {
            destroyWebView();

            host = siteHost;
            edgeToEdge = true;
            fileServer = new NsiteFileServer(
                files,
                servers,
                NsiteFileServer.cacheDir(getContext()),
                // Raised on the WebView's background thread.
                siteChrome -> getActivity().runOnUiThread(() -> applySiteChrome(siteChrome))
            );
            // Registered so that the site's service worker — whose fetches
            // reach the process-wide client rather than this view's — is
            // served from this manifest rather than from the one on disk.
            NsiteFileServers.register(siteHost, fileServer);

            WebView view = new WebView(getContext());
            configure(view);
            installBridge(view, origin, providerScript);

            // The site's pixels and the shield over them travel together: they
            // fade in as one, shut off as one, and hide as one behind a
            // permission prompt. The frame also paints the letterbox for a
            // site that isn't drawing under the system bars itself.
            FrameLayout frame = new FrameLayout(getContext());
            frame.setBackgroundColor(Color.BLACK);

            // Start invisible: React is painting tuning static underneath, and
            // the site fades up over it once it has something to show.
            frame.setAlpha(0f);

            frame.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ));

            View shield = buildPill(providerScript != null);
            if (shield != null) {
                frame.addView(shield, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP | Gravity.END
                ));
            }

            ViewGroup content = getActivity().findViewById(android.R.id.content);
            content.addView(frame, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ));

            container = frame;
            webView = view;
            pill = shield;

            observeInsets(frame);

            view.loadUrl(origin + "/");
            call.resolve();
        });
    }

    /**
     * Track the safe area for as long as the site is open.
     *
     * The insets are returned untouched so that the Capacitor WebView beside
     * us still receives them — Tenna's own chrome is laid out from the same
     * numbers. Listening rather than reading once is what makes a rotation
     * move the letterbox and the controls with the cutout.
     */
    private void observeInsets(View view) {
        ViewCompat.setOnApplyWindowInsetsListener(view, (v, insets) -> {
            safeArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            layoutForSafeArea();
            return insets;
        });
        ViewCompat.requestApplyInsets(view);
    }

    /** Lay the site and the shield over it out for the current insets. */
    private void layoutForSafeArea() {
        WebView view = webView;
        if (view != null) {
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) view.getLayoutParams();
            // A site that opted in fills the window and pads itself with
            // `env()`. One that didn't is inset until its viewport really is
            // the safe area, which is the assumption its CSS is written under.
            params.setMargins(
                edgeToEdge ? 0 : safeArea.left,
                edgeToEdge ? 0 : safeArea.top,
                edgeToEdge ? 0 : safeArea.right,
                edgeToEdge ? 0 : safeArea.bottom
            );
            view.setLayoutParams(params);
        }

        View shield = pill;
        if (shield != null) {
            int gap = dp(CHROME_MARGIN_DP);
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) shield.getLayoutParams();
            // Always in the safe area, whatever the site chose. Under the
            // status bar it'd be both invisible and untappable.
            params.setMargins(0, safeArea.top + gap, safeArea.right + gap, 0);
            shield.setLayoutParams(params);
        }
    }

    /** Take what the site's document asked for, once it has been read. */
    private void applySiteChrome(NsiteSiteChrome siteChrome) {
        edgeToEdge = siteChrome.edgeToEdge;

        ViewGroup frame = container;
        if (frame != null && !siteChrome.edgeToEdge && siteChrome.themeColor != null) {
            // The strips left by the letterbox read as part of the site rather
            // than as a black border around it.
            frame.setBackgroundColor(siteChrome.themeColor);
        }

        layoutForSafeArea();
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ViewGroup view = container;
            if (view == null || shuttingDown) {
                call.resolve();
                return;
            }
            shuttingDown = true;

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
            if (container != null) {
                // The whole frame, controls included: React draws its own set
                // of them underneath, and two would be one too many.
                container.setVisibility(concealed ? View.INVISIBLE : View.VISIBLE);
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
        ViewGroup frame = container;
        NsiteFileServer server = fileServer;
        String served = host;
        webView = null;
        container = null;
        pill = null;
        fileServer = null;
        replyProxy = null;
        host = null;
        shuttingDown = false;

        if (server != null && served != null) NsiteFileServers.unregister(served, server);

        if (frame != null) {
            // Whoever got here first wins: opening another site, or the
            // activity going away, can arrive mid-shutoff. Stop the animation
            // before the view it is transforming is taken apart.
            frame.animate().setListener(null).cancel();
            ViewCompat.setOnApplyWindowInsetsListener(frame, null);
            ViewGroup parent = (ViewGroup) frame.getParent();
            if (parent != null) parent.removeView(frame);
            frame.removeAllViews();
        }
        if (view != null) view.destroy();
    }

    // -----------------------------------------------------------------------
    // The floating shield
    // -----------------------------------------------------------------------

    /**
     * Build the permissions button, in native views.
     *
     * It has to be native. The site's WebView is layered over the Capacitor one
     * so that touch, focus and the soft keyboard need no forwarding, and that
     * same decision buries React's copy of it.
     *
     * Only the button is native. Pressing it is reported to React, which still
     * owns every panel: the permissions popover conceals the site and appears
     * over it, anchored to the React chrome in the same place.
     *
     * Returns null when there is no signer to have granted anything, because
     * an empty pill is a smudge over the corner of a page that has done
     * nothing to deserve one.
     */
    @Nullable
    private View buildPill(boolean hasSigner) {
        if (!hasSigner) return null;

        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(4), dp(4), dp(4), dp(4));

        GradientDrawable pill = new GradientDrawable();
        pill.setShape(GradientDrawable.RECTANGLE);
        // Tall enough that a fixed radius would round the ends differently
        // from the React pill; half the height is what `rounded-full` means.
        pill.setCornerRadius(dp(18));
        // Denser than the React pill's 60% black, which relies on a backdrop
        // blur to separate itself from the page. There is no blur behind a
        // native view, so the opacity has to do that work alone.
        pill.setColor(0xF2000000);
        pill.setStroke(dp(1), 0x1AFFFFFF);
        bar.setBackground(pill);

        bar.addView(button(
            R.drawable.ic_nsite_shield,
            0xFFFFFFFF,
            "Site permissions",
            () -> notifyListeners("nsitePermissions", new JSObject())
        ));

        return bar;
    }

    private ImageButton button(int icon, int tint, String label, Runnable onClick) {
        ImageButton view = new ImageButton(getContext());
        view.setImageResource(icon);
        view.setImageTintList(ColorStateList.valueOf(tint));
        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        view.setBackground(null);
        view.setContentDescription(label);
        view.setPadding(dp(7), dp(7), dp(7), dp(7));
        view.setOnClickListener(v -> onClick.run());

        // A 16dp glyph in a 30dp box, so the pill comes out the size of the
        // React one rather than merely in the same place.
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(30), dp(30)));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
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

        // Nothing an nsite is served comes from the device's own files.
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
                // Everything the document itself asks for. Its worker's
                // requests do not come through here — see NsiteServiceWorkers
                // — but both end up in the same router.
                return NsiteRequests.serve(getContext(), request);
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
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                Log.w(TAG, "Site failed to load " + request.getUrl() + ": " + error.getErrorCode() + " " + error.getDescription());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                notifyListeners("nsiteLoad", new JSObject());
                // The frame, not the WebView: the letterbox and the shield
                // come up with the picture, not before it.
                ViewGroup frame = container;
                if (frame != null) frame.animate().alpha(1f).setDuration(600).start();
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
