package pub.soapbox.tenna;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.core.app.RemoteInput;

/**
 * A button pressed under a notification, or one swiped away.
 *
 * Both raise an event in the site's service worker, which is where the web
 * puts them: pressing a button is {@code notificationclick} with an
 * {@code action}, and dismissing is {@code notificationclose}. Neither opens
 * a window — a reply typed into the shade is answered without leaving the
 * shade, and a dismissal is the user saying they are done.
 *
 * A receiver rather than an activity because of that: nothing here is allowed
 * to bring the app forward, and the push service it starts is started under
 * the exemption Android grants an app the user has just acted on in a
 * notification.
 *
 * The body of a notification does not come through here. A tap has to land
 * immediately, so it goes straight to the site's window as an activity intent
 * and the window raises the worker's event afterwards — see
 * {@link NsiteAppActivity}.
 */
public class NappNotificationReceiver extends BroadcastReceiver {

    static final String ACTION_ACTION = "pub.soapbox.tenna.napp.NOTIFICATION_ACTION";
    static final String ACTION_DISMISSED = "pub.soapbox.tenna.napp.NOTIFICATION_DISMISSED";

    static final String EXTRA_SITE_ID = "pub.soapbox.tenna.napp.SITE_ID";
    static final String EXTRA_KEY = "pub.soapbox.tenna.napp.KEY";
    static final String EXTRA_ACTION = "pub.soapbox.tenna.napp.ACTION";

    /** Where {@code RemoteInput} puts what the user typed. */
    static final String KEY_REPLY = "napp.reply";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String siteId = intent.getStringExtra(EXTRA_SITE_ID);
        String key = intent.getStringExtra(EXTRA_KEY);
        if (siteId == null || key == null) return;

        if (ACTION_DISMISSED.equals(intent.getAction())) {
            // Dispatched before it is forgotten: the event carries the
            // notification the site is being told about, and it is read out
            // of the same record this is about to delete.
            NappPushService.dispatchNotificationEvent(
                context, siteId, "notificationclose", key, null, null
            );
            NappNotificationStore.remove(context, siteId, key);
            return;
        }

        if (!ACTION_ACTION.equals(intent.getAction())) return;

        NappPushService.dispatchNotificationEvent(
            context,
            siteId,
            "notificationclick",
            key,
            intent.getStringExtra(EXTRA_ACTION),
            reply(intent)
        );
    }

    /** What the user typed into the reply box, if the button had one. */
    @Nullable
    private static String reply(Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        if (results == null) return null;

        CharSequence text = results.getCharSequence(KEY_REPLY);
        return text == null ? null : text.toString();
    }
}
