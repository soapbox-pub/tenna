#!/usr/bin/env node

/**
 * The IndexedDB conformance suite as a static site, to publish as an nsite and
 * open in Tenna on a phone — the only way to run it against the store the
 * phone really has, through the bridge the phone really has.
 *
 *     node scripts/build-wpt-site.mjs [out-dir]     # default: dist-wpt
 *
 * The site is the suite from `vendor/wpt` laid out as the WPT server would
 * serve it, a page per test file, and:
 *
 * - `/index.html`, which runs every page in turn in an iframe and prints, as
 *   text an accessibility tree can read, a summary line and one line for each
 *   subtest that did not pass. Same-origin iframes get Tenna's IndexedDB just
 *   as the page does.
 * - `/bench.html`, which times the same operations the WebKit baseline was
 *   taken on.
 *
 * Not part of the app and not deployed with it.
 */

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WPT = join(ROOT, "vendor/wpt");
const OUT = resolve(ROOT, argv[2] ?? "dist-wpt");

/** The files in the suite that exercise what Tenna does not claim to do. */
const SKIPPED = new Set(["storage-buckets.https.any.js"]);

function meta(source) {
  const out = { scripts: [], long: false, variants: [], window: true };
  for (const [, key, value] of source.matchAll(/^\/\/ META: (\w+)=(.*)$/gm)) {
    if (key === "script") out.scripts.push(value.trim());
    if (key === "timeout" && value.trim() === "long") out.long = true;
    if (key === "variant") out.variants.push(value.trim());
    if (key === "global") out.window = value.split(",").some((g) => ["window", "default"].includes(g.trim()));
  }
  if (!out.variants.length) out.variants.push("");
  return out;
}

/** A site path for a script as the suite names it from `from` (a site directory). */
function sitePath(from, script) {
  if (script === "/resources/WebIDLParser.js") return "/resources/WebIDLParser.js";
  if (script.startsWith("/")) return script;
  return join(from, script);
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(a, b);
    else await copyFile(a, b);
  }
}

await rm(OUT, { recursive: true, force: true });
for (const dir of ["IndexedDB", "resources", "common", "interfaces"]) await copyTree(join(WPT, dir), join(OUT, dir));
await copyFile(join(WPT, "resources/webidl2/lib/webidl2.js"), join(OUT, "resources/WebIDLParser.js"));

// Tells the runner what a page found. Loaded right after the harness.
await writeFile(join(OUT, "tenna-report.js"), `
add_completion_callback(function (tests, status) {
  parent.postMessage({
    __wpt: true,
    tests: tests.map(function (t) { return [t.name, t.status, t.message]; }),
    status: status.status,
    message: status.message,
  }, '*');
});
`);

const pages = [];
for (const file of (await readdir(join(WPT, "IndexedDB"))).filter((f) => f.endsWith(".any.js")).sort()) {
  if (SKIPPED.has(file)) continue;
  const source = await readFile(join(WPT, "IndexedDB", file), "utf8");
  const info = meta(source);
  if (!info.window) continue;

  // Support scripts name their own dependencies in META lines too.
  const scripts = [];
  const seen = new Set();
  const collect = async (from, list) => {
    for (const script of list) {
      const path = sitePath(from, script);
      if (seen.has(path)) continue;
      seen.add(path);
      const text = await readFile(join(OUT, path), "utf8").catch(() => "");
      await collect(dirname(path), meta(text).scripts);
      scripts.push(path);
    }
  };
  await collect("/IndexedDB", info.scripts);

  const html = `IndexedDB/${file.replace(/\.js$/, ".html")}`;
  await writeFile(join(OUT, html), `<!doctype html>
<meta charset="utf-8">
<title>${file}</title>
<script>self.GLOBAL = { isWindow: function () { return true; }, isWorker: function () { return false; }, isShadowRealm: function () { return false; } };</script>
<script src="/resources/testharness.js"></script>
<script src="/tenna-report.js"></script>
${scripts.map((s) => `<script src="${s}"></script>`).join("\n")}
<script src="/IndexedDB/${file}"></script>
`);
  pages.push({ file, html: `/${html}`, variants: info.variants, long: info.long });
}

await writeFile(join(OUT, "index.html"), `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IndexedDB conformance</title>
<style>
  body { font: 14px -apple-system, sans-serif; margin: 12px; padding-top: env(safe-area-inset-top); }
  #summary { font-weight: bold; }
  #failures div { margin: 2px 0; }
  iframe { width: 1px; height: 1px; border: 0; position: absolute; left: -10px; }
</style>
<p id="summary">Starting</p>
<div id="failures"></div>
<script>
  var PAGES = ${JSON.stringify(pages)};
  var STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
  var summary = document.getElementById('summary');
  var failures = document.getElementById('failures');
  var passed = 0, failed = 0, files = 0, started = Date.now();

  function report(line) {
    var div = document.createElement('div');
    div.textContent = line;
    failures.appendChild(div);
  }

  function run(page, variant) {
    return new Promise(function (resolve) {
      var frame = document.createElement('iframe');
      var timer = setTimeout(function () { finish({ tests: [], status: 2, message: 'no answer' }); }, page.long ? 90000 : 30000);
      function finish(result) {
        clearTimeout(timer);
        window.removeEventListener('message', listen);
        frame.remove();
        resolve(result);
      }
      function listen(event) {
        if (event.source === frame.contentWindow && event.data && event.data.__wpt) finish(event.data);
      }
      window.addEventListener('message', listen);
      frame.src = page.html + variant;
      document.body.appendChild(frame);
    });
  }

  (async function () {
    // Each file expects the origin to itself, as it has on the WPT server.
    summary.textContent = 'Clearing';
    var existing = await indexedDB.databases();
    for (var d = 0; d < existing.length; d++) {
      await new Promise(function (ok) { var r = indexedDB.deleteDatabase(existing[d].name); r.onsuccess = r.onerror = ok; });
    }
    for (var i = 0; i < PAGES.length; i++) {
      var page = PAGES[i];
      summary.textContent = 'Running ' + (i + 1) + ' of ' + PAGES.length + ': ' + page.file;
      for (var v = 0; v < page.variants.length; v++) {
        var result = await run(page, page.variants[v]);
        if (result.status !== 0) report(page.file + page.variants[v] + ' :: harness ' + ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'][result.status] + (result.message ? ' :: ' + result.message : ''));
        result.tests.forEach(function (t) {
          if (t[1] === 0) { passed++; return; }
          failed++;
          report(page.file + ' :: ' + t[0] + ' :: ' + STATUS[t[1]] + (t[2] ? ' :: ' + String(t[2]).slice(0, 160) : ''));
        });
      }
      files++;
    }
    summary.textContent = 'WPT done: ' + files + ' files, ' + passed + ' passed, ' + failed + ' failed, ' +
      Math.round((Date.now() - started) / 1000) + ' s, ' + existing.length + ' databases cleared first';

    // Then the benchmarks, in a frame of their own, their lines reported back.
    var bench = document.createElement('iframe');
    window.addEventListener('message', function (event) {
      if (event.source === bench.contentWindow && event.data && event.data.__bench) report('bench: ' + event.data.line);
    });
    bench.src = '/bench.html';
    document.body.appendChild(bench);
  })();
</script>
`);

await writeFile(join(OUT, "bench.html"), `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IndexedDB benchmarks</title>
<style>body { font: 14px -apple-system, sans-serif; margin: 12px; padding-top: env(safe-area-inset-top); }</style>
<div id="out">Running</div>
<script>
  var out = document.getElementById('out');
  var lines = [];
  function line(s) {
    lines.push(s);
    out.textContent = '';
    lines.forEach(function (l) { var d = document.createElement('div'); d.textContent = l; out.appendChild(d); });
    if (parent !== window) parent.postMessage({ __bench: true, line: s }, '*');
  }
  function p(r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); }
  (async function () {
    try {
      await p(indexedDB.deleteDatabase('bench'));
      var rq = indexedDB.open('bench', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('s'); };
      var db = await p(rq);
      var N = 10000, t;
      t = performance.now();
      await new Promise(function (ok) { var tx = db.transaction('s', 'readwrite'); var s = tx.objectStore('s'); for (var i = 0; i < N; i++) s.put({ i: i, name: 'item ' + i, tags: ['a', 'b'] }, i); tx.oncomplete = ok; });
      line(N + ' puts in one transaction: ' + (performance.now() - t).toFixed(1) + ' ms');
      t = performance.now();
      var all = await p(db.transaction('s').objectStore('s').getAll());
      line('getAll of ' + all.length + ': ' + (performance.now() - t).toFixed(1) + ' ms');
      t = performance.now();
      var seen = await new Promise(function (ok) { var n = 0; var r = db.transaction('s').objectStore('s').openCursor(); r.onsuccess = function () { if (r.result) { n++; r.result.continue(); } else ok(n); }; });
      line('cursor over ' + seen + ': ' + (performance.now() - t).toFixed(1) + ' ms');
      t = performance.now();
      for (var j = 0; j < 500; j++) await p(db.transaction('s').objectStore('s').get(j));
      line('single get, own transaction: ' + ((performance.now() - t) / 500).toFixed(3) + ' ms');
      t = performance.now();
      for (var k = 0; k < 20; k++) await indexedDB.databases();
      line('databases(): ' + ((performance.now() - t) / 20).toFixed(3) + ' ms');
      // The bridge itself: a message the store answers at once, on its own thread.
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tennaIDB;
      if (handler) {
        t = performance.now();
        for (var m = 0; m < 500; m++) await handler.postMessage('[s9:migration]');
        line('bare round trip: ' + ((performance.now() - t) / 500).toFixed(3) + ' ms');
      }
      db.close();
      line('bench done');
    } catch (e) { line('bench failed: ' + e); }
  })();
</script>
`);

console.log(`${pages.length} pages in ${relative(ROOT, OUT)}`);
