package pub.soapbox.tenna;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.graphics.drawable.RoundedBitmapDrawable;
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory;

/**
 * The bar above an nsite: the way out, and whose site this is.
 *
 * The same bar React draws for the iframe path, in native views, because the
 * site's WebView is layered over the Capacitor one and buries React's copy of
 * it. Only the bar is native — the permissions panel it opens is still React's,
 * shown by concealing the whole frame.
 *
 * It is a strip of its own rather than a control floating over the picture:
 * anything floating sits on top of a layout the site chose and Tenna cannot
 * see, and the way out of a site has to be somewhere the site was never given.
 * That also settles the status bar. The bar is what runs under the clock, so
 * the site laid out below it is already clear of it — see
 * {@link #heightFor(Insets)}.
 */
@SuppressLint("ViewConstructor")
class NsiteTopBarView extends LinearLayout {

    /** Height of the bar proper, above whatever the status bar takes. */
    private static final int ROW_HEIGHT_DP = 48;

    /** Touch target for the buttons at either end, and the glyph inside one. */
    private static final int BUTTON_DP = 40;
    private static final int GLYPH_INSET_DP = 8;

    /** The site's tile, at the size a bar can carry it. */
    private static final int ICON_DP = 22;
    private static final int ICON_RADIUS_DP = 6;

    private final ImageView icon;
    private final TextView title;

    NsiteTopBarView(
        Context context,
        boolean hasSigner,
        @NonNull Runnable onBack,
        @NonNull Runnable onPermissions
    ) {
        super(context);

        setOrientation(VERTICAL);
        setBackgroundColor(0xFF000000);
        // A tap on the bar is the bar's, not the site's underneath it.
        setClickable(true);

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(4), 0, dp(4), 0);
        row.addView(button(R.drawable.ic_nsite_back, "Back", onBack));

        icon = new ImageView(context);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        // Nothing until the site's own document has been read for one.
        icon.setVisibility(GONE);

        title = new TextView(context);
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);

        LinearLayout identity = new LinearLayout(context);
        identity.setOrientation(HORIZONTAL);
        identity.setGravity(Gravity.CENTER_VERTICAL);

        LayoutParams iconParams = new LayoutParams(dp(ICON_DP), dp(ICON_DP));
        iconParams.setMarginEnd(dp(8));
        identity.addView(icon, iconParams);
        identity.addView(title, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));

        // Centred between two slots of the same width, so the site's name sits
        // in the middle of the bar rather than in the middle of what is left of
        // it. Wrapped so the pair is measured against the space between the
        // buttons: that is what ellipsizes a long name instead of pushing the
        // icon off the end.
        FrameLayout centre = new FrameLayout(context);
        centre.addView(identity, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ));
        row.addView(centre, new LayoutParams(0, LayoutParams.MATCH_PARENT, 1f));

        if (hasSigner) {
            row.addView(button(R.drawable.ic_nsite_shield, "Site permissions", onPermissions));
        } else {
            // Nothing to put here, but the name is only centred if the slot
            // stays the width of the one opposite it.
            row.addView(new View(context), new LayoutParams(dp(BUTTON_DP), dp(BUTTON_DP)));
        }

        addView(row, new LayoutParams(LayoutParams.MATCH_PARENT, dp(ROW_HEIGHT_DP)));

        // A hairline, for the sites whose own top edge is as dark as the bar.
        View line = new View(context);
        line.setBackgroundColor(0x1AFFFFFF);
        addView(line, new LayoutParams(LayoutParams.MATCH_PARENT, 1));
    }

    /** Put the bar inside the system bars rather than behind them. */
    void setSafeArea(@NonNull Insets safeArea) {
        setPadding(safeArea.left, safeArea.top, safeArea.right, 0);
    }

    /**
     * Where the site below the bar begins, given the insets of the moment.
     *
     * Computed rather than measured because the site is laid out against it
     * before the bar has been through a layout pass of its own.
     */
    int heightFor(@NonNull Insets safeArea) {
        return safeArea.top + dp(ROW_HEIGHT_DP) + 1;
    }

    void setSiteTitle(@Nullable String text) {
        if (text != null) title.setText(text);
    }

    /** The site's tile, or nothing if it hasn't got one. */
    void setSiteIcon(@Nullable Bitmap bitmap) {
        if (bitmap == null) return;

        RoundedBitmapDrawable rounded = RoundedBitmapDrawableFactory.create(getResources(), bitmap);
        // In the drawable's own bounds, which are the view's — so the corners
        // are cut where React's `rounded-md` cuts them, whatever the bitmap.
        rounded.setCornerRadius(dp(ICON_RADIUS_DP));
        rounded.setAntiAlias(true);

        icon.setImageDrawable(rounded);
        icon.setVisibility(VISIBLE);
    }

    private ImageButton button(int glyph, String label, @NonNull Runnable onClick) {
        ImageButton view = new ImageButton(getContext());
        view.setImageResource(glyph);
        view.setImageTintList(ColorStateList.valueOf(0xFFFFFFFF));
        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        view.setContentDescription(label);
        view.setPadding(dp(GLYPH_INSET_DP), dp(GLYPH_INSET_DP), dp(GLYPH_INSET_DP), dp(GLYPH_INSET_DP));
        view.setOnClickListener(v -> onClick.run());
        view.setLayoutParams(new LayoutParams(dp(BUTTON_DP), dp(BUTTON_DP)));

        TypedValue ripple = new TypedValue();
        getContext().getTheme().resolveAttribute(
            android.R.attr.selectableItemBackgroundBorderless, ripple, true
        );
        if (ripple.resourceId != 0) {
            view.setBackgroundResource(ripple.resourceId);
        } else {
            view.setBackground(null);
        }

        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
