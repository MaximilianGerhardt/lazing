#!/usr/bin/env node
/**
 * lazyOS — Push Trigger CLI
 *
 * Sendet eine Web-Push-Notifikation an alle registrierten Subscriptions
 * (primaer: Max). Kann manuell von Max aufgerufen werden ODER
 * automatisch von Phase-completed-Hooks.
 *
 * Nutzung:
 *   node scripts/send-push.mjs "Phase 1 fertig" "16 Komponenten live" "/review/phase-1"
 *
 * Env:
 *   LAZYOS_PUSH_URL    — Default: https://example.com/api/push/send
 *   LAZYOS_PUSH_SECRET — Bearer-Token (sonst wird .env.local gelesen)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , rawTitle, rawBody, rawUrl] = process.argv;
if (!rawTitle || !rawBody) {
  console.error('Usage: node scripts/send-push.mjs "<title>" "<body>" [url]');
  process.exit(2);
}

const envUrl = process.env.LAZYOS_PUSH_URL;
const envSecret = process.env.LAZYOS_PUSH_SECRET;

let url = envUrl ?? "https://example.com/api/push/send";
let secret = envSecret;

if (!secret) {
  const envPath = resolve(__dirname, "..", ".env.local");
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "LAZYOS_PUSH_SECRET" && !secret) secret = m[2];
      if (m[1] === "LAZYOS_PUSH_URL" && !envUrl) url = m[2];
    }
  }
}

if (!secret) {
  console.error("LAZYOS_PUSH_SECRET fehlt. Entweder Env exportieren oder .env.local pruefen.");
  process.exit(3);
}

const payload = {
  title: rawTitle,
  body: rawBody,
  url: rawUrl && rawUrl.startsWith("/") ? rawUrl : "/",
  tag: "lazyos-cli",
};

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Push-Send failed (${res.status}):`, text);
  process.exit(1);
}

try {
  const parsed = JSON.parse(text);
  console.log(JSON.stringify(parsed, null, 2));
} catch {
  console.log(text);
}
