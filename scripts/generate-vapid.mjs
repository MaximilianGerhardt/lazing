#!/usr/bin/env node
/**
 * lazyOS — VAPID Key Generator
 *
 * Einmalig ausfuehren. Output wird in .env.local geschrieben
 * (nicht commit-bar, .env* ist in .gitignore).
 *
 * Nutzung:
 *   node scripts/generate-vapid.mjs
 *   node scripts/generate-vapid.mjs --print   # nur Stdout, keine .env.local
 */
import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
const PRINT_ONLY = process.argv.includes("--print");
const SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:<contact@laz.ing>";

const vapid = webpush.generateVAPIDKeys();
const pushSecret = randomBytes(32).toString("hex");

const block = {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: SUBJECT,
  LAZYOS_PUSH_SECRET: pushSecret,
};

if (PRINT_ONLY) {
  for (const [k, v] of Object.entries(block)) console.log(`${k}=${v}`);
  process.exit(0);
}

// Merge mit bestehender .env.local (ueberschreibt nur diese 4 Keys)
let existing = "";
if (existsSync(envPath)) existing = readFileSync(envPath, "utf8");

const lines = existing.split(/\r?\n/);
const remaining = lines.filter((line) => {
  const key = line.split("=")[0]?.trim();
  return !(key && key in block);
});

const merged = [
  ...remaining.filter((l) => l.trim().length > 0),
  "",
  "# Web-Push (VAPID) — generiert via scripts/generate-vapid.mjs",
  ...Object.entries(block).map(([k, v]) => `${k}=${v}`),
  "",
].join("\n");

writeFileSync(envPath, merged, { mode: 0o600 });

console.log("VAPID generiert und in .env.local geschrieben.");
console.log("--- Public Key (Client) ---");
console.log(vapid.publicKey);
console.log("--- Private Key (Server) ---");
console.log(vapid.privateKey);
console.log("--- Subject ---");
console.log(SUBJECT);
console.log("--- Push-Secret (Bearer fuer /api/push/send) ---");
console.log(pushSecret);
console.log();
console.log("Naechste Schritte:");
console.log("  1. Vercel-Env uploaden (Production):");
console.log('     vercel env add NEXT_PUBLIC_VAPID_PUBLIC_KEY production --token=$VERCEL_TOKEN');
console.log('     vercel env add VAPID_PRIVATE_KEY production --token=$VERCEL_TOKEN');
console.log('     vercel env add VAPID_SUBJECT production --token=$VERCEL_TOKEN');
console.log('     vercel env add LAZYOS_PUSH_SECRET production --token=$VERCEL_TOKEN');
console.log("  2. Test lokal: pnpm dev");
console.log("  3. Deploy: vercel --prod --token=$VERCEL_TOKEN");
