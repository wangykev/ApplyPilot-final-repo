#!/usr/bin/env node
/**
 * Renders the ApplyPilot mark to the PNG sizes Chrome and the Web Store require.
 *
 *   node scripts/build-icons.mjs        # writes icons/icon{16,32,48,128}.png
 *
 * WHY GENERATE INSTEAD OF EXPORTING BY HAND
 * -----------------------------------------
 * The mark is a heading-indicator dial defined as pure geometry in
 * web/components/Logo.tsx (LogoMark). Hand-exported PNGs drift from it the first time the
 * component is touched, and there is no way to notice. This script is the same geometry,
 * so a change to the mark is one edit here and a re-run.
 *
 * No image library is available (and adding one to a repo whose extension ships no
 * dependencies is not worth it), so this rasterises directly: supersampled coverage per
 * pixel, then a PNG written with zlib. That is a few dozen lines and it is exact.
 *
 * DETAIL IS SIZE-DEPENDENT, DELIBERATELY
 * --------------------------------------
 * The SVG's faint inner ring and four tick marks are legible at 128px and turn to mud at
 * 16px, where they just darken the whole dial and cost the needle its contrast. So small
 * sizes draw a simplified mark. This is the standard reason icon sets are hand-tuned per
 * size rather than scaled; the thresholds are in `plan()`.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "icons");

const SIZES = [16, 32, 48, 128];

// ------------------------------------------------------------------- palette
// Straight from web/tailwind.config.ts, so the extension icon and the site agree.
const PANEL = [0x12, 0x18, 0x21]; // #121821 — icon plate
const HAIRLINE = [0x26, 0x30, 0x3d]; // #26303D — plate edge
const DIAL = [0x56, 0x62, 0x73]; // #566273 — bezel ring + ticks
const AMBER = [0xff, 0xb6, 0x27]; // #FFB627 — the needle. The one bold thing.

/**
 * The SVG is authored in a 32-unit viewBox. Everything below is expressed in those units
 * and scaled at render time, so the numbers can be compared against Logo.tsx directly.
 */
const VB = 32;

function plan(size) {
  return {
    // A rounded plate rather than a bare circle on transparency: the bezel is a dim grey,
    // which would be invisible against a dark browser toolbar with nothing behind it.
    plate: true,
    // The faint 9.5r inner ring and the four ticks: 128 and 48 only.
    innerRing: size >= 48,
    ticks: size >= 48,
    // The bezel ring reads as noise below 32px, where the needle alone is the mark.
    bezel: size >= 32,
    // Thicker strokes at small sizes or they vanish into a single grey pixel.
    bezelWidth: size >= 128 ? 1.6 : 2.0,
    /**
     * At 16px the dial furniture is gone, so the needle has the plate to itself and should
     * grow into it — drawn at its 128px proportions it becomes a 3-pixel smudge in a large
     * empty square, which is the toolbar size where legibility matters most. Scaling the
     * geometry about the centre keeps the silhouette identical, just larger in frame.
     */
    needleScale: size >= 32 ? 1 : 1.45,
  };
}

// ------------------------------------------------------------------ geometry
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}

/** Signed distance to a line segment, for the tick marks. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/** Even-odd point-in-polygon, for the needle. */
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rotate(x, y, deg, cx, cy) {
  const a = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/**
 * Colour at a point, in viewBox units. Returns [r,g,b,a] with a in 0..1.
 * Painted back-to-front, each layer compositing over what is under it.
 */
function sample(x, y, p) {
  let out = [0, 0, 0, 0];

  const over = (rgb, a) => {
    if (a <= 0) return;
    const na = a + out[3] * (1 - a);
    if (na <= 0) return;
    for (let i = 0; i < 3; i++) {
      out[i] = (rgb[i] * a + out[i] * out[3] * (1 - a)) / na;
    }
    out[3] = na;
  };

  const c = VB / 2;

  // --- plate
  if (p.plate) {
    // Inset slightly so the corners are not clipped by the canvas edge.
    const d = sdRoundRect(x, y, c, c, 15.5, 15.5, 7);
    over(PANEL, clamp01(0.5 - d));
    // A hairline edge, drawn as a thin band just inside the plate boundary.
    over(HAIRLINE, clamp01(0.5 - Math.abs(d + 0.5) * 1.4));
  }

  // --- bezel ring (SVG: circle r=14, stroke #26303D — brightened to DIAL for contrast)
  if (p.bezel) {
    const dist = Math.hypot(x - c, y - c);
    over(DIAL, clamp01(0.5 - Math.abs(dist - 12.4) / (p.bezelWidth / 2) * 0.5));
  }

  // --- faint inner ring (SVG: circle r=9.5, opacity .7)
  if (p.innerRing) {
    const dist = Math.hypot(x - c, y - c);
    over(HAIRLINE, clamp01(0.5 - Math.abs(dist - 8.6) / 0.5 * 0.5) * 0.85);
  }

  // --- tick marks at 0/90/180/270 (SVG: x1,y1 16,3.5 → 16,6.5)
  if (p.ticks) {
    for (const deg of [0, 90, 180, 270]) {
      const [ax, ay] = rotate(16, 4.6, deg, c, c);
      const [bx, by] = rotate(16, 7.0, deg, c, c);
      over(DIAL, clamp01(0.5 - (sdSegment(x, y, ax, ay, bx, by) - 0.55) * 1.6));
    }
  }

  // --- the needle (SVG: M16 5 L19.2 17 L16 14.5 L12.8 17 Z) + hub
  // Supersampling gives the polygon its edge, so this is a hard in/out test.
  // Both axes scale about the centre by the same factor, so the silhouette is preserved.
  const k = p.needleScale;
  const needle = [16, 5.2, 19.4, 17.2, 16, 14.4, 12.6, 17.2].map((v) => c + (v - c) * k);
  if (inPoly(x, y, needle)) over(AMBER, 1);
  const hub = Math.hypot(x - c, y - c);
  over(AMBER, clamp01(0.5 - (hub - 2.1 * k) * 1.8));

  return out;
}

// ----------------------------------------------------------------- rasterise
/** 4×4 supersampling. Cheap at these sizes and it is what makes the curves clean. */
const SS = 4;

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const p = plan(size);
  const scale = VB / size;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (pxi + (sx + 0.5) / SS) * scale;
          const uy = (py + (sy + 0.5) / SS) * scale;
          const [sr, sg, sb, sa] = sample(ux, uy, p);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const n = SS * SS;
      const o = (py * size + pxi) * 4;
      // Un-premultiply back to straight alpha for the PNG.
      px[o] = a > 0 ? Math.round(r / a) : 0;
      px[o + 1] = a > 0 ? Math.round(g / a) : 0;
      px[o + 2] = a > 0 ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ------------------------------------------------------------------ PNG write
var crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------- main
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`\nApplyPilot icons → ${path.relative(ROOT, OUT_DIR)}/`);
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  const p = plan(size);
  const detail = [p.bezel && "bezel", p.innerRing && "ring", p.ticks && "ticks"]
    .filter(Boolean)
    .join("+") || "needle only";
  console.log(`  icon${String(size).padEnd(3)}  ${String(png.length).padStart(5)} B   ${detail}`);
}
console.log(
  `\n  icon128.png doubles as the Web Store's required 128×128 store icon.\n` +
    `  Screenshots (1280×800) and the optional 440×280 promo tile are real captures —\n` +
    `  see docs/store-submission/listing.md.\n`,
);
