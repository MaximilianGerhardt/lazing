/**
 * /api/onboarding/pair — phone pairing for the finalize step.
 *
 * GET  → the best reachable base URL for a phone + a QR code (data-URL) to scan,
 *        plus a PWA "add to home screen" hint. Order of preference:
 *          1. an active public tunnel (Cloudflare/Tailscale) — reachable anywhere
 *          2. the LAN URL (http://<lan-ip>:<port>) — same Wi-Fi, zero setup
 *          3. localhost — this machine only
 * POST {action:'start-tunnel'|'stop-tunnel', provider?:'cloudflare'|'tailscale'}
 *        → (de)activates the Cloudflare quick-tunnel / Tailscale funnel via the
 *        tunnel manager (scripts/lazyos-tunnel.mjs), detached. The client then
 *        polls GET until `publicUrl` appears.
 *
 * Session-gated. The QR is generated locally with the bundled `qrcode` dep — no
 * external service, nothing leaves the machine.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import QRCode from "qrcode";
import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env.LAZYOS_PORT || 4200);

/** First non-internal IPv4 address — the address a phone on the same Wi-Fi uses. */
function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** Active public tunnel URL, if any (written by scripts/lazyos-tunnel.mjs). */
function publicUrl(): string | null {
  const file = path.join(process.cwd(), "data", "public-url");
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim().replace(/\/+$/, "");
    if (/^https?:\/\//.test(v)) return v;
  }
  const env = (process.env.LAZYOS_PREVIEW_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(env) ? env : null;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!loadCurrentUser(req)) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const ip = lanIp();
  const localUrl = `http://localhost:${PORT}`;
  const lanUrl = ip ? `http://${ip}:${PORT}` : null;
  const pub = publicUrl();
  const best = pub ?? lanUrl ?? localUrl;

  let qr: string | null = null;
  try {
    qr = await QRCode.toDataURL(best, { margin: 1, width: 256 });
  } catch {
    qr = null;
  }

  return NextResponse.json(
    {
      localUrl,
      lanUrl,
      publicUrl: pub,
      best,
      reach: pub ? "anywhere" : lanUrl ? "same-network" : "this-machine-only",
      qr,
      pwa: true, // hint the UI to show "Add to Home Screen"
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PostBody {
  action?: "start-tunnel" | "stop-tunnel";
  provider?: "cloudflare" | "tailscale";
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!loadCurrentUser(req)) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    body = {};
  }

  const action = body.action ?? "start-tunnel";
  const script = path.join(process.cwd(), "scripts", "lazyos-tunnel.mjs");
  if (!existsSync(script)) {
    return NextResponse.json({ error: "tunnel-manager-missing" }, { status: 500 });
  }

  // Cloudflare quick-tunnel is the zero-config default; Tailscale is opt-in.
  const args =
    action === "stop-tunnel"
      ? [script, "down"]
      : body.provider === "tailscale"
        ? [script, "up", "--tailscale"]
        : [script, "up"];

  try {
    // Detached + unref so the tunnel keeps running after this request returns.
    // The manager writes the URL to data/public-url once connected; the client
    // polls GET for it.
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    return NextResponse.json(
      { error: "spawn-failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action,
    provider: body.provider ?? "cloudflare",
    note:
      action === "start-tunnel"
        ? "Tunnel starting — poll GET /api/onboarding/pair until publicUrl appears (~5–15s)."
        : "Tunnel stopping.",
  });
}
