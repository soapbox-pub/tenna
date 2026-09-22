package pub.soapbox.tenna;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import pub.soapbox.tenna.NappPort.Frame;

/**
 * The frame a body chunk crosses a port in.
 *
 * <p>Pinned here because it is a wire format with two implementations: this
 * one, and the reader and writer in {@code napp_sw_shim.js}. Nothing about a
 * mismatch would show up as a compile error, and the symptom on a device — an
 * upload that silently stalls — says nothing about which end is wrong.
 */
public class NappPortTest {

    private static final byte[] PAYLOAD = "the bytes of a body".getBytes(StandardCharsets.UTF_8);

    @Test
    public void writesTheLengthOfItsHeaderFirst() {
        byte[] frame = Frame.write(7, 3, PAYLOAD, PAYLOAD.length);

        // Four bytes, big-endian, as the shim's DataView.getUint32 reads it.
        int length = ((frame[0] & 0xFF) << 24)
            | ((frame[1] & 0xFF) << 16)
            | ((frame[2] & 0xFF) << 8)
            | (frame[3] & 0xFF);

        String header = new String(frame, 4, length, StandardCharsets.UTF_8);
        assertEquals("{\"id\":7,\"i\":3}", header);
        assertEquals(4 + length + PAYLOAD.length, frame.length);
    }

    @Test
    public void readsBackWhatItWrote() {
        Frame read = Frame.read(Frame.write(7, 3, PAYLOAD, PAYLOAD.length));

        assertNotNull(read);
        assertEquals(7, read.id);
        assertEquals(3, read.sequence);
        assertArrayEquals(PAYLOAD, read.payload);
    }

    @Test
    public void takesOnlyTheBytesItWasGiven() {
        // The response reader fills one buffer over and over, so a frame is
        // written from a prefix of it and must not carry the rest.
        byte[] buffer = new byte[64];
        System.arraycopy(PAYLOAD, 0, buffer, 0, PAYLOAD.length);

        Frame read = Frame.read(Frame.write(1, 0, buffer, PAYLOAD.length));

        assertNotNull(read);
        assertArrayEquals(PAYLOAD, read.payload);
    }

    @Test
    public void carriesAnEmptyChunk() {
        Frame read = Frame.read(Frame.write(2, 9, new byte[0], 0));

        assertNotNull(read);
        assertEquals(2, read.id);
        assertEquals(9, read.sequence);
        assertEquals(0, read.payload.length);
    }

    @Test
    public void refusesWhatIsNotAFrame() {
        assertNull(Frame.read(null));
        assertNull(Frame.read(new byte[0]));
        assertNull(Frame.read(new byte[] { 0, 0, 0 }));

        // A header longer than the frame it is in.
        assertNull(Frame.read(new byte[] { 0, 0, 0, (byte) 200, '{', '}' }));

        // A header that is not JSON, and one that names nothing.
        assertNull(Frame.read(new byte[] { 0, 0, 0, 2, 'h', 'i' }));
        assertNull(Frame.read(new byte[] { 0, 0, 0, 2, '{', '}' }));
    }

    @Test
    public void refusesAFrameWithNoNumbers() {
        byte[] header = "{\"id\":4}".getBytes(StandardCharsets.UTF_8);
        byte[] frame = new byte[4 + header.length];
        frame[3] = (byte) header.length;
        System.arraycopy(header, 0, frame, 4, header.length);

        // An id without a chunk number is not a chunk, and writing it to a
        // socket at whatever position happened to be next would be worse than
        // dropping it.
        assertNull(Frame.read(frame));
    }
}
