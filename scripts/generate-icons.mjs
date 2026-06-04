#!/usr/bin/env node
/**
 * lazyOS — Icon Rasterizer
 *
 * Liest public/icon.svg + public/icon-maskable.svg und erzeugt:
 *   - public/icon-192.png  (any, rounded)
 *   - public/icon-512.png  (any)
 *   - public/icon-maskable-512.png (maskable, full-bleed)
 *   - public/apple-touch-icon.png (180x180, any)
 *
 * Nutzung: node scripts/generate-icons.mjs
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = resolve(__dirname, "..", "public");

const anySvg = readFileSync(resolve(pub, "icon.svg"));
const maskSvg = readFileSync(resolve(pub, "icon-maskable.svg"));

const targets = [
  { svg: anySvg, size: 192, out: "icon-192.png" },
  { svg: anySvg, size: 512, out: "icon-512.png" },
  { svg: maskSvg, size: 512, out: "icon-maskable-512.png" },
  { svg: anySvg, size: 180, out: "apple-touch-icon.png" },
];

for (const { svg, size, out } of targets) {
  const path = resolve(pub, out);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 7, g: 7, b: 7, alpha: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(path);
  console.log(`wrote ${out} (${size}x${size})`);
}
