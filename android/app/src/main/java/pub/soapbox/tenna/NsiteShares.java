package pub.soapbox.tenna;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * A share on its way from the OS to an nsite, parked on disk in between.
 *
 * Two things force this to exist rather than the payload simply riding along
 * in an intent. The first is size: an intent is a binder transaction, capped
 * at about a megabyte for the whole process, and a shared photo is not going
 * to fit. The second is time: {@code content://} streams are readable only
 * while the grant the receiving activity was started with is alive, so the
 * bytes must be copied out at once, before anything else is decided.
 *
 * So {@link NsiteShareActivity} stages the share the moment it arrives and
 * passes on nothing but a token. The token names a directory; the directory
 * holds the text fields and one file per stream. The site reads the files back
 * over its own origin, one URL each, and the whole directory is deleted as
 * soon as the share has been handed over or refused.
 */
final class NsiteShares {

    private static final String TAG = "NsiteShares";

    private static final String DIRECTORY = "share";

    /** The text fields, beside the files they came with. */
    private static final String PAYLOAD = "payload.json";

    /** Which site the share was given to, and the form it is to arrive as. */
    private static final String DELIVERY = "delivery.json";

    /** Ceiling on one share, past which the OS is not being reasonable. */
    private static final int MAX_FILES = 10;

    /** Ceiling on one file. A share bigger than this is not a share. */
    private static final long MAX_BYTES = 256L * 1024L * 1024L;

    /** How long a staged share may sit unclaimed before it is swept. */
    private static final long MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    private static final SecureRandom RANDOM = new SecureRandom();

    private NsiteShares() {}

    /** What arrived, with the bytes left where they were written. */
    static final class Payload {
        @Nullable final String title;
        @Nullable final String text;
        final List<StagedFile> files;

        Payload(@Nullable String title, @Nullable String text, List<StagedFile> files) {
            this.title = title;
            this.text = text;
            this.files = files;
        }
    }

    /** One file, named by its place in the directory rather than by its name. */
    static final class StagedFile {
        final int index;
        /** The name the sender gave it. Never used as a path — see {@link #file}. */
        final String name;
        final String type;
        final long size;

        StagedFile(int index, String name, String type, long size) {
            this.index = index;
            this.name = name;
            this.type = type;
            this.size = size;
        }
    }

    // -----------------------------------------------------------------------

    /**
     * Copy a share out of the intent it arrived in, and return its token.
     *
     * Returns null if there was nothing in it worth carrying. Everything
     * readable is taken; a stream that cannot be opened is skipped rather than
     * failing the share, since a sender offering four pictures and revoking one
     * should still get three delivered.
     */
    @Nullable
    static String stage(@NonNull Context context, @NonNull Intent intent) {
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);

        List<Uri> streams = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            List<Uri> extra = uris(intent);
            if (extra != null) streams.addAll(extra);
        } else {
            Uri single = uri(intent);
            if (single != null) streams.add(single);
        }

        if (TextUtils.isEmpty(text) && TextUtils.isEmpty(title) && streams.isEmpty()) return null;

        String token = token();
        File dir = new File(directory(context), token);
        if (!dir.mkdirs()) {
            Log.w(TAG, "Could not make a staging directory");
            return null;
        }

        JSONArray files = new JSONArray();
        int index = 0;

        for (Uri stream : streams) {
            if (index >= MAX_FILES) break;
            JSONObject staged = copy(context, stream, dir, index);
            if (staged == null) continue;
            files.put(staged);
            index++;
        }

        try {
            JSONObject json = new JSONObject();
            if (!TextUtils.isEmpty(title)) json.put("title", title);
            if (!TextUtils.isEmpty(text)) json.put("text", text);
            json.put("files", files);
            write(new File(dir, PAYLOAD), json.toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException | IOException e) {
            Log.w(TAG, "Could not stage the share", e);
            release(context, token);
            return null;
        }

        return token;
    }

    /** Read back what was staged, or null if the token names nothing. */
    @Nullable
    static Payload load(@NonNull Context context, @NonNull String token) {
        File dir = directory(context, token);
        if (dir == null) return null;

        try {
            JSONObject json = new JSONObject(
                new String(readFully(new File(dir, PAYLOAD)), StandardCharsets.UTF_8)
            );

            List<StagedFile> files = new ArrayList<>();
            JSONArray array = json.optJSONArray("files");
            for (int i = 0; array != null && i < array.length(); i++) {
                JSONObject file = array.optJSONObject(i);
                if (file == null) continue;
                files.add(new StagedFile(
                    file.optInt("index", i),
                    file.optString("name", "file"),
                    file.optString("type", "application/octet-stream"),
                    file.optLong("size", 0)
                ));
            }

            return new Payload(
                json.optString("title", null),
                json.optString("text", null),
                files
            );
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /**
     * Give a staged share to one site, in one shape.
     *
     * Written down rather than held in memory because the two readers are far
     * apart: this is called when the site's window opens, and read again from
     * {@code shouldInterceptRequest} on a background thread, possibly after the
     * WebView has been rebuilt.
     *
     * The site id is the important half. A share is delivered over the site's
     * own origin, so binding it to one site is what makes a stray request from
     * a second site — which would have to guess the token first — answerable
     * with a flat no rather than with somebody's photograph.
     */
    static void claim(
        @NonNull Context context,
        @NonNull String token,
        @NonNull String siteId,
        @Nullable String plan
    ) {
        File dir = directory(context, token);
        if (dir == null) return;

        try {
            JSONObject json = new JSONObject();
            json.put("siteId", siteId);
            if (plan != null) json.put("plan", plan);
            write(new File(dir, DELIVERY), json.toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException | IOException e) {
            Log.w(TAG, "Could not record the share's destination", e);
        }
    }

    /** What a claimed share is, or null if nothing has claimed it. */
    @Nullable
    static Delivery delivery(@NonNull Context context, @NonNull String token) {
        File dir = directory(context, token);
        if (dir == null) return null;

        try {
            JSONObject json = new JSONObject(
                new String(readFully(new File(dir, DELIVERY)), StandardCharsets.UTF_8)
            );
            String siteId = json.optString("siteId", null);
            if (siteId == null) return null;
            return new Delivery(siteId, json.optString("plan", null));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /** Where a claimed share is going, and as what. */
    static final class Delivery {
        final String siteId;
        /** The form the bootstrap page is to build, as JSON text. */
        @Nullable final String plan;

        Delivery(String siteId, @Nullable String plan) {
            this.siteId = siteId;
            this.plan = plan;
        }
    }

    /**
     * The bytes of one staged file, for the site it was given to.
     *
     * The index is the file's position, not a name the sender chose, so no
     * string from outside ever reaches a path — the same reason a site's
     * record is named by a hash rather than by its {@code d} tag.
     */
    @Nullable
    static File file(
        @NonNull Context context,
        @NonNull String token,
        @NonNull String siteId,
        int index
    ) {
        Delivery delivery = delivery(context, token);
        if (delivery == null || !delivery.siteId.equals(siteId)) return null;

        File dir = directory(context, token);
        if (dir == null || index < 0 || index >= MAX_FILES) return null;
        File file = new File(dir, index + ".bin");
        return file.exists() ? file : null;
    }

    /** Throw a staged share away. */
    static void release(@NonNull Context context, @Nullable String token) {
        if (token == null) return;
        File dir = directory(context, token);
        if (dir != null) delete(dir);
    }

    /**
     * Delete every share nobody came back for.
     *
     * A share is staged before the user has decided anything, so one abandoned
     * at the picker leaves a directory behind. Run when the app starts, which
     * is often enough for something capped at a day.
     */
    static void sweep(@NonNull Context context) {
        File[] dirs = directory(context).listFiles();
        if (dirs == null) return;

        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        for (File dir : dirs) {
            if (dir.lastModified() < cutoff) delete(dir);
        }
    }

    // -----------------------------------------------------------------------

    /**
     * Copy one stream into the staging directory.
     *
     * The display name is recorded so the site sees the file called what the
     * sender called it, but it is metadata and nothing more: the file on disk
     * is named after its index.
     */
    @Nullable
    private static JSONObject copy(Context context, Uri uri, File dir, int index) {
        ContentResolver resolver = context.getContentResolver();
        String name = displayName(resolver, uri);
        String type = type(resolver, uri, name);

        long size = 0;
        try (InputStream in = resolver.openInputStream(uri);
             OutputStream out = new FileOutputStream(new File(dir, index + ".bin"))) {
            if (in == null) return null;

            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                size += read;
                if (size > MAX_BYTES) {
                    Log.w(TAG, "Refusing a shared file over the size cap");
                    return null;
                }
                out.write(buffer, 0, read);
            }
        } catch (IOException | SecurityException e) {
            // A revoked grant, or a provider that changed its mind. The rest of
            // the share is still worth delivering.
            Log.w(TAG, "Could not read a shared stream", e);
            return null;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("index", index);
            json.put("name", name);
            json.put("type", type);
            json.put("size", size);
            return json;
        } catch (JSONException e) {
            return null;
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0) {
                        String name = cursor.getString(column);
                        if (!TextUtils.isEmpty(name)) return name;
                    }
                }
            } catch (RuntimeException e) {
                // Providers are third-party code and throw whatever they like.
            }
        }

        String last = uri.getLastPathSegment();
        return TextUtils.isEmpty(last) ? "file" : last;
    }

    private static String type(ContentResolver resolver, Uri uri, String name) {
        String type = resolver.getType(uri);
        if (!TextUtils.isEmpty(type)) return type;

        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String guess = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
            if (!TextUtils.isEmpty(guess)) return guess;
        }

        return "application/octet-stream";
    }

    @Nullable
    @SuppressWarnings("deprecation")
    private static Uri uri(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @Nullable
    @SuppressWarnings("deprecation")
    private static List<Uri> uris(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    /** 128 random bits in hex. Guessing one buys nothing anyway — see below. */
    private static String token() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    private static File directory(Context context) {
        File dir = new File(context.getCacheDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /**
     * The directory a token names, or null if the token is not one.
     *
     * A token reaches here from a URL an nsite's page requested, so it is
     * checked against its own alphabet before it is joined to a path. Nothing
     * else is trusted about it.
     */
    @Nullable
    private static File directory(Context context, String token) {
        if (!token.matches("[0-9a-f]{32}")) return null;
        File dir = new File(directory(context), token);
        return dir.isDirectory() ? dir : null;
    }

    private static void delete(File dir) {
        File[] files = dir.listFiles();
        if (files != null) {
            for (File file : files) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
        //noinspection ResultOfMethodCallIgnored
        dir.delete();
    }

    private static void write(File destination, byte[] bytes) throws IOException {
        try (OutputStream out = new FileOutputStream(destination)) {
            out.write(bytes);
        }
    }

    private static byte[] readFully(File file) throws IOException {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }
}
