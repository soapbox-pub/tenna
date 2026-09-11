package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.regex.Pattern;

/**
 * What a blob is allowed to be called, and what it is allowed to contain.
 *
 * The Java side of the same rule in {@code src/lib/nsiteFiles.ts}, and the one
 * place either half of the app decides it.
 *
 * A manifest's sha256 is a string off a stranger's event tag that this app
 * then uses as a path — the tail of a Blossom URL on the way out, the name of
 * a file in the shared cache on the way back. Both readings are dangerous if
 * the string is not what it claims to be: {@code ../../shared_prefs/foo.xml}
 * is a perfectly good map key and a perfectly good traversal out of the cache
 * directory into the app's private storage, which the site would then be
 * served from its own origin and could read at its leisure.
 *
 * So a name is thirty-two bytes of lowercase hex or it is not a name.
 */
final class NsiteBlobs {

    private static final Pattern NAME = Pattern.compile("^[0-9a-f]{64}$");

    private NsiteBlobs() {}

    /** Whether a manifest's sha256 is a name a blob can actually have. */
    static boolean isName(@Nullable String value) {
        return value != null && NAME.matcher(value).matches();
    }

    /** Whether a manifest's path is one a request could ask for. */
    static boolean isPath(@Nullable String value) {
        return value != null && value.startsWith("/");
    }

    /** Lowercase hex for a digest. */
    @NonNull
    static String hex(@NonNull byte[] digest) {
        StringBuilder out = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16));
            out.append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }
}
