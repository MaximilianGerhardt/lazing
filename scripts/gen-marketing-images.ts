/**
 * scripts/gen-marketing-images.ts — generate the repo's marketing images with
 * laz.ing's OWN built-in image engine (Codex-MCP image_gen). Dogfooding: every
 * picture in the README is produced by the tool itself.
 *
 *   pnpm tsx scripts/gen-marketing-images.ts            # all
 *   pnpm tsx scripts/gen-marketing-images.ts hero       # one by name
 *
 * Output → docs/assets/<name>.png (committed, referenced by README.md).
 * Requires the `codex` CLI + ~/.codex/auth.json on this machine (local-first).
 *
 * Brand: pitch-black #070707, one soft radial lime-green (#c9ff4d) glow, fine
 * grain, premium Apple-keynote negative-space aesthetic — abstract, NOT literal
 * "robot/AI" clichés (dev audiences downvote AI-slop).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { generateImageViaCodex } from "../lib/imagegen/codex-mcp";

const BRAND =
  "Minimalist abstract render. Pitch-black background (#070707). A single soft " +
  "radial glow in lime-green (#c9ff4d). Subtle film grain. Lots of negative space. " +
  "Premium, calm, Apple-keynote aesthetic. No text, no logos, no people, no robots. ";

const IMAGES: Array<{ name: string; prompt: string }> = [
  {
    name: "hero",
    prompt:
      BRAND +
      "Wide 16:9 hero. A constellation of a few softly glowing nodes connected by " +
      "thin light lines on the black canvas — suggesting a small swarm of autonomous " +
      "agents working in concert. Depth, bokeh, cinematic.",
  },
  {
    name: "feature-vault",
    prompt:
      BRAND +
      "A single faceted vault/shield form made of dark glass, edge-lit lime-green, " +
      "with tiny abstract data glyphs dissolving into safe tokens around it. Privacy, " +
      "containment, local.",
  },
  {
    name: "feature-agents",
    prompt:
      BRAND +
      "Several identical luminous panels arranged in a parallel grid, each faintly " +
      "active at a different phase — suggesting specialist agents running side by side " +
      "in isolation.",
  },
  {
    name: "feature-plan",
    prompt:
      BRAND +
      "A clean branching tree of light: one node at the top splitting into a few " +
      "child nodes and grand-child nodes — a plan decomposing into subplans. Elegant, " +
      "geometric, minimal.",
  },
];

async function one(img: { name: string; prompt: string }): Promise<void> {
  const outDir = path.join(process.cwd(), "docs", "assets");
  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `${img.name}.png`);
  process.stdout.write(`▶ generating ${img.name} … `);
  const res = await generateImageViaCodex({ prompt: img.prompt, timeoutMs: 180_000 });
  copyFileSync(res.pngPath, dest);
  console.log(`✓ ${dest} (${Math.round(res.latencyMs / 1000)}s)`);
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const set = only ? IMAGES.filter((i) => i.name === only) : IMAGES;
  if (set.length === 0) {
    console.error(`No image named "${only}". Known: ${IMAGES.map((i) => i.name).join(", ")}`);
    process.exit(1);
  }
  // Sequential — the engine is single-flight (N11).
  for (const img of set) {
    try {
      await one(img);
    } catch (e) {
      console.error(`✗ ${img.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

void main();
