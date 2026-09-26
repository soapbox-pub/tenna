package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * When a site's periodic sync tags are due, and how often its job runs.
 *
 * <p>The two numbers a mistake here would turn into either a site that is never
 * woken or a battery spent waking it every fifteen minutes when it asked for a
 * day.
 */
public class NappPeriodicSyncTest {

    private static final long MINUTE = TimeUnit.MINUTES.toMillis(1);
    private static final long HOUR = TimeUnit.HOURS.toMillis(1);

    @Test
    public void roundsIntervalsUpToTheFloor() {
        List<NappPeriodicSync.Entry> entries = NappPeriodicSync.parse(
            "[{\"tag\":\"a\",\"minInterval\":1000,\"lastRun\":5}]");
        assertEquals(1, entries.size());
        assertEquals(NappPeriodicSync.MIN_INTERVAL_MS, entries.get(0).minInterval);
        assertEquals(5, entries.get(0).lastRun);
    }

    @Test
    public void readsNothingFromGarbage() {
        assertTrue(NappPeriodicSync.parse(null).isEmpty());
        assertTrue(NappPeriodicSync.parse("not json").isEmpty());
        assertTrue(NappPeriodicSync.parse("[{\"tag\":\"\"}]").isEmpty());
    }

    @Test
    public void aTagIsDueOnceItsIntervalHasPassed() {
        NappPeriodicSync.Entry entry = new NappPeriodicSync.Entry("a", HOUR, 0);
        assertEquals(Collections.singletonList("a"), NappPeriodicSync.due(Collections.singletonList(entry), HOUR));
        assertTrue(NappPeriodicSync.due(Collections.singletonList(entry), 30 * MINUTE).isEmpty());
    }

    @Test
    public void aLittleEarlyCounts() {
        // Five minutes of slack on an hour, and three and three quarters on fifteen.
        NappPeriodicSync.Entry hourly = new NappPeriodicSync.Entry("h", HOUR, 0);
        assertEquals(1, NappPeriodicSync.due(Collections.singletonList(hourly), 55 * MINUTE).size());
        assertTrue(NappPeriodicSync.due(Collections.singletonList(hourly), 54 * MINUTE).isEmpty());

        NappPeriodicSync.Entry quarter = new NappPeriodicSync.Entry("q", 15 * MINUTE, 0);
        assertEquals(1, NappPeriodicSync.due(Collections.singletonList(quarter), 12 * MINUTE).size());
        assertTrue(NappPeriodicSync.due(Collections.singletonList(quarter), 11 * MINUTE).isEmpty());
    }

    @Test
    public void onlyTheDueTagsRun() {
        List<NappPeriodicSync.Entry> entries = Arrays.asList(
            new NappPeriodicSync.Entry("often", 15 * MINUTE, 0),
            new NappPeriodicSync.Entry("daily", 24 * HOUR, 0)
        );
        assertEquals(Collections.singletonList("often"), NappPeriodicSync.due(entries, HOUR));
    }

    @Test
    public void theJobRunsAsOftenAsTheMostFrequentTag() {
        assertEquals(0, NappPeriodicSync.period(Collections.emptyList()));
        assertEquals(15 * MINUTE, NappPeriodicSync.period(Arrays.asList(
            new NappPeriodicSync.Entry("daily", 24 * HOUR, 0),
            new NappPeriodicSync.Entry("often", 15 * MINUTE, 0)
        )));
    }
}
