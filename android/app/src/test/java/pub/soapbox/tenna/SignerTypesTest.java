package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The dialects three transports speak, and that they all land on the same
 * method.
 *
 * <p>Worth testing because the failure is quiet. A method string that does not
 * match sends the caller down the "unknown method" path, which for the content
 * resolver is an empty cursor — indistinguishable from "ask the user" — so a
 * one-character typo in a wire name reads as a signer that simply never
 * remembers anything.
 */
public class SignerTypesTest {

    @Test
    public void readsEveryNip55MethodName() {
        assertEquals(SignerTypes.Method.GET_PUBLIC_KEY, SignerTypes.fromWire("get_public_key"));
        assertEquals(SignerTypes.Method.SIGN_EVENT, SignerTypes.fromWire("sign_event"));
        assertEquals(SignerTypes.Method.NIP04_ENCRYPT, SignerTypes.fromWire("nip04_encrypt"));
        assertEquals(SignerTypes.Method.NIP04_DECRYPT, SignerTypes.fromWire("nip04_decrypt"));
        assertEquals(SignerTypes.Method.NIP44_ENCRYPT, SignerTypes.fromWire("nip44_encrypt"));
        assertEquals(SignerTypes.Method.NIP44_DECRYPT, SignerTypes.fromWire("nip44_decrypt"));
        assertEquals(SignerTypes.Method.DECRYPT_ZAP_EVENT, SignerTypes.fromWire("decrypt_zap_event"));
    }

    @Test
    public void readsTheNip46OnlyMethods() {
        assertEquals(SignerTypes.Method.CONNECT, SignerTypes.fromWire("connect"));
        assertEquals(SignerTypes.Method.PING, SignerTypes.fromWire("ping"));
        assertEquals(SignerTypes.Method.SWITCH_RELAYS, SignerTypes.fromWire("switch_relays"));
        assertEquals(SignerTypes.Method.LOGOUT, SignerTypes.fromWire("logout"));
    }

    @Test
    public void refusesAMethodItDoesNotKnow() {
        assertNull(SignerTypes.fromWire("sign_psbt"));
        assertNull(SignerTypes.fromWire("nip44v3_encrypt"));
        assertNull(SignerTypes.fromWire(""));
        assertNull(SignerTypes.fromWire(null));
    }

    /**
     * The authority carries the build's own application id, which differs
     * between the debug and release builds, so only the suffix can be matched.
     */
    @Test
    public void matchesAnAuthorityWhateverTheApplicationId() {
        assertEquals(SignerTypes.Method.SIGN_EVENT,
                SignerTypes.fromAuthority("pub.soapbox.tenna.SIGN_EVENT"));
        assertEquals(SignerTypes.Method.SIGN_EVENT,
                SignerTypes.fromAuthority("pub.soapbox.tenna.debug.SIGN_EVENT"));
        assertEquals(SignerTypes.Method.NIP44_DECRYPT,
                SignerTypes.fromAuthority("anything.at.all.NIP44_DECRYPT"));
        assertNull(SignerTypes.fromAuthority("pub.soapbox.tenna.SIGN_PSBT"));
        assertNull(SignerTypes.fromAuthority(null));
    }

    /** {@code connect} is the approval itself, so it has no door of its own. */
    @Test
    public void connectIsNotReachableOverIpc() {
        assertNull(SignerTypes.Method.CONNECT.authority);
        assertNull(SignerTypes.Method.SWITCH_RELAYS.authority);
        assertNull(SignerTypes.Method.LOGOUT.authority);
        assertFalse(SignerTypes.Method.CONNECT.isNip55());
        assertFalse(SignerTypes.Method.PING.isNip55());
        assertTrue(SignerTypes.Method.SIGN_EVENT.isNip55());
    }

    @Test
    public void knowsWhichMethodsNeedTheOtherParty() {
        assertTrue(SignerTypes.Method.NIP04_ENCRYPT.needsPeer());
        assertTrue(SignerTypes.Method.NIP44_DECRYPT.needsPeer());
        assertFalse(SignerTypes.Method.SIGN_EVENT.needsPeer());
        assertFalse(SignerTypes.Method.GET_PUBLIC_KEY.needsPeer());
        // A zap request names its own author, so the caller does not.
        assertFalse(SignerTypes.Method.DECRYPT_ZAP_EVENT.needsPeer());
    }

    // ── Requested permission lists ───────────────────────────────────────────

    @Test
    public void readsAPermissionWithAKind() {
        Integer[] kind = new Integer[1];
        assertEquals(SignerTypes.PERM_SIGN_EVENT,
                SignerTypes.permissionFromPerm("sign_event:1059", kind));
        assertEquals(Integer.valueOf(1059), kind[0]);
    }

    @Test
    public void readsAPermissionWithoutOne() {
        Integer[] kind = new Integer[1];
        assertEquals(SignerTypes.PERM_NIP44_DECRYPT,
                SignerTypes.permissionFromPerm("nip44_decrypt", kind));
        assertNull(kind[0]);
    }

    /** Only signing is asked about per kind; a kind on anything else is noise. */
    @Test
    public void dropsAKindFromAMethodThatHasNone() {
        Integer[] kind = new Integer[1];
        kind[0] = 7;
        assertEquals(SignerTypes.PERM_NIP04_ENCRYPT,
                SignerTypes.permissionFromPerm("nip04_encrypt:4", kind));
        assertNull(kind[0]);
    }

    @Test
    public void survivesAMalformedKind() {
        Integer[] kind = new Integer[1];
        assertEquals(SignerTypes.PERM_SIGN_EVENT, SignerTypes.permissionFromPerm("sign_event:", kind));
        assertNull(kind[0]);

        assertEquals(SignerTypes.PERM_SIGN_EVENT, SignerTypes.permissionFromPerm("sign_event:abc", kind));
        assertNull(kind[0]);
    }

    @Test
    public void ignoresSurroundingSpaceAndRubbish() {
        assertEquals(SignerTypes.PERM_SIGN_EVENT,
                SignerTypes.permissionFromPerm("  sign_event:1  ", null));
        assertNull(SignerTypes.permissionFromPerm("  ", null));
        assertNull(SignerTypes.permissionFromPerm("not_a_method", null));
        assertNull(SignerTypes.permissionFromPerm(null, null));
    }

    /** A method that takes no grant cannot be pre-authorized into one. */
    @Test
    public void refusesToGrantWhatIsNotAskedFor() {
        assertNull(SignerTypes.permissionFromPerm("connect", null));
        assertNull(SignerTypes.permissionFromPerm("switch_relays", null));
        assertNull(SignerTypes.permissionFromPerm("logout", null));
        assertNotNull(SignerTypes.permissionFromPerm("ping", null));
    }
}
