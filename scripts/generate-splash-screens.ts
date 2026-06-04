/**
 * generate-splash-screens.ts — iOS PWA Splash-Screen-Generator (Welle 5).
 *
 * iOS-PWAs (`apple-mobile-web-app-capable`) zeigen beim Launch einen
 * Splash-Screen, der mit `<link rel="apple-touch-startup-image">` pro
 * Device-Resolution registriert wird. Next.js macht das via
 * `Metadata.appleStartupImage`.
 *
 * Dieses Skript rendert drei Splash-PNGs aus `public/icon-512.svg`
 * (oder `icon-512.png` als Fallback) — pitch-black background mit
 * zentriertem Logo. Die Auflösungen sind die drei wichtigsten 2024+
 * iPhone-Klassen.
 *
 * Run:
 *   npx tsx scripts/generate-splash-screens.ts
 *
 * Output:
 *   public/apple-touch-startup-image-2436x1125.png  (iPhone X/11/12/13/14 Pro)
 *   public/apple-touch-startup-image-2778x1284.png  (iPhone 14/15/16 Pro Max)
 *   public/apple-touch-startup-image-2208x1242.png  (iPhone 8 Plus)
 *
 * Hinweis: Wenn sharp / Logo nicht verfügbar ist, schreibt das Skript
 * 1px schwarze Placeholder-PNGs damit die Datei-Referenzen in
 * layout.tsx nicht 404en. Der User darf diese durch echte Designs
 * ersetzen.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SplashSize {
  width: number;
  height: number;
  filename: string;
  device: string;
}

const SIZES: SplashSize[] = [
  {
    width: 1125,
    height: 2436,
    filename: 'apple-touch-startup-image-2436x1125.png',
    device: 'iPhone X / 11 / 12 / 13 / 14 Pro',
  },
  {
    width: 1284,
    height: 2778,
    filename: 'apple-touch-startup-image-2778x1284.png',
    device: 'iPhone 14 / 15 / 16 Pro Max',
  },
  {
    width: 1242,
    height: 2208,
    filename: 'apple-touch-startup-image-2208x1242.png',
    device: 'iPhone 8 Plus',
  },
];

// 1×1 black PNG — fallback wenn sharp/logo nicht verfügbar.
const PLACEHOLDER_BLACK_1PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNg+A8AAQEBAJDuTukAAAAASUVORK5CYII=',
  'base64',
);

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');
  const outDir = resolve(root, 'public');
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Versuche sharp zu laden. Nicht zwingend (deps sind manchmal weg
  // auf VPS-Builds), Fallback auf Placeholder.
  let sharp: typeof import('sharp') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharp = require('sharp') as typeof import('sharp');
  } catch {
    console.warn('[splash] sharp nicht verfügbar — schreibe 1px-Placeholder.');
  }

  const logoPaths = [
    resolve(root, 'public/icon-512.png'),
    resolve(root, 'public/icon-512.svg'),
    resolve(root, 'public/icon.svg'),
    resolve(root, 'public/apple-touch-icon.png'),
  ];
  const logoPath = logoPaths.find((p) => existsSync(p));

  for (const sz of SIZES) {
    const outFile = resolve(outDir, sz.filename);
    if (sharp && logoPath) {
      try {
        // Logo zentriert auf Sheet-Schwarz. Logo nimmt ~25 % der
        // kürzeren Seite ein (iOS-Splash-Konvention).
        const minSide = Math.min(sz.width, sz.height);
        const logoSize = Math.round(minSide * 0.25);
        const resized = await sharp(logoPath)
          .resize(logoSize, logoSize, { fit: 'contain', background: { r: 7, g: 7, b: 7, alpha: 1 } })
          .toBuffer();
        await sharp({
          create: {
            width: sz.width,
            height: sz.height,
            channels: 4,
            background: { r: 7, g: 7, b: 7, alpha: 1 },
          },
        })
          .composite([{ input: resized, gravity: 'center' }])
          .png()
          .toFile(outFile);
        console.log(`[splash] ${sz.filename} (${sz.width}×${sz.height}) — ${sz.device}`);
        continue;
      } catch (err) {
        console.warn(`[splash] sharp-render fehlgeschlagen für ${sz.filename}:`, err);
      }
    }
    // Fallback: 1px schwarze PNG. Datei existiert, layout.tsx läuft
    // nicht in 404, aber visuelles Splash ist leer schwarz.
    writeFileSync(outFile, PLACEHOLDER_BLACK_1PX_PNG);
    console.log(`[splash] ${sz.filename} — placeholder (1px black)`);
  }

  console.log('[splash] done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
