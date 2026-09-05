import { z } from 'zod';

import { getMimeType } from '@/lib/sandbox';

/**
 * A web app manifest's `share_target`, as Tenna is willing to honour it.
 *
 * The member is standard — it is what puts an installed PWA in the OS share
 * sheet on Android — and an nsite declares it exactly the way a PWA does.
 * Nothing here is Tenna's own invention; this file is only the reading of it,
 * done once in the web layer so that no second parser has to exist in Java.
 *
 * The one thing worth knowing is what happens to a `POST` target, and it is
 * not really Tenna's doing either. A POST share is delivered as a form
 * navigation to the action, and on a site made of static content-addressed
 * blobs there is no server to answer one — so the site's own service worker
 * has to, out of `request.formData()`, which is how PWA share targets have
 * always worked in practice. A site with no worker gets told so.
 */
export interface NsiteShareTarget {
  /**
   * Where the share is delivered, as a site-absolute path with any query the
   * site wrote into it. Never another origin: an action that resolves off the
   * site is refused outright rather than followed.
   */
  action: string;
  method: 'GET' | 'POST';
  enctype: 'application/x-www-form-urlencoded' | 'multipart/form-data';
  params: {
    /** Field name for the subject, if the site wants one. */
    title?: string;
    text?: string;
    url?: string;
    /** File fields, in the order declared. Only ever populated for POST. */
    files: NsiteShareFiles[];
  };
}

/** One file field, and what it will take. */
export interface NsiteShareFiles {
  /** The form field name. */
  name: string;
  /** MIME types and extensions as the site wrote them: `image/*`, `.png`. */
  accept: string[];
}

/**
 * The Android categories a site qualifies for.
 *
 * One per `<share-target>` in `res/xml/shortcuts.xml`, and the two lists must
 * agree: a sharing shortcut is offered for a MIME type only when it carries
 * the category the matching `<share-target>` declares.
 */
export const SHARE_CATEGORIES = {
  text: 'pub.soapbox.tenna.category.SHARE_TEXT',
  image: 'pub.soapbox.tenna.category.SHARE_IMAGE',
  video: 'pub.soapbox.tenna.category.SHARE_VIDEO',
  audio: 'pub.soapbox.tenna.category.SHARE_AUDIO',
  file: 'pub.soapbox.tenna.category.SHARE_FILE',
} as const;

/** Ceilings on what one target may declare. */
const LIMITS = {
  /** Field names go into a form; a manifest naming a hundred is not serious. */
  files: 10,
  accept: 40,
  name: 128,
} as const;

const fieldName = z.string().trim().min(1).max(LIMITS.name);

const filesSchema = z.object({
  name: fieldName,
  accept: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (typeof value === 'string' ? [value] : value))
    .pipe(z.array(z.string().trim().min(1)).max(LIMITS.accept)),
});

const shareTargetSchema = z.object({
  action: z.string().trim().min(1),
  method: z.string().trim().optional(),
  enctype: z.string().trim().optional(),
  params: z
    .object({
      title: fieldName.optional(),
      text: fieldName.optional(),
      url: fieldName.optional(),
      files: z
        .union([filesSchema, z.array(filesSchema)])
        .transform((value) => (Array.isArray(value) ? value : [value]))
        .optional(),
    })
    .optional(),
});

/** The origin an nsite path is resolved against; never reachable, never used. */
const NOWHERE = 'https://nsite.invalid';

/**
 * Resolve the action against the manifest it was declared in, and refuse
 * anything that leaves the site.
 *
 * A manifest is event data, so an action is untrusted string. Resolving it
 * against a hostname that does not exist means an absolute URL — to a real
 * host, or to `javascript:`, or to a `data:` document — lands somewhere other
 * than `nsite.invalid` and is dropped here rather than navigated to later.
 */
function resolveAction(action: string, base: string): string | null {
  try {
    const url = new URL(action, `${NOWHERE}${base}`);
    if (url.origin !== NOWHERE) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

/**
 * Read a site's `share_target`, or null if it hasn't got a usable one.
 *
 * `base` is the directory the web app manifest itself lives in, so that a
 * relative action resolves the way the manifest spec says — against the
 * manifest, not against the document.
 */
export function parseShareTarget(manifest: unknown, base: string): NsiteShareTarget | null {
  if (typeof manifest !== 'object' || manifest === null) return null;

  const { share_target } = manifest as { share_target?: unknown };
  const parsed = shareTargetSchema.safeParse(share_target);
  if (!parsed.success) return null;

  const action = resolveAction(parsed.data.action, base);
  if (!action) return null;

  const method = parsed.data.method?.toUpperCase() === 'POST' ? 'POST' : 'GET';
  const declaredEnctype = parsed.data.enctype?.toLowerCase();

  // A GET target's params ride in the query string, so the only encoding it
  // can have is the one that describes a query string.
  const enctype =
    method === 'POST' && declaredEnctype === 'multipart/form-data'
      ? 'multipart/form-data'
      : 'application/x-www-form-urlencoded';

  const { title, text, url } = parsed.data.params ?? {};

  // Files are multipart or they are nothing: there is no way to put bytes in a
  // query string, and a urlencoded POST body would arrive as their names.
  const files =
    enctype === 'multipart/form-data'
      ? (parsed.data.params?.files ?? []).slice(0, LIMITS.files)
      : [];

  // A target that names no field at all has nowhere to put a share.
  if (!title && !text && !url && files.length === 0) return null;

  return { action, method, enctype, params: { title, text, url, files } };
}

/** The MIME type an `accept` entry stands for; extensions are looked up. */
function acceptType(accept: string): string {
  const entry = accept.trim().toLowerCase();
  return entry.startsWith('.') ? getMimeType(entry) : entry;
}

/** Whether an `accept` entry covers a MIME type. */
function accepts(accept: string, type: string): boolean {
  const entry = acceptType(accept);
  if (entry === '*/*' || entry === type) return true;
  const [group] = entry.split('/');
  return entry.endsWith('/*') && type.startsWith(`${group}/`);
}

/**
 * Which of the OS share sheet's buckets this site belongs in.
 *
 * Coarser than the site's own `accept` list, because Android matches a share
 * against static `<data android:mimeType>` elements rather than against
 * anything per-shortcut. A site that takes only PNGs is offered every image
 * and turns down what it doesn't want, which is the same bargain a PWA makes.
 */
export function shareCategories(target: NsiteShareTarget): string[] {
  const categories = new Set<string>();

  if (target.params.title || target.params.text || target.params.url) {
    categories.add(SHARE_CATEGORIES.text);
  }

  for (const field of target.params.files) {
    for (const accept of field.accept) {
      const type = acceptType(accept);
      if (type === '*/*') {
        // Everything, so every bucket — including the plain-text one, which is
        // its own intent shape rather than a file.
        for (const category of Object.values(SHARE_CATEGORIES)) categories.add(category);
      } else if (type.startsWith('image/')) {
        categories.add(SHARE_CATEGORIES.image);
      } else if (type.startsWith('video/')) {
        categories.add(SHARE_CATEGORIES.video);
      } else if (type.startsWith('audio/')) {
        categories.add(SHARE_CATEGORIES.audio);
      } else if (type.startsWith('text/')) {
        categories.add(SHARE_CATEGORIES.text);
        categories.add(SHARE_CATEGORIES.file);
      } else {
        categories.add(SHARE_CATEGORIES.file);
      }
    }
  }

  return [...categories];
}

// ---------------------------------------------------------------------------

/** What the OS handed over, with the bytes left on disk. */
export interface NsiteSharePayload {
  title?: string;
  text?: string;
  url?: string;
  files: NsiteSharedFile[];
}

/** One staged file. The bytes are fetched from the site's own origin. */
export interface NsiteSharedFile {
  /** Its place in the staging directory, and in the URL that serves it. */
  index: number;
  name: string;
  type: string;
  size: number;
}

/** How to hand a share to a site: a path to open, or a form to submit. */
export type NsiteShareDelivery =
  | { kind: 'get'; path: string }
  | { kind: 'post'; token: string; plan: string };

/** The form the bootstrap page builds. Serialised, because Capacitor. */
export interface NsiteSharePostPlan {
  action: string;
  enctype: string;
  /** Text fields, as name/value pairs in declaration order. */
  fields: Array<[string, string]>;
  files: Array<{ field: string; index: number; name: string; type: string }>;
}

/** Whether a shared string is a bare link rather than prose. */
function isLink(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !/\s/.test(text.trim());
  } catch {
    return false;
  }
}

/**
 * Sort what arrived into the fields the site asked for.
 *
 * Android has one text extra and the manifest has two fields for it, so the
 * split is a guess and is made the way Chrome makes it: a share that is
 * nothing but a link goes to `url` when the site declared one, and everything
 * else is prose. Either field stands in for the other when only one exists,
 * since dropping the entire share to honour a distinction the OS never drew
 * would be the worse answer.
 */
function textFields(
  target: NsiteShareTarget,
  payload: NsiteSharePayload,
): Array<[string, string]> {
  const { title, text, url } = target.params;
  const fields: Array<[string, string]> = [];

  if (title && payload.title) fields.push([title, payload.title]);

  const body = payload.url ?? payload.text;
  if (body) {
    const field = url && (payload.url || isLink(body)) ? url : (text ?? url);
    if (field) fields.push([field, body]);
  }

  return fields;
}

/** Route each shared file to the first field that will have it. */
function fileFields(
  target: NsiteShareTarget,
  payload: NsiteSharePayload,
): NsiteSharePostPlan['files'] {
  const routed: NsiteSharePostPlan['files'] = [];

  for (const file of payload.files) {
    const field = target.params.files.find((candidate) =>
      candidate.accept.some((accept) => accepts(accept, file.type)),
    );
    if (!field) continue;
    routed.push({ field: field.name, index: file.index, name: file.name, type: file.type });
  }

  return routed;
}

/**
 * Work out how to deliver a share to a site, or null if it cannot take it.
 *
 * A GET target is a plain navigation to its action with the params in the
 * query — no page of Tenna's in between, nothing injected. A POST target needs
 * a real multipart form submission, which only a document on the site's own
 * origin can make, so it gets the bootstrap page instead.
 */
export function planShareDelivery(
  target: NsiteShareTarget,
  payload: NsiteSharePayload,
  token: string,
): NsiteShareDelivery | null {
  const fields = textFields(target, payload);

  if (target.method === 'GET') {
    if (fields.length === 0) return null;

    const url = new URL(target.action, NOWHERE);
    for (const [name, value] of fields) url.searchParams.append(name, value);
    return { kind: 'get', path: url.pathname + url.search };
  }

  const files = fileFields(target, payload);
  if (fields.length === 0 && files.length === 0) return null;

  const plan: NsiteSharePostPlan = {
    action: target.action,
    enctype: target.enctype,
    fields,
    files,
  };

  return { kind: 'post', token, plan: JSON.stringify(plan) };
}
