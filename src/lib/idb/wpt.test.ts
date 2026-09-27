/**
 * The web-platform-tests IndexedDB suite, run against Tenna's IndexedDB.
 *
 * The suite lives in `vendor/wpt`, copied unchanged from the commit in
 * `vendor/wpt/COMMIT`. Each test file gets a fresh jsdom window of its own,
 * into which goes the very script iOS ships (built by `build-idb.mjs`),
 * talking the real wire protocol to a fresh `MemoryStore`, then
 * testharness.js, the file's support scripts, and the file.
 *
 * `wpt-expectations.json` lists the subtests known to fail, each with the
 * reason. A subtest that fails and is not listed fails this suite, and so
 * does one that is listed but now passes, so the list stays the truth.
 */

import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import { MemoryStore } from './memoryStore';
import expectations from './wpt-expectations.json';

const ROOT = join(__dirname, '../../../vendor/wpt');
const SUITE = join(ROOT, 'IndexedDB');

/** Files that exercise what a jsdom window cannot be made to have. */
const SKIPPED: Record<string, string> = expectations.skipped;
const EXPECTED_FAILURES: Record<string, Record<string, string>> = expectations.failures;

const STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];

interface Meta {
  scripts: string[];
  long: boolean;
  variants: string[];
  window: boolean;
}

function readMeta(source: string): Meta {
  const meta: Meta = { scripts: [], long: false, variants: [], window: true };
  for (const match of source.matchAll(/^\/\/ META: (\w+)=(.*)$/gm)) {
    const [, key, value] = match;
    if (key === 'script') meta.scripts.push(value.trim());
    if (key === 'timeout' && value.trim() === 'long') meta.long = true;
    if (key === 'variant') meta.variants.push(value.trim());
    if (key === 'global') meta.window = value.split(',').some((g) => g.trim() === 'window' || g.trim() === 'default');
  }
  if (!meta.variants.length) meta.variants.push('');
  return meta;
}

async function resolveScript(from: string, path: string): Promise<string> {
  if (path === '/resources/WebIDLParser.js') return join(ROOT, 'resources/webidl2/lib/webidl2.js');
  if (path.startsWith('/')) return join(ROOT, path);
  return join(from, path);
}

/** A MessageChannel good enough for the engine: one-way, a task per message. */
class FastChannel {
  readonly port1: { onmessage: ((event: object) => void) | null } = { onmessage: null };
  readonly port2 = {
    postMessage: () => {
      setImmediate(() => this.port1.onmessage?.({}));
    },
  };
}

let bundle: string;
const sources = new Map<string, string>();

async function source(path: string): Promise<string> {
  let text = sources.get(path);
  if (text === undefined) {
    text = await readFile(path, 'utf8');
    sources.set(path, text);
  }
  return text;
}

type Result = [name: string, status: string, message: string | null];

async function runFile(file: string, variant: string): Promise<{ results: Result[]; harness: string }> {
  const path = join(SUITE, file);
  const text = await source(path);
  const meta = readMeta(text);
  // Support scripts load each other through their own META lines.
  const scripts: string[] = [];
  const seen = new Set<string>();
  const collect = async (from: string, list: string[]) => {
    for (const s of list) {
      const resolved = await resolveScript(from, s);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      await collect(join(resolved, '..'), readMeta(await source(resolved)).scripts);
      scripts.push(resolved);
    }
  };
  await collect(SUITE, meta.scripts);
  // Everything is read before the window exists: an await on real I/O
  // between scripts would let its load event fire, and the harness would
  // decide the file had no tests.
  const harness = await source(join(ROOT, 'resources/testharness.js'));
  const shims = await source(join(__dirname, 'wpt-shims.js'));
  const support = await Promise.all(scripts.map(source));

  const dom = new JSDOM('<!doctype html><html><head><title></title></head><body></body></html>', {
    url: `https://wpt.test/IndexedDB/${file.replace(/\.js$/, '.html')}${variant}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // Handlers the tests make throw on purpose would otherwise fill the log.
    virtualConsole: process.env.WPT_CONSOLE ? new VirtualConsole().forwardTo(console) : new VirtualConsole(),
  });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  // jsdom has no MessageChannel, and the engine's per-event tasks would
  // otherwise each wait on a clamped timer. setImmediate is a task too.
  win.MessageChannel = FastChannel as unknown as typeof MessageChannel;
  const store = new MemoryStore(setImmediate);
  win.__tennaIDBTransport = store.transport;
  // idlharness reads the IDL it checks against with fetch.
  win.fetch = (async (url: string) => {
    const idl = await readFile(join(ROOT, new URL(url, 'https://wpt.test/').pathname), 'utf8');
    return { ok: true, status: 200, text: async () => idl };
  }) as unknown as typeof fetch;
  win.GLOBAL = { isWindow: () => true, isWorker: () => false, isShadowRealm: () => false };

  const done = new Promise<{ results: Result[]; harness: string }>((resolve) => {
    win.__done = (results: Result[], status: string) => resolve({ results, harness: status });
  });
  // As <script>s, not eval: a strict script's declarations are only global
  // when it is a script.
  const run = (code: string) => {
    const script = win.document.createElement('script');
    script.textContent = code;
    win.document.head.appendChild(script);
  };
  run(shims);
  run(bundle);
  // The tests themselves use a real one, to detach buffers.
  win.MessageChannel = MessageChannel;
  run(harness);
  if (process.env.WPT_TRACE) {
    win.__trace = (line: string) => void appendFile(process.env.WPT_TRACE!, `${file}: ${line}\n`);
    run(`window.onerror = (m) => __trace('error ' + m); add_result_callback((t) => __trace('result ' + t.status + ' ' + t.name + ' ' + t.message));`);
  }
  run(`
    setup({ explicit_timeout: true });
    add_completion_callback((tests, status) => {
      window.__done(tests.map((t) => [t.name, ${JSON.stringify(STATUS)}[t.status], t.message]), ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'][status.status] + (status.message ? ': ' + status.message : ''));
    });
  `);
  for (const script of support) run(script);
  run(text);

  const limit = meta.long ? 60_000 : 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ results: Result[]; harness: string }>((resolve) => {
    timer = setTimeout(() => {
      // Ask the harness for what it has so far rather than losing it all.
      run('timeout()');
      setTimeout(() => resolve({ results: [], harness: 'TIMEOUT' }), 1000);
    }, limit);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
    win.close();
  }
}

const files = (await readdir(SUITE)).filter((f) => f.endsWith('.any.js')).sort();

beforeAll(async () => {
  const { buildIndexedDB } = await import('../../../scripts/build-idb.mjs');
  bundle = await buildIndexedDB({ minify: false });
}, 60_000);

describe('web-platform-tests: IndexedDB', () => {
  for (const file of files) {
    if (SKIPPED[file]) {
      it.skip(`${file} — ${SKIPPED[file]}`, () => {});
      continue;
    }
    it(file, { timeout: 90_000 }, async () => {
      const meta = readMeta(await source(join(SUITE, file)));
      if (!meta.window) return;
      const unexpected: string[] = [];
      const expectedFailures = EXPECTED_FAILURES[file] ?? {};
      const failedNames = new Set<string>();
      for (const variant of meta.variants) {
        const { results, harness } = await runFile(file, variant);
        if (harness !== 'OK' && !expectedFailures['(harness)']) unexpected.push(`harness: ${harness}`);
        for (const [name, status, message] of results) {
          if (status === 'PASS') continue;
          failedNames.add(name);
          if (!(name in expectedFailures)) unexpected.push(`${status}: ${name}${message ? ` — ${message}` : ''}`);
        }
      }
      if (process.env.WPT_REPORT) {
        await appendFile(process.env.WPT_REPORT, JSON.stringify({ file, unexpected, failed: [...failedNames] }) + '\n');
      }
      const nowPassing = Object.keys(expectedFailures).filter((name) => name !== '(harness)' && !failedNames.has(name));
      expect(unexpected, 'subtests that fail and are not expected to').toEqual([]);
      expect(nowPassing, 'subtests expected to fail that now pass').toEqual([]);
    });
  }
});
