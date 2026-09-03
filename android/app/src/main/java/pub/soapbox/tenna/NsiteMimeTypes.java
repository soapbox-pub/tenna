package pub.soapbox.tenna;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * MIME type lookup for files served out of an nsite manifest.
 *
 * Mirrors {@code src/lib/sandbox/mimeTypes.ts}. Manifest paths carry no
 * content type of their own — the sha256 is all Blossom knows about a blob —
 * so the extension is the only signal either implementation has.
 */
final class NsiteMimeTypes {

    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("htm", "text/html");
        TYPES.put("css", "text/css");
        TYPES.put("js", "application/javascript");
        TYPES.put("mjs", "application/javascript");
        TYPES.put("json", "application/json");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("jpeg", "image/jpeg");
        TYPES.put("gif", "image/gif");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("webp", "image/webp");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("bmp", "image/bmp");
        TYPES.put("avif", "image/avif");
        TYPES.put("woff", "font/woff");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("ttf", "font/ttf");
        TYPES.put("otf", "font/otf");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("wav", "audio/wav");
        TYPES.put("opus", "audio/opus");
        TYPES.put("weba", "audio/webm");
        TYPES.put("mp4", "video/mp4");
        TYPES.put("webm", "video/webm");
        TYPES.put("xml", "application/xml");
        TYPES.put("txt", "text/plain");
        TYPES.put("md", "text/markdown");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("pdf", "application/pdf");
        TYPES.put("toml", "application/toml");
    }

    private NsiteMimeTypes() {}

    static String of(String path) {
        int dot = path.lastIndexOf('.');
        if (dot == -1) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase(Locale.ROOT);
        String type = TYPES.get(ext);
        return type != null ? type : "application/octet-stream";
    }

    /**
     * The charset to declare, or null for binary.
     *
     * {@code WebResourceResponse} keeps the MIME type and the encoding in
     * separate fields, and passing a charset for a binary type makes Chromium
     * refuse the response.
     */
    static String encodingFor(String mimeType) {
        if (mimeType.startsWith("text/")) return "UTF-8";
        switch (mimeType) {
            case "application/javascript":
            case "application/json":
            case "application/xml":
            case "application/toml":
            case "image/svg+xml":
                return "UTF-8";
            default:
                return null;
        }
    }
}
