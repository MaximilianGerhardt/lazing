#!/usr/bin/env node
/**
 * scripts/render-repo-images.mjs — render the repo's README/marketing images
 * from on-brand, self-contained HTML templates to PNG via headless Chromium.
 *
 * This REPLACES the old generative approach (scripts/gen-marketing-images.ts,
 * Codex image_gen) which produced off-brand AI-slop. These renders embed the
 * real laz.ing Design Manifest v1.0: pitch-black #070707 canvas, the three
 * subtle radial glows (orange #FF9F0A · purple #BF5AF2 · green #30D158, all at
 * ~5–8% alpha), a faint film grain, the SF Pro / -apple-system font stack,
 * hairline borders and generous whitespace. Apple-subtle, not loud.
 *
 * Usage:
 *   node scripts/render-repo-images.mjs            # render all images
 *   node scripts/render-repo-images.mjs hero       # render one by name
 *   node scripts/render-repo-images.mjs --list     # list known images
 *
 * Output → docs/assets/<name>.png (the exact filenames README.md references).
 * Rendered at deviceScaleFactor: 2 for retina crispness, then the PNG itself is
 * the slot size × 2.
 *
 * Engine resolution (idempotent, no repo dependency changes required):
 *   1. local node_modules/playwright
 *   2. the npx cache (~/.npm/_npx/<hash>/node_modules/playwright)
 *   3. last resort: `npx --yes playwright install chromium` then re-resolve
 *
 * No external template files, no network at render time — every template is an
 * inline HTML string in this file, so the script is fully self-contained.
 */

import { mkdirSync, statSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "assets");

/* ─────────────────────────────────────────────────────────────────────────
   Design tokens — mirrored verbatim from app/globals.css :root so the renders
   are guaranteed to match the running app's pitch-black Apple-dark aesthetic.
   ───────────────────────────────────────────────────────────────────────── */
const T = {
  sheet: "#070707",
  sheet1: "#0A0A0B",
  sheet2: "#0E0E0F",
  sheet3: "#141416",
  ink: "#F5F5F7",
  ink2: "#A1A1A6",
  ink3: "#636366",
  ink4: "#3A3A3C",
  line: "rgba(255,255,255,0.06)",
  line2: "rgba(255,255,255,0.12)",
  card: "rgba(255,255,255,0.04)",
  card2: "rgba(255,255,255,0.08)",
  aOrange: "#FF9F0A", // --a-north
  aGreen: "#30D158", // --a-clientb
  aPurple: "#BF5AF2", // --a-own
  aBlue: "#64D2FF", // --a-private
  eClaude: "#D97757",
  eCodex: "#10A37F",
  fontDisplay:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
  fontSans:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  fontMono: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
};

/* The three radial glows, verbatim alphas from globals.css body::after.
   `extent` is the gradient stop (where it fades to transparent). */
function glowLayer({ scale = 1 } = {}) {
  return `
    radial-gradient(ellipse at 15% 0%,  rgba(255,159,10,${0.08 * scale}), transparent 45%),
    radial-gradient(ellipse at 85% 20%, rgba(191,90,242,${0.06 * scale}), transparent 45%),
    radial-gradient(ellipse at 50% 100%, rgba(48,209,88,${0.05 * scale}), transparent 55%)
  `.trim();
}

/* Faint film grain, same fractalNoise SVG filter as globals.css body::before,
   slightly softer for a still image (opacity 0.4 vs 0.5). */
const GRAIN_SVG =
  "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/></filter>" +
  "<rect width='200' height='200' filter='url(%23n)' opacity='0.35'/></svg>";

/* ─────────────────────────────────────────────────────────────────────────
   Shared shell — pitch-black canvas + glows + grain + base typography.
   Every template body is composed onto this shell.
   ───────────────────────────────────────────────────────────────────────── */
function shell({ w, h, glowScale = 1, inner }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; }
  body {
    position: relative;
    background: ${T.sheet};
    color: ${T.ink};
    font-family: ${T.fontSans};
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
    overflow: hidden;
  }
  /* glow layer — sits under everything */
  body::after {
    content: ""; position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background-image: ${glowLayer({ scale: glowScale })};
  }
  /* grain overlay — over the glows, under the content */
  body::before {
    content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background-image: url("${GRAIN_SVG}");
    opacity: 0.4; mix-blend-mode: overlay;
  }
  .stage { position: relative; z-index: 2; width: 100%; height: 100%; }
  .wordmark {
    font-family: ${T.fontDisplay};
    font-weight: 600;
    letter-spacing: -0.03em;
    color: ${T.ink};
  }
  .wordmark .dot { color: ${T.aGreen}; }
  .eyebrow {
    font-family: ${T.fontMono};
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: ${T.ink3};
    font-weight: 500;
  }
  .hair { border: 1px solid ${T.line}; }
  .card {
    background: ${T.card};
    border: 1px solid ${T.line};
    border-radius: 18px;
  }
  .dim { color: ${T.ink2}; }
  .faint { color: ${T.ink3}; }
</style></head>
<body><div class="stage">${inner}</div></body></html>`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Templates
   ───────────────────────────────────────────────────────────────────────── */

// HERO — 1200×630 OG-style. Wordmark + one-line thesis + a quiet feature row.
function heroTemplate() {
  const w = 1200,
    h = 630;
  const inner = `
  <div style="
      position:absolute; inset:0;
      display:flex; flex-direction:column; justify-content:center;
      padding: 88px 96px;">
    <div class="eyebrow" style="font-size:15px; margin-bottom:34px;">
      LOCAL-FIRST&nbsp;&nbsp;·&nbsp;&nbsp;SELF-HOSTED&nbsp;&nbsp;·&nbsp;&nbsp;AGPL-3.0
    </div>

    <div class="wordmark" style="font-size:128px; line-height:0.92; margin-bottom:40px;">
      laz<span class="dot">.</span>ing
    </div>

    <div style="
        font-family:${T.fontDisplay};
        font-weight:500;
        font-size:33px;
        line-height:1.32;
        letter-spacing:-0.012em;
        color:${T.ink};
        max-width:880px;">
      The local-first AI agent runtime that keeps AI work
      <span style="color:${T.ink2};">steerable after the shot is fired.</span>
    </div>

    <div style="display:flex; gap:14px; margin-top:52px;">
      ${heroChip("Local PII vault", T.aGreen)}
      ${heroChip("Multi-agent, in parallel", T.aPurple)}
      ${heroChip("Plan → approve → execute", T.aOrange)}
    </div>
  </div>`;
  return { w, h, glowScale: 1, inner: shell({ w, h, glowScale: 1, inner }) };
}

function heroChip(label, dot) {
  return `<div style="
      display:inline-flex; align-items:center; gap:11px;
      padding:11px 20px;
      background:${T.card};
      border:1px solid ${T.line};
      border-radius:999px;
      font-family:${T.fontSans};
      font-size:16px;
      color:${T.ink2};
      letter-spacing:-0.005em;">
    <span style="width:8px; height:8px; border-radius:50%;
      background:${dot}; box-shadow:0 0 12px ${dot}66;"></span>
    ${label}
  </div>`;
}

/* Shared frame for the three square feature tiles (640×640 → 320 slot @2x). */
function featureTile({ accent, eyebrow, title, body, artHtml }) {
  const w = 640,
    h = 640;
  const inner = `
  <div style="position:absolute; inset:0; display:flex; flex-direction:column;
      padding:54px 54px 48px;">
    <!-- art region -->
    <div style="flex:1; position:relative; display:flex; align-items:center; justify-content:center;">
      ${artHtml}
    </div>
    <!-- caption block -->
    <div style="margin-top:8px;">
      <div class="eyebrow" style="font-size:13px; margin-bottom:14px;">
        <span style="color:${accent};">●</span>&nbsp;&nbsp;${eyebrow}
      </div>
      <div style="font-family:${T.fontDisplay}; font-weight:600; font-size:32px;
          letter-spacing:-0.02em; line-height:1.08; color:${T.ink}; margin-bottom:12px;">
        ${title}
      </div>
      <div style="font-family:${T.fontSans}; font-size:17px; line-height:1.5;
          color:${T.ink2}; max-width:480px;">
        ${body}
      </div>
    </div>
  </div>`;
  return { w, h, glowScale: 0.7, inner: shell({ w, h, glowScale: 0.7, inner }) };
}

// VAULT — a hairline-locked panel: real value redacted to an opaque token.
function vaultTemplate() {
  const accent = T.aGreen;
  const art = `
  <div class="card" style="width:420px; padding:30px 32px; border-radius:22px;
      background:${T.sheet2}; border:1px solid ${T.line2};
      box-shadow:0 24px 60px rgba(0,0,0,0.55);">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:24px;">
      <div class="eyebrow" style="font-size:12px;">CLOUD PAYLOAD</div>
      <div style="display:inline-flex; align-items:center; gap:8px;
          padding:6px 12px; border-radius:999px; border:1px solid ${accent}44;
          background:${accent}14; color:${accent}; font-family:${T.fontMono};
          font-size:12px; letter-spacing:0.04em;">
        <span style="width:7px;height:7px;border-radius:50%;background:${accent};
          box-shadow:0 0 10px ${accent};"></span>SEALED
      </div>
    </div>
    ${vaultRow("email", "alex@example.com", "‹tok_7f3a›", accent)}
    ${vaultRow("iban", "DE•• •••• •••• ••", "‹tok_b1e9›", accent)}
    ${vaultRow("name", "real value", "‹tok_2c44›", accent)}
    <div style="margin-top:22px; padding-top:18px; border-top:1px solid ${T.line};
        font-family:${T.fontMono}; font-size:12.5px; color:${T.ink3};
        display:flex; align-items:center; gap:9px;">
      <span style="color:${accent};">✓</span> AES-encrypted on-device · build-gate enforced
    </div>
  </div>`;
  return featureTile({
    accent,
    eyebrow: "PRIVACY",
    title: "Local PII vault",
    body: "Personal data is tokenised before any cloud call. Real values stay AES-encrypted on your machine.",
    artHtml: art,
  });
}

function vaultRow(key, before, after, accent) {
  return `<div style="display:flex; align-items:center; gap:14px; padding:9px 0;
      font-family:${T.fontMono}; font-size:14px;">
    <div style="width:54px; color:${T.ink3};">${key}</div>
    <div style="color:${T.ink4}; text-decoration:line-through; flex:1; min-width:0;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${before}</div>
    <div style="color:${T.ink3};">→</div>
    <div style="color:${accent};">${after}</div>
  </div>`;
}

// AGENTS — three isolated lanes running side by side, each at a different phase.
function agentsTemplate() {
  const accent = T.aPurple;
  const lanes = [
    { name: "researcher", pct: 100, eng: "claude", c: T.eClaude, st: "done" },
    { name: "coder", pct: 62, eng: "codex", c: T.eCodex, st: "running" },
    { name: "reviewer", pct: 28, eng: "local", c: T.ink2, st: "running" },
  ];
  const art = `
  <div style="display:flex; gap:16px; width:100%; justify-content:center;">
    ${lanes
      .map(
        (l) => `
      <div class="card" style="flex:1; max-width:148px; padding:18px 16px;
          background:${T.sheet1}; border:1px solid ${T.line2}; border-radius:18px;">
        <div style="display:flex; align-items:center; gap:7px; margin-bottom:16px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${l.c};
            box-shadow:0 0 10px ${l.c}99;"></span>
          <span style="font-family:${T.fontMono}; font-size:11.5px; color:${T.ink2};
            letter-spacing:0.02em;">${l.eng}</span>
        </div>
        <div style="font-family:${T.fontSans}; font-weight:600; font-size:16px;
            color:${T.ink}; margin-bottom:18px; letter-spacing:-0.01em;">${l.name}</div>
        <!-- vertical phase ticks -->
        <div style="display:flex; flex-direction:column; gap:7px; margin-bottom:16px;">
          ${[0, 1, 2, 3]
            .map((i) => {
              const filled = l.pct >= (i + 1) * 25;
              const partial = !filled && l.pct > i * 25;
              // filled = bright accent; partial = dim accent; empty = faint track
              const col = filled
                ? accent
                : partial
                ? `${accent}66`
                : "rgba(255,255,255,0.07)";
              const glow = filled ? `box-shadow:0 0 8px ${accent}55;` : "";
              return `<div style="height:5px;border-radius:3px;background:${col};${glow}"></div>`;
            })
            .join("")}
        </div>
        <div style="font-family:${T.fontMono}; font-size:11px;
            color:${l.st === "done" ? accent : T.ink3}; letter-spacing:0.04em;">
          ${l.st === "done" ? "✓ done" : `${l.pct}%`}
        </div>
      </div>`
      )
      .join("")}
  </div>`;
  return featureTile({
    accent,
    eyebrow: "PARALLELISM",
    title: "Multi-agent, in parallel",
    body: "Spawn N specialists at once — each in its own session and worktree, coordinated and isolated.",
    artHtml: art,
  });
}

// PLAN — a plan node decomposing into subplans, gated by an approval step.
function planTemplate() {
  const accent = T.aOrange;
  // simple SVG branch tree: root → 3 children → approve gate
  const art = `
  <div style="width:100%; display:flex; flex-direction:column; align-items:center; gap:0;">
    ${planNode("Intent", T.ink, T.sheet2, accent, true)}
    ${branchSvg(accent)}
    <div style="display:flex; gap:14px; margin:2px 0;">
      ${planNode("Subplan A", T.ink2, T.sheet1, T.line2, false)}
      ${planNode("Subplan B", T.ink2, T.sheet1, T.line2, false)}
      ${planNode("Subplan C", T.ink2, T.sheet1, T.line2, false)}
    </div>
    <div style="height:26px; width:1px; background:${T.line2};"></div>
    <div style="display:inline-flex; align-items:center; gap:9px;
        padding:11px 20px; border-radius:999px;
        background:${accent}16; border:1px solid ${accent}55; color:${accent};
        font-family:${T.fontSans}; font-size:15px; font-weight:600;
        letter-spacing:-0.005em;">
      <span style="width:8px;height:8px;border-radius:50%;background:${accent};
        box-shadow:0 0 12px ${accent};"></span>
      Awaiting your approval
    </div>
    <div style="height:26px; width:1px; background:${T.line};"></div>
    <div style="font-family:${T.fontMono}; font-size:12.5px; color:${T.ink3};
        letter-spacing:0.04em;">nothing runs until you approve →</div>
  </div>`;
  return featureTile({
    accent,
    eyebrow: "STEERABILITY",
    title: "Plan → Subplan",
    body: "One intent decomposes into subplans. There is an explicit pause + inject point — correct mid-flight, don't restart.",
    artHtml: art,
  });
}

function planNode(label, color, bg, border, big) {
  const pad = big ? "13px 26px" : "10px 16px";
  const fs = big ? "18px" : "14px";
  return `<div style="display:inline-flex; align-items:center; padding:${pad};
      background:${bg}; border:1px solid ${border}; border-radius:13px;
      font-family:${T.fontSans}; font-weight:${big ? 600 : 500}; font-size:${fs};
      color:${color}; letter-spacing:-0.01em; white-space:nowrap;">${label}</div>`;
}

function branchSvg(accent) {
  // a small connector: one trunk splitting to three
  return `<svg width="280" height="40" viewBox="0 0 280 40" fill="none"
      style="display:block; margin: -1px 0;">
    <path d="M140 0 V14" stroke="${T.line2}" stroke-width="1.5"/>
    <path d="M140 14 H46 V40 M140 14 H140 V40 M140 14 H234 V40"
      stroke="${T.line2}" stroke-width="1.5" fill="none"/>
    <circle cx="140" cy="14" r="2.5" fill="${accent}"/>
  </svg>`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Registry — name → template factory. Filenames match README.md slots.
   ───────────────────────────────────────────────────────────────────────── */
const IMAGES = {
  hero: heroTemplate,
  "feature-vault": vaultTemplate,
  "feature-agents": agentsTemplate,
  "feature-plan": planTemplate,
};

/* ─────────────────────────────────────────────────────────────────────────
   Playwright resolution — local → npx cache → install fallback.
   ───────────────────────────────────────────────────────────────────────── */
function resolvePlaywright() {
  const require = createRequire(import.meta.url);

  // 1) local node_modules
  try {
    return require("playwright");
  } catch {
    /* keep looking */
  }

  // 2) npx cache — pick the newest version that resolves
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    const candidates = [];
    for (const hash of readdirSync(npxRoot)) {
      const pkg = path.join(
        npxRoot,
        hash,
        "node_modules",
        "playwright",
        "package.json"
      );
      if (existsSync(pkg)) {
        try {
          const v = require(pkg).version;
          candidates.push({ v, dir: path.dirname(pkg) });
        } catch {
          /* skip */
        }
      }
    }
    candidates.sort((a, b) => cmpSemver(b.v, a.v));
    for (const c of candidates) {
      try {
        const r = createRequire(path.join(c.dir, "package.json"));
        const pw = r("playwright");
        process.stdout.write(
          `· using playwright ${c.v} from npx cache\n`
        );
        return pw;
      } catch {
        /* try next */
      }
    }
  }

  // 3) last resort — install chromium via npx, then re-resolve the npx cache
  process.stdout.write(
    "· playwright not found locally — installing chromium via npx (one-time)…\n"
  );
  try {
    execFileSync("npx", ["--yes", "playwright@1.60.0", "install", "chromium"], {
      stdio: "inherit",
    });
  } catch (e) {
    throw new Error(
      "Could not install Chromium via npx. Install playwright manually:\n" +
        "  npm i -D playwright && npx playwright install chromium\n" +
        `Original error: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  // re-scan npx cache after install
  if (existsSync(npxRoot)) {
    for (const hash of readdirSync(npxRoot)) {
      const pkg = path.join(
        npxRoot,
        hash,
        "node_modules",
        "playwright",
        "package.json"
      );
      if (existsSync(pkg)) {
        try {
          const r = createRequire(pkg);
          return r("playwright");
        } catch {
          /* skip */
        }
      }
    }
  }
  throw new Error(
    "Chromium installed but the playwright module could not be resolved."
  );
}

function cmpSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/* ─────────────────────────────────────────────────────────────────────────
   Render
   ───────────────────────────────────────────────────────────────────────── */
async function renderOne(browser, name) {
  const factory = IMAGES[name];
  if (!factory) throw new Error(`unknown image "${name}"`);
  const { w, h, inner } = factory();
  const html = inner; // factory already wrapped via shell()

  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2, // retina — output PNG is w*2 × h*2
  });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  // give fonts/gradients a beat to settle
  await page.waitForTimeout(120);

  const dest = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: dest, type: "png" });
  await ctx.close();

  const { size } = statSync(dest);
  return { name, dest, w: w * 2, h: h * 2, bytes: size };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    process.stdout.write(
      `Known images:\n${Object.keys(IMAGES)
        .map((n) => `  - ${n}`)
        .join("\n")}\n`
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const only = args.find((a) => !a.startsWith("-"));
  const names = only ? [only] : Object.keys(IMAGES);
  if (only && !IMAGES[only]) {
    process.stderr.write(
      `No image named "${only}". Known: ${Object.keys(IMAGES).join(", ")}\n`
    );
    process.exit(1);
  }

  const playwright = resolvePlaywright();
  const browser = await playwright.chromium.launch({ headless: true });

  const results = [];
  try {
    for (const name of names) {
      process.stdout.write(`▶ rendering ${name} … `);
      const r = await renderOne(browser, name);
      const kb = (r.bytes / 1024).toFixed(0);
      if (r.bytes <= 0) throw new Error(`zero-byte PNG written for ${name}`);
      process.stdout.write(`✓ ${r.w}×${r.h}px, ${kb} KB → ${r.dest}\n`);
      results.push(r);
    }
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `\nDone. ${results.length} image(s) → ${path.relative(REPO_ROOT, OUT_DIR)}/\n`
  );
}

main().catch((e) => {
  process.stderr.write(
    `\n✗ render failed: ${e instanceof Error ? e.stack || e.message : String(e)}\n`
  );
  process.exit(1);
});

// keep pathToFileURL import used (lint) — also handy if invoked oddly
void pathToFileURL;
