#!/usr/bin/env node
/**
 * scripts/pair.mjs — pair your phone with this laz.ing instance.
 *
 *   pnpm pair              # QR for the best reachable URL (active tunnel, else LAN)
 *   pnpm pair --tunnel     # bring up a Cloudflare quick-tunnel first, then QR
 *   pnpm pair --tailscale  # use Tailscale instead of Cloudflare
 *
 * Prints a QR code right in the terminal (bundled `qrcode`, nothing leaves the
 * machine) plus the URL and the PWA "Add to Home Screen" hint. Same-Wi-Fi phones
 * can use the LAN URL with zero setup; for access anywhere, use --tunnel.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LAZYOS_PORT || 4200);
const args = process.argv.slice(2);
const wantTunnel = args.includes("--tunnel") || args.includes("--tailscale");
const tailscale = args.includes("--tailscale");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

function publicUrl() {
  const file = path.join(ROOT, "data", "public-url");
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim().replace(/\/+$/, "");
    if (/^https?:\/\//.test(v)) return v;
  }
  const env = (process.env.LAZYOS_PREVIEW_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(env) ? env : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bringUpTunnel() {
  console.log(
    c.cyan(`▶ Starting ${tailscale ? "Tailscale" : "Cloudflare"} tunnel …`),
  );
  const tunnelArgs = [path.join(ROOT, "scripts", "lazyos-tunnel.mjs"), "up"];
  if (tailscale) tunnelArgs.push("--tailscale");
  const child = spawn(process.execPath, tunnelArgs, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Poll for the URL the manager writes once the tunnel connects.
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    const u = publicUrl();
    if (u) return u;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return publicUrl();
}

async function main() {
  let url = publicUrl();
  if (wantTunnel && !url) {
    url = await bringUpTunnel();
  }
  let reach = "anywhere (tunnel)";
  if (!url) {
    const ip = lanIp();
    if (ip) {
      url = `http://${ip}:${PORT}`;
      reach = "same Wi-Fi network";
    } else {
      url = `http://localhost:${PORT}`;
      reach = "this machine only";
    }
  }

  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  console.log("");
  console.log(qr);
  console.log(`  ${c.bold("Scan with your phone")}  ·  reachable: ${c.green(reach)}`);
  console.log(`  ${c.cyan(url)}`);
  console.log("");
  console.log(
    c.dim(
      "  Tip: after it loads, use your browser's “Add to Home Screen” to install",
    ),
  );
  console.log(
    c.dim(
      "  laz.ing as a PWA — the best, native-feeling experience on the phone.",
    ),
  );
  if (!wantTunnel && reach !== "anywhere (tunnel)") {
    console.log("");
    console.log(
      c.dim("  For access from anywhere (not just this Wi-Fi):  pnpm pair --tunnel"),
    );
  }
}

main().catch((e) => {
  console.error("pair failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
