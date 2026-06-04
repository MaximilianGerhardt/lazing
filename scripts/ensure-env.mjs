#!/usr/bin/env node
/**
 * scripts/ensure-env.mjs — make a fresh checkout self-configuring.
 *
 * Ensures .env.local exists and that the REQUIRED block has real values:
 *   - LAZYOS_AUTH_SECRET, LAZYOS_CREDENTIAL_KEY  → auto-generated 32-byte hex
 *   - LAZYOS_ACCESS_CODE                          → auto-generated 16-byte hex
 *   - LAZYOS_OWNER_EMAIL                          → from $LAZYOS_OWNER_EMAIL or
 *                                                    a safe default (owner@localhost)
 *
 * A value is "missing" if it is empty or still the .env.example placeholder
 * (`replace-with-…` / `you@example.com`). Real values are NEVER overwritten —
 * re-running is idempotent. Only the owner can be prompted; secrets are never
 * printed in full. This is what lets the new-machine flow be:
 *
 *     git clone … && cd … && pnpm install && bash scripts/setup.sh && pnpm dev
 *
 * with no manual secret-pasting.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV = path.join(ROOT, ".env.local");
const EXAMPLE = path.join(ROOT, ".env.example");

function isPlaceholder(v) {
  const t = (v ?? "").trim().replace(/^["']|["']$/g, "");
  return (
    t === "" ||
    t.startsWith("replace-with") ||
    t === "you@example.com" ||
    t === '""' ||
    t === "''"
  );
}

// 1. Ensure the file exists.
if (!existsSync(ENV)) {
  if (!existsSync(EXAMPLE)) {
    console.error("✗ Neither .env.local nor .env.example exists — cannot continue.");
    process.exit(1);
  }
  copyFileSync(EXAMPLE, ENV);
  console.log("▶ .env.local did not exist — created it from .env.example.");
}

let lines = readFileSync(ENV, "utf8").split("\n");

/** Set VAR=value: replace the (possibly placeholder) line, else append. */
function setVar(name, value) {
  const idx = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${name}=`).test(l));
  const line = `${name}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
}
function getVar(name) {
  const l = lines.find((l) => new RegExp(`^\\s*${name}=`).test(l));
  return l ? l.slice(l.indexOf("=") + 1) : "";
}

const generated = [];

for (const name of ["LAZYOS_AUTH_SECRET", "LAZYOS_CREDENTIAL_KEY"]) {
  if (isPlaceholder(getVar(name))) {
    setVar(name, randomBytes(32).toString("hex")); // 64 hex chars
    generated.push(name);
  }
}
if (isPlaceholder(getVar("LAZYOS_ACCESS_CODE"))) {
  setVar("LAZYOS_ACCESS_CODE", randomBytes(16).toString("hex")); // 32 chars
  generated.push("LAZYOS_ACCESS_CODE");
}
if (isPlaceholder(getVar("LAZYOS_OWNER_EMAIL"))) {
  const email = (process.env.LAZYOS_OWNER_EMAIL ?? "").trim() || "owner@localhost";
  setVar("LAZYOS_OWNER_EMAIL", email);
  generated.push(`LAZYOS_OWNER_EMAIL (=${email})`);
}

if (generated.length > 0) {
  writeFileSync(ENV, lines.join("\n"), "utf8");
  console.log("✓ Auto-filled missing required values in .env.local:");
  for (const g of generated) console.log(`    - ${g}`);
  console.log(
    "  (secrets generated locally with crypto.randomBytes; never printed, never committed)",
  );
  if (generated.some((g) => g.startsWith("LAZYOS_OWNER_EMAIL"))) {
    console.log(
      "  Tip: set a real owner e-mail by editing LAZYOS_OWNER_EMAIL in .env.local,",
    );
    console.log(
      "       or export LAZYOS_OWNER_EMAIL=you@domain.tld before running setup.sh.",
    );
  }
} else {
  console.log("✓ .env.local already has all required values — nothing to generate.");
}
