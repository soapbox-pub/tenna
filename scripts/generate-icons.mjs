#!/usr/bin/env node

/**
 * Every icon this app ships, rasterised from `public/logo.svg`.
 *
 * The PNGs are build output, not source: they are gitignored and remade by
 * `npm run icons`, which `dev`, `build`, and `test` all run first. That keeps
 * one file — the SVG — as the thing anyone edits, and it keeps four hundred
 * kilobytes of binaries that nobody can diff out of the history.
 *
 * Rendering is `sharp`, and deliberately so. A shell script around Inkscape or
 * ImageMagick would be shorter, but neither is present in the `node:22` image
 * CI builds in, and an icon step that only works on the author's laptop is one
 * that will quietly ship a stale icon. `sharp` arrives as a prebuilt binary
 * with librsvg inside it, so `npm i` is the whole setup.
 */

import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "public/logo.svg");

/**
 * What sits behind the sun wherever an icon can't be transparent.
 *
 * The app's own background, so an installed Tenna is the same colour from its
 * launcher tile through its splash to its first paint. Kept in step with
 * `--background` in `src/index.css` and `nsiteWindow` in `colors.xml`.
 */
const BACKGROUND = "#150609";

/**
 * How wide the sun is drawn, as a fraction of each icon's canvas.
 *
 * `adaptive` is the Android launcher, which shows the middle 72dp of a 108dp
 * canvas and guarantees only the 66dp circle inside that. Drawn flush to the
 * 66dp keyline the sun is technically safe and looks wedged: a ten-rayed mark
 * reads as pressing outwards, so the tips want air behind them that a flat
 * wordmark would not. 60dp is where the ring of background around it becomes
 * legible as a deliberate margin instead of a near miss.
 *
 * `maskable` is the web equivalent, and is specified rather than observed: an
 * installer may crop anything outside a circle four fifths across. The same
 * step inwards from that circle, for the same reason.
 *
 * `legacy` and `round` are 48dp icons drawn whole — no mask, so the only
 * question is how much air looks right — and `touch` is what iOS puts behind
 * its own rounded rect, which crops far less than a circle does.
 */
const ART = {
  adaptive: 60 / 108,
  maskable: 0.66,
  legacy: 0.74,
  round: 0.66,
  touch: 0.76,
};

/** Android density buckets, and the multiplier each one applies to a dp. */
const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

const MIPMAP = "android/app/src/main/res/mipmap";
const IOS_APPICON = "ios/App/App/Assets.xcassets/AppIcon.appiconset";

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * An SVG with its margin removed, at a resolution nothing below asks to
 * exceed.
 *
 * `logo.svg` carries padding of its own — the rays stop well short of the
 * viewBox — and every safe-zone fraction here is about the sun, not about
 * whatever whitespace the drawing happens to be wrapped in. Trimming to the
 * ink means those fractions mean what they say, and go on meaning it if the
 * artwork is ever redrawn at a different scale.
 *
 * The recoloured copy behind the themed icon trims to the same box, because
 * the outermost shape in both is the outline and both are drawn on it.
 */
async function ink(svg) {
  const rendered = await sharp(Buffer.from(svg))
    .resize(2048, 2048, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();

  return sharp(rendered).trim({ background: TRANSPARENT, threshold: 0 }).png().toBuffer();
}

/** The sun, `fraction` of `canvas` across, centred on a transparent square. */
async function sun(art, canvas, fraction) {
  const size = Math.round(canvas * fraction);
  const scaled = await sharp(art)
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();

  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: scaled }])
    .png()
    .toBuffer();
}

/** A square PNG of the app's background, with the sun on it. */
async function tile(art, canvas, fraction) {
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: BACKGROUND } })
    .composite([{ input: await sun(art, canvas, fraction) }])
    .png()
    .toBuffer();
}

/** The same, clipped to the inscribed circle, for `ic_launcher_round`. */
async function disc(art, canvas, fraction) {
  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">` +
      `<circle cx="${canvas / 2}" cy="${canvas / 2}" r="${canvas / 2}" fill="#fff"/></svg>`,
  );

  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: BACKGROUND } })
    .composite([
      { input: circle, blend: "dest-in" },
      { input: await sun(art, canvas, fraction) },
    ])
    .png()
    .toBuffer();
}

/**
 * Which of the logo's colours are drawn in the themed icon, and which are
 * holes punched through it.
 *
 * Android 13's launcher throws the colour away and tints what is left with
 * the user's wallpaper, so a themed icon is a one-bit drawing and has to be
 * designed as one rather than derived. Reducing the artwork by some rule
 * about brightness gets a silhouette, but the rule decides where the holes
 * fall, and here it fell in the wrong place: the pupil and the iris came out
 * as one solid hub inside a thin ring, which is a gear and not an eye.
 *
 * Naming each colour makes it a design decision instead, and the decision
 * turns on where the eye *ends*. In colour that edge is the red ring meeting
 * the yellow body — a boundary between two things that are both drawn — and
 * one bit has no way to say that, so an eye whose ring is inked begins where
 * the white begins and comes out three quarters the size it looks in colour.
 * The opening has to start where the red ring starts.
 *
 * Inside it the four bands collapse to one. Alternating them all the way in
 * is faithful and unreadable: by mdpi the rings are three pixels each and the
 * eye goes lacy. A single filled disc in a single gap is the same eye at the
 * same size with one edge instead of four, and it is the reading that
 * survives being small — which is the whole job of a themed icon. The pupil
 * ends up drawn along with everything else it sits in, even though it is the
 * darkest thing in the logo: nothing about a stencil says the dark parts are
 * the drawn ones.
 */
const MONO = {
  "#ac0d09": "#fff", // Outline, which is where the silhouette's edge comes from.
  "#febf14": "#fff", // The body and the rays.
  "#c81615": "#000", // The ring the eye sits in — the gap that sets the eye apart.
  "#fefdfd": "#fff", // The white,
  "#fecf07": "#fff", // the iris,
  "#900301": "#fff", // and the pupil, filled in together as the eye itself.
};

/**
 * `logo.svg` repainted in black and white, ready to be read as a stencil.
 *
 * Substituting colours in the source text rather than compositing shapes
 * ourselves means the drawing order does the work — the eye is painted over
 * the body in the original, so it is painted over it here too — and it means
 * the edges are antialiased by the same renderer that draws everything else.
 * A colour the table does not classify is an error rather than a default,
 * because the alternative is a silhouette that is quietly wrong.
 */
async function stencil() {
  const source = await readFile(SOURCE, "utf8");

  const used = [...source.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map(([, hex]) => hex);
  const unknown = [...new Set(used)].filter((hex) => !(hex in MONO));

  if (unknown.length) {
    throw new Error(`${relative(ROOT, SOURCE)} paints with ${unknown.join(", ")}, which MONO does not classify`);
  }

  return Object.entries(MONO).reduce((svg, [from, to]) => svg.replaceAll(from, to), source);
}

/** The stencil as an alpha channel, which is all a themed icon really is. */
async function monochrome(art, canvas, fraction) {
  const shape = await sun(art, canvas, fraction);

  // Flattening onto black turns both kinds of nothing — the holes, which are
  // painted black, and the transparency around the rays — into the same zero.
  const alpha = await sharp(shape)
    .flatten({ background: "#000000" })
    .toColourspace("b-w")
    .toBuffer();

  return sharp({ create: { width: canvas, height: canvas, channels: 3, background: "#000000" } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

/**
 * An `.ico` wrapping PNGs at the three sizes Windows and the browsers ask for.
 *
 * Hand-assembled because `sharp` doesn't write the container and it is barely
 * a container: a six-byte header, sixteen bytes per image, then the PNGs
 * themselves. Every ICO reader since Vista accepts PNG payloads, so there is
 * no BMP path to write.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // Type 1 is an icon, as opposed to a cursor.
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at); // 0 is how 256 is spelled.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4); // Colour planes.
    directory.writeUInt16LE(32, at + 6); // Bits per pixel.
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map(({ data }) => data)]);
}

async function emit(path, data) {
  const full = join(ROOT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return path;
}

/** The mtime of `path`, or 0 if it isn't there. */
async function age(path) {
  try {
    return (await stat(join(ROOT, path))).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every file this script owns, so it can tell whether it has anything to do.
 *
 * `dev`, `build`, and `test` each run it, and rasterising thirty PNGs on every
 * one of those would be a second nobody asked to spend. Listing the outputs up
 * front costs a few `stat` calls instead.
 */
async function outputs() {
  const paths = [
    "public/favicon.ico",
    "public/apple-touch-icon.png",
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/icons/icon-maskable-192.png",
    "public/icons/icon-maskable-512.png",
    "android/app/src/main/res/values/ic_launcher_background.xml",
  ];

  for (const [density] of DENSITIES) {
    paths.push(
      `${MIPMAP}-${density}/ic_launcher.png`,
      `${MIPMAP}-${density}/ic_launcher_round.png`,
      `${MIPMAP}-${density}/ic_launcher_foreground.png`,
      `${MIPMAP}-${density}/ic_launcher_monochrome.png`,
    );
  }

  // Only once there is an Xcode project to put it in — otherwise a file that
  // is never written would make the script think it always has work to do.
  if (await age(`${IOS_APPICON}/Contents.json`)) {
    paths.push(`${IOS_APPICON}/AppIcon-512@2x.png`);
  }

  return paths;
}

async function stale() {
  const source = Math.max(await age("public/logo.svg"), await age("scripts/generate-icons.mjs"));
  const built = await Promise.all((await outputs()).map(age));
  return built.some((mtime) => mtime < source);
}

async function main() {
  const force = argv.includes("--force");

  if (!force && !(await stale())) return;

  const art = await ink(await readFile(SOURCE, "utf8"));
  const stamp = await ink(await stencil());
  const written = [];

  // ── The web app ──────────────────────────────────────────────────────────
  //
  // The plain icons go out full-bleed: nothing crops them, and the padding
  // already in the artwork is the padding they want. The maskable pair is the
  // same sun pulled in behind the safe circle, on the app's own background,
  // because a maskable icon with a transparent background gets a black one.

  for (const size of [192, 512]) {
    written.push(await emit(`public/icons/icon-${size}.png`, await sun(art, size, 1)));
    written.push(
      await emit(
        `public/icons/icon-maskable-${size}.png`,
        await tile(art, size, ART.maskable),
      ),
    );
  }

  // iOS rounds the corners itself and ignores transparency, so this one is
  // square, opaque, and drawn a little larger than a maskable icon: the
  // rounded rect it ends up in crops far less than a circle does.
  written.push(await emit("public/apple-touch-icon.png", await tile(art, 180, ART.touch)));

  // Browsers ask for `/favicon.ico` whether or not anything links to it, and
  // the sun survives being sixteen pixels across better than most marks would.
  written.push(
    await emit(
      "public/favicon.ico",
      ico(
        await Promise.all(
          [16, 32, 48].map(async (size) => ({ size, data: await sun(art, size, 1) })),
        ),
      ),
    ),
  );

  // ── Android ──────────────────────────────────────────────────────────────
  //
  // The adaptive layers are drawn on the 108dp canvas the launcher masks; the
  // legacy pair are 48dp icons drawn whole, which is why they carry their own
  // background and their own rounding.

  for (const [density, scale] of DENSITIES) {
    const adaptive = Math.round(108 * scale);
    const legacy = Math.round(48 * scale);

    written.push(
      await emit(
        `${MIPMAP}-${density}/ic_launcher_foreground.png`,
        await sun(art, adaptive, ART.adaptive),
      ),
      await emit(
        `${MIPMAP}-${density}/ic_launcher_monochrome.png`,
        await monochrome(stamp, adaptive, ART.adaptive),
      ),
      await emit(`${MIPMAP}-${density}/ic_launcher.png`, await tile(art, legacy, ART.legacy)),
      await emit(`${MIPMAP}-${density}/ic_launcher_round.png`, await disc(art, legacy, ART.round)),
    );
  }

  // The colour behind the adaptive foreground, which the launcher composites
  // itself. Generated so that `BACKGROUND` above is the only place it is said.
  written.push(
    await emit(
      "android/app/src/main/res/values/ic_launcher_background.xml",
      `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<!-- Generated by scripts/generate-icons.mjs. Edit BACKGROUND there. -->\n` +
        `<resources>\n` +
        `    <color name="ic_launcher_background">${BACKGROUND}</color>\n` +
        `</resources>\n`,
    ),
  );

  // ── iOS ──────────────────────────────────────────────────────────────────
  //
  // Skipped unless `npx cap add ios` has been run, since the asset catalogue
  // is part of the native project and not of this repo by default. One
  // 1024×1024 is all a modern app icon set needs; Xcode derives the rest.

  if (await age(`${IOS_APPICON}/Contents.json`)) {
    written.push(await emit(`${IOS_APPICON}/AppIcon-512@2x.png`, await tile(art, 1024, ART.touch)));
  }

  console.log(`icons: ${written.length} files from ${relative(ROOT, SOURCE)}`);
}

main().catch((error) => {
  console.error(`icons: ${error.message}`);
  exit(1);
});
