/**
 * A site's environment: variables the user sets on a site, which its pages
 * read as `window.ENV`.
 *
 * A static site has no server to read configuration from, so one build goes
 * everywhere with whatever it was built with. npanel answers that by serving
 * the host's variables as a script that runs before the site's own; this is
 * the same thing done by the runtime instead of the gateway, so a site written
 * to read `window.ENV.API_URL` there can be pointed somewhere else here too.
 *
 * Kept per site and on this device only, like the browser permissions beside
 * it. Nothing is defined at all until a variable is set, so a site that tests
 * for `window.ENV` sees exactly what it would see anywhere else.
 *
 * The name and value rules are npanel's (`dashboard/src/shared/env.ts`), so a
 * variable accepted there is accepted here.
 */

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Most variables one site may have. */
export const MAX_VARIABLES = 100;

/** Longest name accepted. */
const MAX_NAME_LENGTH = 128;

/** Longest value accepted, in characters. */
const MAX_VALUE_LENGTH = 4096;

/** Letters, digits and underscores, not starting with a digit. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Accept a variable name, exactly as written apart from surrounding space.
 *
 * Names follow the rule shells hold environment variables to, which makes
 * every one a plain identifier, readable as `window.ENV.NAME`. Case is kept:
 * `api_url` and `API_URL` are two variables.
 */
export function parseEnvName(input: string): string {
  const name = input.trim();

  if (!name) {
    throw new Error('Enter a name for this variable.');
  }
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new Error(`A name can be at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`A name may only use letters, digits, and _, and can't start with a digit — ${name} doesn't fit.`);
  }

  return name;
}

/** Accept a value. Kept verbatim, spaces and all, and it may be empty. */
export function parseEnvValue(input: string): string {
  if ([...input].length > MAX_VALUE_LENGTH) {
    throw new Error(`A value can be at most ${MAX_VALUE_LENGTH} characters.`);
  }
  return input;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** One variable: its name, then its value. */
export type NsiteEnvVariable = [name: string, value: string];

export const NSITE_ENV_KEY = 'nostr:nsite-env';

/** Fired on `window` after every write, since `storage` never reaches the tab that wrote. */
export const NSITE_ENV_CHANGED = 'nsite-env-changed';

/**
 * Every site's variables, by site id.
 *
 * Pairs rather than an object per site, because a name is the user's to
 * choose and `__proto__` is a valid one.
 */
type Store = Record<string, NsiteEnvVariable[]>;

function read(): Store {
  try {
    const raw = localStorage.getItem(NSITE_ENV_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  localStorage.setItem(NSITE_ENV_KEY, JSON.stringify(store));
  window.dispatchEvent(new Event(NSITE_ENV_CHANGED));
}

function isVariable(entry: unknown): entry is NsiteEnvVariable {
  return Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string';
}

/** A site's variables, ordered by name. Empty when it has none. */
export function getNsiteEnv(siteId: string): NsiteEnvVariable[] {
  const store = read();
  const list: unknown = Object.hasOwn(store, siteId) ? store[siteId] : [];
  return (Array.isArray(list) ? list.filter(isVariable) : [])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Set one variable, replacing any of the same name. Throws on a bad name or value. */
export function setNsiteEnvVariable(siteId: string, name: string, value: string): void {
  const parsedName = parseEnvName(name);
  const parsedValue = parseEnvValue(value);

  const store = read();
  const list = getNsiteEnv(siteId).filter(([n]) => n !== parsedName);
  if (list.length >= MAX_VARIABLES) {
    throw new Error(`A site can have at most ${MAX_VARIABLES} variables.`);
  }

  store[siteId] = [...list, [parsedName, parsedValue]];
  write(store);
}

/** Forget one variable. */
export function removeNsiteEnvVariable(siteId: string, name: string): void {
  const store = read();
  const list = getNsiteEnv(siteId).filter(([n]) => n !== name);

  if (list.length > 0) store[siteId] = list;
  else delete store[siteId];

  write(store);
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

/**
 * The script that defines `ENV` for a site's pages, or nothing when the site
 * has no variables.
 *
 * Run before any of the site's own code. It assigns `globalThis` rather than
 * `window`, which on a page is the same object, so the one script would serve
 * a worker as well.
 *
 * The values go in as JSON text handed to `JSON.parse` rather than as an
 * object literal: a literal reads a `"__proto__"` key as the prototype, and
 * `JSON.parse` keeps it as the variable it is. U+2028 and U+2029 are escaped
 * for the engines that still read them as line breaks inside a string.
 */
export function getNsiteEnvScript(vars: NsiteEnvVariable[]): string | undefined {
  if (vars.length === 0) return undefined;

  const json = JSON.stringify(Object.fromEntries(vars));
  const literal = JSON.stringify(json)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `globalThis.ENV = JSON.parse(${literal});\n`;
}
