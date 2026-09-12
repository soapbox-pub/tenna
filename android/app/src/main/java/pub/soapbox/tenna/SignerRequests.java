package pub.soapbox.tenna;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.Browser;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.zip.GZIPOutputStream;

/**
 * Reading a {@code nostrsigner:} intent, and writing the answer back.
 *
 * <p>NIP-55 is two protocols wearing one URI scheme, and which one a request
 * is written in is not stated anywhere in the request. An app on the phone
 * puts its parameters in intent extras, because it can. A web page cannot set
 * extras, so it puts them in the URI's query string instead. Both arrive here
 * as {@code ACTION_VIEW} on {@code nostrsigner:<payload>} and the only thing
 * that tells them apart is {@link Browser#EXTRA_APPLICATION_ID}, which the
 * browser adds on the page's behalf. Miss that and every request from a web
 * page parses as a request with no type, no account and no payload.
 *
 * <p>Both spellings of two parameters are accepted — {@code pubKey}/{@code
 * pubkey} and {@code compression}/{@code compressionType} — because the
 * signer everyone wrote their client against accepts different ones on its two
 * paths, so real clients in the wild use all four.
 */
final class SignerRequests {

    private static final String SCHEME = "nostrsigner:";

    private SignerRequests() {}

    /** One requested permission out of a client's {@code permissions} extra. */
    static final class Requested {
        @NonNull final String permission;
        @Nullable final Integer kind;

        Requested(@NonNull String permission, @Nullable Integer kind) {
            this.permission = permission;
            this.kind = kind;
        }
    }

    /** Everything a {@code nostrsigner:} intent was carrying. */
    static final class Parsed {
        @NonNull final String id;
        @NonNull final SignerTypes.Method method;
        @NonNull final String payload;
        @Nullable final String peer;
        @Nullable final String currentUser;
        @Nullable final String callbackUrl;
        @NonNull final String appName;
        /** Whether the caller wants the whole event back rather than the signature. */
        final boolean returnEvent;
        /** Whether the caller wants that event gzipped. */
        final boolean gzip;
        @NonNull final List<Requested> permissions;

        Parsed(
            @NonNull String id,
            @NonNull SignerTypes.Method method,
            @NonNull String payload,
            @Nullable String peer,
            @Nullable String currentUser,
            @Nullable String callbackUrl,
            @NonNull String appName,
            boolean returnEvent,
            boolean gzip,
            @NonNull List<Requested> permissions
        ) {
            this.id = id;
            this.method = method;
            this.payload = payload;
            this.peer = peer;
            this.currentUser = currentUser;
            this.callbackUrl = callbackUrl;
            this.appName = appName;
            this.returnEvent = returnEvent;
            this.gzip = gzip;
            this.permissions = permissions;
        }

        @NonNull
        TennaSigning.Request toRequest() {
            return new TennaSigning.Request(method, payload, peer);
        }
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    /** What the intent asked for, or null if it did not ask for anything known. */
    @Nullable
    static Parsed parse(@Nullable Intent intent) {
        if (intent == null || intent.getData() == null) return null;

        String data = intent.getDataString();
        if (data == null || !data.startsWith(SCHEME)) return null;

        String raw = data.substring(SCHEME.length());
        boolean fromBrowser = intent.getStringExtra(Browser.EXTRA_APPLICATION_ID) != null;

        return fromBrowser ? fromQuery(raw, intent) : fromExtras(raw, intent);
    }

    /** An app on the phone: parameters are extras, the payload is the whole URI. */
    private static Parsed fromExtras(String raw, Intent intent) {
        SignerTypes.Method method = SignerTypes.fromWire(intent.getStringExtra("type"));
        if (method == null || !method.isNip55()) return null;

        String peer = intent.getStringExtra("pubKey");
        if (peer == null) peer = intent.getStringExtra("pubkey");

        return new Parsed(
            idOf(intent.getStringExtra("id")),
            method,
            decode(raw),
            peer,
            intent.getStringExtra("current_user"),
            intent.getStringExtra("callbackUrl"),
            name(intent.getStringExtra("appName"), intent.getStringExtra("callbackUrl")),
            "event".equals(intent.getStringExtra("returnType")),
            isGzip(intent.getStringExtra("compression")) || isGzip(intent.getStringExtra("compressionType")),
            requested(intent.getStringExtra("permissions"))
        );
    }

    /**
     * A web page: parameters are in the query string.
     *
     * <p>The payload runs up to the first {@code ?}, except that a NIP-04
     * ciphertext contains one of its own — {@code <base64>?iv=<base64>} — so a
     * parameter called {@code iv} is not a parameter at all and is handed back
     * to the payload it was cut off from.
     */
    private static Parsed fromQuery(String raw, Intent intent) {
        int split = raw.indexOf('?');
        StringBuilder payload = new StringBuilder(split < 0 ? raw : raw.substring(0, split));
        String query = split < 0 ? "" : raw.substring(split + 1);

        SignerTypes.Method method = null;
        String peer = null, callbackUrl = null, appName = null;
        boolean returnEvent = false, gzip = false;

        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;

            int equals = pair.indexOf('=');
            String name = equals < 0 ? pair : pair.substring(0, equals);
            String value = equals < 0 ? "" : pair.substring(equals + 1);

            if ("iv".equals(name)) {
                payload.append('?').append(name).append('=').append(value);
                continue;
            }

            switch (name) {
                case "type": method = SignerTypes.fromWire(decode(value)); break;
                case "pubKey":
                case "pubkey": peer = decode(value); break;
                case "callbackUrl": callbackUrl = decode(value); break;
                case "appName": appName = decode(value); break;
                case "returnType": returnEvent = "event".equals(decode(value)); break;
                case "compression":
                case "compressionType": gzip = isGzip(decode(value)); break;
                default: break;
            }
        }

        if (method == null || !method.isNip55()) return null;

        return new Parsed(
            idOf(intent.getStringExtra("id")),
            method,
            decode(payload.toString()),
            peer,
            intent.getStringExtra("current_user"),
            callbackUrl,
            name(appName, callbackUrl),
            returnEvent,
            gzip,
            // A query string carries no permission list. Nothing is missing:
            // a web caller is never auto-approved anyway, so a list of things
            // to pre-approve would have nothing to do.
            new ArrayList<>()
        );
    }

    /**
     * An id for this request, echoed back so a client can match answers to
     * questions. Clients that send several at once rely on it; ones that send
     * none get one anyway, since the drawer needs to tell them apart too.
     */
    private static String idOf(@Nullable String given) {
        return given == null || given.isEmpty() ? UUID.randomUUID().toString() : given;
    }

    private static boolean isGzip(@Nullable String value) {
        return "gzip".equals(value);
    }

    /** What to call the caller, when the caller offered something to call it. */
    private static String name(@Nullable String appName, @Nullable String callbackUrl) {
        if (appName != null && !appName.trim().isEmpty()) return appName.trim();
        if (callbackUrl != null && !callbackUrl.isEmpty()) {
            try {
                String host = Uri.parse(callbackUrl).getHost();
                if (host != null && !host.isEmpty()) return host;
            } catch (Exception e) {
                // Not a URL. Nothing to name it after.
            }
        }
        return "";
    }

    /**
     * Percent-decode, if it looks percent-encoded.
     *
     * <p>A web client sends {@code encodeURIComponent(json)}; an app sends the
     * JSON. Decoding the second would corrupt any payload containing a literal
     * {@code %}, so it is only done when there is an escape in there to
     * decode. A {@code +} is protected on the way through, because base64 is
     * full of them and form decoding would turn every one into a space.
     */
    @NonNull
    private static String decode(@NonNull String value) {
        if (!looksEncoded(value)) return value;
        try {
            return URLDecoder.decode(value.replace("+", "%2B"), "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    private static boolean looksEncoded(String value) {
        for (int i = 0; i + 2 < value.length(); i++) {
            if (value.charAt(i) == '%' && isHex(value.charAt(i + 1)) && isHex(value.charAt(i + 2))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isHex(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }

    /**
     * The permissions a client asked to be pre-approved, as
     * {@code [{"type":"sign_event","kind":1}, …]}.
     *
     * <p>Only a hint about what to offer. Nothing is granted by asking.
     */
    @NonNull
    static List<Requested> requested(@Nullable String json) {
        List<Requested> permissions = new ArrayList<>();
        if (json == null || json.isEmpty()) return permissions;

        try {
            JSONArray array = new JSONArray(json);
            for (int i = 0; i < array.length(); i++) {
                JSONObject entry = array.optJSONObject(i);
                if (entry == null) continue;

                SignerTypes.Method method = SignerTypes.fromWire(entry.optString("type", ""));
                if (method == null || method.permission == null) continue;

                Integer kind = null;
                if (method == SignerTypes.Method.SIGN_EVENT
                        && entry.has("kind") && !entry.isNull("kind")) {
                    kind = entry.optInt("kind");
                }

                // A blanket request to sign anything is not something a list
                // like this gets to ask for; it has to name the kinds.
                if (method == SignerTypes.Method.SIGN_EVENT && kind == null) continue;

                permissions.add(new Requested(method.permission, kind));
            }
        } catch (Exception e) {
            return new ArrayList<>();
        }
        return permissions;
    }

    // ── Writing the answer ───────────────────────────────────────────────────

    /**
     * The intent a client gets back when it is answered.
     *
     * <p>{@code result} and {@code signature} carry the same value: the first
     * is what NIP-55 says, the second is what clients written against the
     * original signer read. Sending both costs a string and saves an argument
     * with every client author.
     */
    @NonNull
    static Intent success(@NonNull Parsed parsed, @NonNull String value,
                          @Nullable String eventJson, @NonNull String ownPackage) {
        Intent result = new Intent();
        result.putExtra("result", value);
        result.putExtra("signature", value);
        result.putExtra("id", parsed.id);
        if (eventJson != null) result.putExtra("event", eventJson);

        // Only on the way out of `get_public_key`, which is where a client
        // learns which signer it has been talking to and who to address next.
        if (parsed.method == SignerTypes.Method.GET_PUBLIC_KEY) {
            result.putExtra("package", ownPackage);
        }
        return result;
    }

    /**
     * The intent a client gets back when the user says no.
     *
     * <p>Deliberately {@link Activity#RESULT_OK} with a flag, not
     * {@code RESULT_CANCELED}. NIP-55 reserves a failed result code for the
     * signer having broken, so that a client can tell "you may not" from "I
     * crashed" — and only the first of those means stop asking.
     */
    @NonNull
    static Intent rejection(@NonNull Parsed parsed) {
        Intent result = new Intent();
        result.putExtra("rejected", true);
        result.putExtra("id", parsed.id);
        return result;
    }

    /**
     * Where to send a web client that gave a callback.
     *
     * <p>The value is concatenated onto the URL the client supplied, which is
     * expected to end in its own {@code ?x=}. Null when it gave no callback,
     * in which case there is nowhere to send it.
     */
    @Nullable
    static Uri callback(@NonNull Parsed parsed, @NonNull String value, @Nullable String eventJson) {
        if (parsed.callbackUrl == null || parsed.callbackUrl.isEmpty()) return null;

        String body = value;
        if (parsed.returnEvent && eventJson != null) {
            body = parsed.gzip ? packed(eventJson) : eventJson;
        }

        try {
            return Uri.parse(parsed.callbackUrl + Uri.encode(body));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * An event small enough to survive a URL.
     *
     * <p>{@code Signer1} then base64 of the gzipped JSON — the shape NIP-55
     * specifies, and the marker is how the client knows to unpack rather than
     * parse. A URL has a length limit and a signed event with a few tags does
     * not respect it.
     */
    @NonNull
    private static String packed(@NonNull String eventJson) {
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            try (GZIPOutputStream gzip = new GZIPOutputStream(bytes)) {
                gzip.write(eventJson.getBytes(StandardCharsets.UTF_8));
            }
            return "Signer1" + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            // Better an answer that is too long than no answer at all.
            return eventJson;
        }
    }
}
