/**
 * POST /api/stt/transcribe
 *
 * Audio proxy to the local faster-whisper service on port 4202 (via VPS web
 * tunnel or local). Accepts an audio blob, forwards it with bearer auth,
 * returns JSON {text, duration_ms, segments?}.
 *
 * Auth: cookie session (middleware gated), proxy uses LAZYOS_CHAT_KEY as the
 * bearer for the service.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upper bound we'll forward. Service has its own 25MB cap; we stay under. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function resolveSttUrl(): string | null {
  // If LAZYOS_WEB_URL is set (Vercel environment), we proxy via the
  // VPS web tunnel to its own /api/stt/transcribe endpoint.
  // On the VPS itself the code falls back to http://127.0.0.1:4202.
  if (process.env.LAZYOS_STT_URL) return process.env.LAZYOS_STT_URL;
  if (process.env.LAZYOS_WEB_URL) {
    const base = process.env.LAZYOS_WEB_URL.replace(/\/+$/, "");
    return `${base}/api/stt/transcribe?__inner=1`;
  }
  return "http://127.0.0.1:4202/transcribe";
}

function resolveBearer(): string | null {
  return (
    process.env.LAZYOS_STT_KEY ??
    process.env.LAZYOS_CHAT_KEY ??
    null
  );
}

export async function POST(req: Request): Promise<Response> {
  const sttUrl = resolveSttUrl();
  const bearer = resolveBearer();

  if (!sttUrl) {
    return NextResponse.json(
      { error: "stt_not_configured" },
      { status: 503 },
    );
  }
  if (!bearer) {
    return NextResponse.json(
      { error: "stt_auth_misconfig", detail: "LAZYOS_CHAT_KEY fehlt" },
      { status: 500 },
    );
  }

  const contentType = req.headers.get("content-type") ?? "audio/webm";
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "payload_too_large", max_bytes: MAX_BODY_BYTES },
        { status: 413 },
      );
    }
  }

  // Pass lang-Query through
  const lang = new URL(req.url).searchParams.get("lang") ?? "de";
  // Pass the stream body through directly — no buffering in memory
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", max_bytes: MAX_BODY_BYTES },
      { status: 413 },
    );
  }
  if (body.byteLength === 0) {
    return NextResponse.json({ error: "empty_audio" }, { status: 400 });
  }

  const targetUrl = `${sttUrl}${sttUrl.includes("?") ? "&" : "?"}lang=${encodeURIComponent(
    lang,
  )}`;
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), 60_000);

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": contentType,
      },
      body,
      signal: ctl.signal,
    });

    const responseText = await upstream.text();
    const json = responseText ? safeParse(responseText) : null;

    return NextResponse.json(json ?? { error: "stt_empty_response" }, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "x-stt-source": sttUrl.startsWith("http://127.0.0.1") ? "local" : "bridge",
      },
    });
  } catch (err) {
    const isAbort = (err as { name?: string }).name === "AbortError";
    return NextResponse.json(
      {
        error: isAbort ? "stt_timeout" : "stt_proxy_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: isAbort ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { error: "stt_invalid_json", raw: raw.slice(0, 500) };
  }
}
