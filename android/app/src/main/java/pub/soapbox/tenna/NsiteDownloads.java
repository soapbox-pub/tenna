package pub.soapbox.tenna;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Saving a file a site offered.
 *
 * A site's window has no downloads shelf and no folder of its own, so a
 * download here is the two things a download anywhere is, made explicit: the
 * user says where it goes, and then the bytes go there.
 *
 * <p><b>Where.</b> The system's own create-document picker, rather than
 * writing into the device's Downloads folder. Below Android 10 the latter
 * would mean holding {@code WRITE_EXTERNAL_STORAGE} — a permission over every
 * file on the device, asked for so that a site can save one — and this module
 * still runs as far back as 24. The picker needs no permission on any version,
 * and it makes the destination the user's rather than the site's, which is the
 * right shape for a file a page asked to write.
 *
 * <p><b>The bytes.</b> Almost nothing a web app downloads can be fetched from
 * native code. A {@code blob:} URL exists only in the renderer that made it;
 * the site's own files are behind its service worker. So they are read from
 * inside the page, by {@code res/raw/nsite_download.js}, and posted out here
 * a piece at a time — each one written before the next is asked for, so that
 * a large file is never queued up in memory in base64 waiting on the disk.
 *
 * <p>A URL somewhere else entirely is not read at all. Fetching it from the
 * page would be a cross-origin request the site has no right to make, and the
 * device already knows what to do with a link to another site: it goes to the
 * browser, the same as any other link out of a window. See
 * {@link NsiteWebViewPlugin}'s handling of navigations.
 */
final class NsiteDownloads implements DownloadListener {

    private static final String TAG = "NsiteDownloads";

    /** Injected object name the reader script posts through. */
    private static final String HOST_OBJECT = "tennaDownloadHost";

    private static final String TOKEN_PLACEHOLDER = "%%TENNA_DOWNLOAD_TOKEN%%";
    private static final String URL_PLACEHOLDER = "%%TENNA_DOWNLOAD_URL%%";

    /** What the reader is told when a piece has been written and another may come. */
    private static final String ACK = "ok";

    /** What a download with no type of its own is created as. */
    private static final String UNTYPED = "application/octet-stream";

    /** As long a name as any filesystem the picker might land on will take. */
    private static final int MAX_NAME = 200;

    /** Where a link to another origin goes instead of being read. */
    interface HandOff {
        void open(@NonNull String url);
    }

    private final Activity activity;
    private final WebView webView;

    /** The site's own host; only its URLs and its blobs are read from the page. */
    private final String host;

    private final NsiteChromeClient.Launcher launcher;
    private final HandOff handOff;

    private final Handler main = new Handler(Looper.getMainLooper());

    /**
     * One thread, for the writing.
     *
     * Every piece arrives on the main thread — a web message listener has no
     * other — and a file is not something to write there. One thread rather
     * than a pool because the pieces of a file are ordered, and there is only
     * ever one file.
     */
    private final ExecutorService writer = Executors.newSingleThreadExecutor();

    /** How to answer the reader script, once it has said anything. */
    @Nullable private JavaScriptReplyProxy proxy;

    /** The download being written, or null between them. */
    @Nullable private Transfer transfer;

    /**
     * Whether a download is in hand at all.
     *
     * Wider than {@link #transfer}, which only exists once there is a file to
     * write into. This covers the asking and the picker too, so that a site
     * firing two downloads at once cannot put two pickers on screen.
     */
    private boolean busy;

    /**
     * Whether the window has gone.
     *
     * A picker put up for a site can outlive it — the user may close the site
     * from the picker's own task — and its result would otherwise reach a
     * WebView that has been destroyed.
     */
    private boolean released;

    private int nextToken = 1;

    /** A file being written, and the page pouring into it. */
    private static final class Transfer {
        final String token;
        final Uri destination;
        final OutputStream out;
        long written;

        Transfer(String token, Uri destination, OutputStream out) {
            this.token = token;
            this.destination = destination;
            this.out = out;
        }
    }

    @MainThread
    NsiteDownloads(
        @NonNull Activity activity,
        @NonNull WebView webView,
        @NonNull String host,
        @NonNull String origin,
        @NonNull NsiteChromeClient.Launcher launcher,
        @NonNull HandOff handOff
    ) {
        this.activity = activity;
        this.webView = webView;
        this.host = host;
        this.launcher = launcher;
        this.handOff = handOff;

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Without a way back out of the page there is nothing to read a
            // blob with, and a download would open a picker and then hang.
            Log.w(TAG, "No web message listener; this site cannot save files");
            return;
        }

        Set<String> allowed = Collections.singleton(origin);
        WebViewCompat.addWebMessageListener(webView, HOST_OBJECT, allowed, (v, message, sourceOrigin, isMainFrame, replyProxy) -> {
            if (!isMainFrame) return;
            proxy = replyProxy;
            String data = message.getData();
            if (data != null) onMessage(data);
        });
    }

    /** Stop writing and close whatever is open. The window is going away. */
    @MainThread
    void release() {
        released = true;
        abort(null);
        writer.shutdown();
    }

    // -----------------------------------------------------------------------
    // Starting one
    // -----------------------------------------------------------------------

    /**
     * A navigation the WebView decided was a file rather than a page.
     *
     * Chromium only raises this for something the user set in motion, so there
     * is no gesture to check — unlike a link out, which a page can attempt on
     * its own.
     */
    @Override
    @MainThread
    public void onDownloadStart(
        String url,
        String userAgent,
        String contentDisposition,
        String mimeType,
        long contentLength
    ) {
        if (url == null) return;

        if (!readableFromPage(url)) {
            // Another origin's file. The device knows where those go.
            handOff.open(url);
            return;
        }

        if (busy) {
            // One at a time. A site that fires two at once gets the first;
            // the alternative is a picker opening over a picker.
            Log.w(TAG, "A download is already in hand; ignoring another");
            return;
        }
        busy = true;

        // Asked rather than guessed: see `askName`. The picker waits for the
        // answer, which is a round trip to a page that is not doing anything
        // else — the click that started this was the last thing it did.
        askName(url, contentDisposition, mimeType, name -> offer(url, name));
    }

    /** Put the save-as picker up for a file the page is about to hand over. */
    @MainThread
    private void offer(@NonNull String url, @NonNull String name) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(type(name))
            .putExtra(Intent.EXTRA_TITLE, name);

        boolean opened = launcher.launch(intent, (resultCode, data) -> {
            Uri destination = resultCode == Activity.RESULT_OK && data != null ? data.getData() : null;
            // A cancelled picker is a download that never happened. Nothing
            // has been asked of the page yet, so there is nothing to unwind.
            if (destination == null) busy = false;
            else begin(destination, url);
        });

        if (!opened) {
            Log.w(TAG, "Nothing on the device can make a file to save into");
            busy = false;
        }
    }

    /**
     * What the page called the file, or the best guess if it didn't say.
     *
     * {@code <a download="notes.txt">} does not reach a download listener.
     * Chromium reports the {@code Content-Disposition} header, and a
     * {@code blob:} URL has no headers at all — so {@code guessFileName} falls
     * back to the URL's last path segment, which for a blob is the UUID the
     * browser made up. Every file a web app exported would be saved under one.
     *
     * So the page is asked. The anchor that started this is still in its
     * document, and its {@code download} attribute is the name the site meant.
     * The answer is a string a page chose and is treated as one — see
     * {@link #sanitize}.
     */
    @MainThread
    private void askName(
        @NonNull String url,
        @Nullable String contentDisposition,
        @Nullable String mimeType,
        @NonNull ValueCallback<String> then
    ) {
        final String guess = name(url, contentDisposition, mimeType);

        webView.evaluateJavascript(
            NAME_SCRIPT.replace(URL_PLACEHOLDER, JSONObject.quote(url)),
            value -> {
                if (released) return;
                String declared = sanitize(text(value));
                then.onReceiveValue(declared == null ? guess : declared);
            }
        );
    }

    /**
     * The name the site gave the link that is being downloaded.
     *
     * Backwards, because a page that builds a link to click and throws it away
     * appends it last, and because a stale one left in the document from an
     * earlier export would otherwise answer for this one.
     */
    private static final String NAME_SCRIPT =
        "(function () {"
        + "  var links = document.querySelectorAll('a[download]');"
        + "  for (var i = links.length - 1; i >= 0; i--) {"
        + "    if (links[i].href === " + URL_PLACEHOLDER + ") return links[i].getAttribute('download');"
        + "  }"
        + "  return null;"
        + "})()";

    /** The string an {@code evaluateJavascript} result carries, if it is one. */
    @Nullable
    private static String text(@Nullable String value) {
        if (value == null) return null;
        try {
            Object parsed = new JSONTokener(value).nextValue();
            return parsed instanceof String ? (String) parsed : null;
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * A name the page chose, made fit to be a file's.
     *
     * A separator would make it a path, and a path is somewhere the page was
     * not offered — the picker takes this as the name to put in whatever
     * folder the user lands on. The rest is ordinary hygiene: no control
     * characters, nothing that names a directory, and short enough that a
     * filesystem will take it.
     */
    @Nullable
    private static String sanitize(@Nullable String declared) {
        if (declared == null) return null;

        String clean = declared.replaceAll("[\\\\/\\p{Cntrl}]", "_").trim();
        if (clean.isEmpty() || clean.equals(".") || clean.equals("..")) return null;

        return clean.length() > MAX_NAME ? clean.substring(0, MAX_NAME) : clean;
    }

    /**
     * Whether the page is the only thing that can read this URL.
     *
     * A {@code blob:} is the page's own object and exists nowhere else. A
     * {@code data:} carries its bytes in the URL, and is read the same way for
     * want of a reason to write a second path. The site's own files could in
     * principle be resolved against its manifest here, but they are served
     * through its service worker, and a worker that rewrote or generated the
     * response would be bypassed — so they are fetched the way the site itself
     * would fetch them.
     */
    private boolean readableFromPage(@NonNull String url) {
        Uri parsed = Uri.parse(url);
        String scheme = parsed.getScheme();
        if (scheme == null) return false;

        switch (scheme.toLowerCase(Locale.ROOT)) {
            case "blob":
            case "data":
                return true;
            case "https":
                return host.equalsIgnoreCase(parsed.getHost());
            default:
                return false;
        }
    }

    /** Open the file the user made, and set the page reading. */
    @MainThread
    private void begin(@NonNull Uri destination, @NonNull String url) {
        // The window closed while the picker was up. The file the user made is
        // theirs and is left alone; nothing was ever written into it.
        if (released) return;

        String script = reader(activity);
        if (script == null) {
            Log.w(TAG, "The download reader is missing; nothing can be saved");
            busy = false;
            return;
        }

        OutputStream opened;
        try {
            opened = activity.getContentResolver().openOutputStream(destination, "wt");
        } catch (Exception e) {
            Log.w(TAG, "Could not open " + destination + " to write", e);
            opened = null;
        }
        if (opened == null) {
            Log.w(TAG, "Could not open " + destination + " to write");
            busy = false;
            return;
        }
        final OutputStream out = opened;

        String token = "d" + (nextToken++);
        transfer = new Transfer(token, destination, out);

        webView.evaluateJavascript(
            script
                .replace(TOKEN_PLACEHOLDER, JSONObject.quote(token))
                .replace(URL_PLACEHOLDER, JSONObject.quote(url)),
            null
        );
    }

    // -----------------------------------------------------------------------
    // Writing it
    // -----------------------------------------------------------------------

    @MainThread
    private void onMessage(@NonNull String data) {
        Transfer current = transfer;
        if (current == null) return;

        final JSONObject message;
        try {
            message = new JSONObject(data);
        } catch (JSONException ignored) {
            // Not the reader's.
            return;
        }

        // The reader script runs in the site's page, so the site can post here
        // too. A message that doesn't name the download in flight is not the
        // reader's and is dropped — which leaves a site able to say things
        // about its own download and nothing else.
        if (!current.token.equals(message.optString("token"))) return;

        String error = message.optString("error", null);
        if (error != null) {
            Log.w(TAG, "The page could not read what it offered: " + error);
            abort(current);
            return;
        }

        if (message.optBoolean("done", false)) {
            finish(current);
            return;
        }

        String piece = message.optString("data", null);
        if (piece == null) return;

        final byte[] bytes;
        try {
            bytes = Base64.decode(piece, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "The page sent something that was not a piece of a file", e);
            abort(current);
            return;
        }

        writer.execute(() -> {
            try {
                current.out.write(bytes);
            } catch (IOException e) {
                main.post(() -> {
                    Log.w(TAG, "Could not write to " + current.destination, e);
                    abort(current);
                });
                return;
            }
            // Only now: the reader waits for this before reading any more, so
            // acknowledging early would be the queue this exists to avoid.
            main.post(() -> {
                if (transfer != current) return;
                current.written += bytes.length;
                acknowledge();
            });
        });
    }

    /** Tell the reader the last piece landed and another may come. */
    @MainThread
    private void acknowledge() {
        JavaScriptReplyProxy replyProxy = proxy;
        if (replyProxy != null) replyProxy.postMessage(ACK);
    }

    @MainThread
    private void finish(@NonNull Transfer current) {
        if (transfer != current) return;
        transfer = null;
        busy = false;

        writer.execute(() -> {
            try {
                current.out.close();
            } catch (IOException e) {
                Log.w(TAG, "Could not close " + current.destination, e);
            }
        });

        Log.i(TAG, "Saved " + current.written + " bytes to " + current.destination);
    }

    /**
     * Give up on a download, leaving no half a file behind.
     *
     * The document was made by the picker a moment ago and has nothing in it
     * but what this was writing, so removing it is removing this attempt — not
     * touching anything of the user's. A device that won't delete it leaves a
     * short file, which is still better than a plausible one.
     */
    @MainThread
    private void abort(@Nullable Transfer only) {
        Transfer current = transfer;
        if (current == null || (only != null && only != current)) return;
        transfer = null;
        busy = false;

        // Not `writer.execute`: this runs on the way out of the window too,
        // after the executor has been shut down.
        try {
            current.out.close();
        } catch (IOException ignored) {
            // Going away regardless.
        }

        ContentResolver resolver = activity.getContentResolver();
        try {
            DocumentsContract.deleteDocument(resolver, current.destination);
        } catch (Exception e) {
            Log.w(TAG, "Left an incomplete " + current.destination + " behind", e);
        }
    }

    // -----------------------------------------------------------------------
    // Naming it
    // -----------------------------------------------------------------------

    /** What the file is called: what the site said, or what the URL implies. */
    @NonNull
    private static String name(
        @NonNull String url,
        @Nullable String contentDisposition,
        @Nullable String mimeType
    ) {
        try {
            return URLUtil.guessFileName(url, contentDisposition, mimeType);
        } catch (Exception e) {
            // A blob URL with nothing to go on: the guess is `downloadfile`,
            // but it has been known to throw on a malformed disposition.
            return "download";
        }
    }

    /**
     * The type the document is created as.
     *
     * Read off the name, and never off what the site declared, because the two
     * have to agree. A provider handed a name whose extension does not match
     * the type renames the file to match it — so a site offering a
     * {@code .excalidraw} as {@code application/json} would have {@code .json}
     * put on the end of the name the user was just shown in the picker, and
     * would get {@code My Drawing.excalidraw.json}.
     *
     * An extension the device does not know is {@code application/octet-stream}
     * — which is the answer the provider derives for it too, so the two agree
     * and the name is left exactly as the site wrote it.
     */
    @NonNull
    private static String type(@NonNull String name) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(name);
        String known = extension == null || extension.isEmpty()
            ? null
            : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));

        return known == null ? UNTYPED : known;
    }

    /** The reader script, read off the app once and kept. */
    @Nullable
    private static synchronized String reader(@NonNull Context context) {
        if (readerLoaded) return reader;
        readerLoaded = true;

        try (InputStream in = context.getResources().openRawResource(R.raw.nsite_download)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            reader = new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "The download reader is unreadable; nothing can be saved", e);
        }

        return reader;
    }

    @Nullable private static String reader;
    private static boolean readerLoaded;
}
