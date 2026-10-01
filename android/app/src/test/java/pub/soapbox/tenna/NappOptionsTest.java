package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

/**
 * Which picture references a notification keeps.
 *
 * <p>A reference dropped here is a notification drawn without its picture and
 * nothing said about it, so the shapes a site is told it may use are pinned.
 */
public class NappOptionsTest {

    private static String repeat(char c, int count) {
        StringBuilder out = new StringBuilder(count);
        for (int i = 0; i < count; i++) out.append(c);
        return out.toString();
    }

    private static String dataUrl(int length) {
        String head = "data:image/jpeg;base64,";
        return head + repeat('A', length - head.length());
    }

    @Test
    public void keepsAThumbnailSizedDataUrl() {
        // A 256px JPEG, about what a site downscaling its own artwork sends.
        String thumbnail = dataUrl(30 * 1024);
        assertEquals(thumbnail, NappOptions.image(thumbnail));
    }

    @Test
    public void keepsADataUrlAtTheCeiling() {
        String atCeiling = dataUrl(NappOptions.MAX_DATA_IMAGE);
        assertEquals(atCeiling, NappOptions.image(atCeiling));
    }

    @Test
    public void dropsADataUrlPastTheCeiling() {
        assertNull(NappOptions.image(dataUrl(NappOptions.MAX_DATA_IMAGE + 1)));
    }

    @Test
    public void dropsADataUrlThatIsNotAPicture() {
        assertNull(NappOptions.image("data:text/html;base64,PGgxPmhpPC9oMT4="));
    }

    @Test
    public void keepsPathsAndHttpsUrls() {
        assertEquals("/icon-192.png", NappOptions.image("/icon-192.png"));
        assertEquals("https://example.com/a.png", NappOptions.image("https://example.com/a.png"));
    }

    @Test
    public void dropsALongHttpsUrl() {
        assertNull(NappOptions.image("https://example.com/" + repeat('a', 5000)));
    }

    @Test
    public void dropsEveryOtherShape() {
        assertNull(NappOptions.image("//elsewhere.example/a.png"));
        assertNull(NappOptions.image("http://example.com/a.png"));
        assertNull(NappOptions.image("blob:https://example.com/0f3c"));
        assertNull(NappOptions.image(""));
        assertNull(NappOptions.image(null));
    }

    @Test
    public void parseKeepsAnInlinedIcon() throws Exception {
        String icon = dataUrl(40 * 1024);
        NappOptions options = NappOptions.parse(new JSONObject().put("icon", icon).put("body", "hi"));
        assertEquals(icon, options.icon);
    }
}
