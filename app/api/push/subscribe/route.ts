/**
 * POST /api/push/subscribe
 *   Body: PushSubscriptionJSON { endpoint, keys: { auth, p256dh } }
 *   Speichert die Subscription im MVP-File-Store.
 *   Auth: OPEN (MVP, single-user). TODO Phase 2: Bearer/Code-Gate.
 *
 * DELETE /api/push/subscribe
 *   Body: { endpoint }
 *   Entfernt die Subscription serverseitig.
 */
import { NextResponse, type NextRequest } from "next/server";
import { remove, upsert, type StoredSubscription } from "@/lib/pwa/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { auth?: unknown; p256dh?: unknown };
  expirationTime?: unknown;
}

function isValidSubscribe(v: unknown): v is {
  endpoint: string;
  keys: { auth: string; p256dh: string };
} {
  const b = v as SubscribeBody | null;
  if (!b || typeof b !== "object") return false;
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://")) return false;
  if (!b.keys || typeof b.keys !== "object") return false;
  if (typeof b.keys.auth !== "string" || typeof b.keys.p256dh !== "string") return false;
  return true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isValidSubscribe(json)) {
    return NextResponse.json({ ok: false, error: "invalid subscription shape" }, { status: 400 });
  }

  const stored: StoredSubscription = {
    endpoint: json.endpoint,
    keys: { auth: json.keys.auth, p256dh: json.keys.p256dh },
    createdAt: new Date().toISOString(),
    userAgent: req.headers.get("user-agent") ?? undefined,
  };

  try {
    await upsert(stored);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "store failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const endpoint = (json as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string") {
    return NextResponse.json({ ok: false, error: "endpoint required" }, { status: 400 });
  }
  try {
    await remove(endpoint);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "store failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
