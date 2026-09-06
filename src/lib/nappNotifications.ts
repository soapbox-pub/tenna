/**
 * The shape a site puts in `options.data.napp` to say how Tenna should merge
 * and draw its notification.
 *
 * Declared here, and nowhere used: nothing in the web layer sees a
 * notification. A site's `showNotification` goes from the shim appended to its
 * service worker straight to the host, which reads and clamps all of this in
 * `NappHints.java` — the authority, and the only implementation. These types
 * are the document: `NAPP.md` prints them, and a site written in TypeScript
 * can copy them.
 *
 * The premise throughout is that everything here is *additional*. A web
 * notification is a title, a line of text and a tag; a browser ignores an
 * unknown `data` member, so a site that fills this in still behaves the way it
 * always did everywhere else, and Tenna is the only place that draws the rest.
 * Anything with a standard spelling keeps it — buttons are `options.actions`,
 * because the Notifications API already has them, down to `type: 'text'` for
 * an inline reply and `event.reply` for what was typed.
 */

/** Where a picture comes from. Three shapes, best first. */
export type NappImage =
  /**
   * One of the site's own files, resolved against its NIP-5A manifest and
   * served from the content-addressed blob cache. Free after the first time,
   * works offline, reaches no network. Prefer this.
   */
  | `/${string}`
  /**
   * Somewhere else. Unavoidable for a user's avatar. Fetched by the host with
   * no cookies, no redirects, an image content type, a size ceiling and a
   * short timeout — but it still tells that host the device is here.
   */
  | `https://${string}`
  /** Inlined. Cheap, but spent out of the same 64 KiB the words come from. */
  | `data:image/${string}`;

/** Somebody a notification is from. */
export interface NappPerson {
  /**
   * Stable across notifications — a pubkey is ideal.
   *
   * Android uses it to tell two senders apart when their names collide, and
   * to keep a conversation attributed to the same person over time.
   */
  id?: string;
  name: string;
  icon?: NappImage;
}

/** One line of a conversation. */
export interface NappMessage {
  text: string;
  /** Milliseconds. Defaults to when the notification was posted. */
  timestamp?: number;
  /** Omit for the user's own line, which is drawn as theirs. */
  from?: NappPerson;
}

/**
 * A channel of the site's own, inside the site's group in system settings.
 *
 * This is how a user keeps a site's mentions and silences its reactions. It is
 * created the first time it is named and never altered afterwards — an
 * importance the user has changed is theirs, not the site's, and a name a
 * channel was created under cannot be changed at all. Choose both once.
 */
export interface NappChannel {
  id: string;
  name: string;
  importance?: 'min' | 'low' | 'default' | 'high';
}

export type NappStyle =
  /** The default: a title and a body that expands. */
  | { type: 'text' }
  /**
   * A conversation, drawn the way Android draws its own — one row per line,
   * each with its sender's face.
   *
   * Name a `conversation` for a channel or a group; leave it out for a
   * two-person thread, and the system lays it out as the 1:1 it is.
   */
  | {
      type: 'message';
      conversation?: string;
      /** Whether more than two people are in it. Implied by `conversation`. */
      group?: boolean;
      messages: NappMessage[];
      /** Who the user is, for lines with no `from`. Defaults to "You". */
      me?: NappPerson;
    }
  /** A list — "three people liked your note", each on its own row. */
  | { type: 'inbox'; lines: string[] }
  /** A photograph, shown in full when the notification is expanded. */
  | { type: 'picture'; image: NappImage; summary?: string };

export interface NappHints {
  /**
   * Where a tap goes, as a site-absolute path.
   *
   * Honoured without a worker running, which is the point: a tap has to land
   * at once, and the worker that would have routed it may be dead. Tenna also
   * falls back to a plain `data.url`, which is what every push service worker
   * on Nostr already writes.
   *
   * `notificationclick` still fires afterwards, so a site that routes there
   * keeps its say — see NAPP.md.
   */
  url?: string;

  /**
   * How this payload relates to what is already shown under the same `tag`.
   *
   * - `replace` (default) — the payload is the whole notification, as on the web.
   * - `append` — its `messages` or `lines` are added to the ones already there,
   *   newest eight kept. The runtime remembers them, so a worker that is
   *   started for one event and killed afterwards does not have to.
   *
   * A notification the user has swiped away starts over either way.
   */
  merge?: 'replace' | 'append';

  channel?: NappChannel;

  /**
   * Bundle key. Notifications sharing one are collapsed by the system under a
   * single header. Leave it out and each stands alone.
   */
  group?: string;

  /** Whose notification this is. Becomes the icon beside it. */
  person?: NappPerson;

  style?: NappStyle;

  /** Cannot be swiped away, and has no `when`. For something still happening. */
  ongoing?: boolean;

  /** A progress bar. Omit `value` for one that cannot say how far along it is. */
  progress?: { value?: number; max?: number };

  /** A number on the notification, and on the launcher badge. */
  count?: number;
}

/**
 * The options a site passes to `showNotification`, as Tenna reads them.
 *
 * Everything here is standard except `data.napp`. What Tenna does *not* read
 * is listed in NAPP.md; the short version is that `badge`, `image`,
 * `requireInteraction`, `vibrate`, `dir` and `lang` have no counterpart and
 * are accepted and ignored.
 */
export interface NappNotificationOptions extends NotificationOptions {
  data?: {
    /** Where a tap goes, for a site that already writes this. */
    url?: string;
    napp?: NappHints;
    [key: string]: unknown;
  };
}

/** Limits, enforced by the host. Anything past them is dropped, not refused. */
export const NAPP_NOTIFICATION_LIMITS = {
  /** Messages or inbox rows one notification carries, accumulated. */
  lines: 8,
  /** Buttons. Android draws three. */
  actions: 3,
  /** The whole payload, base64url in a URL. */
  bytes: 64 * 1024,
} as const;
