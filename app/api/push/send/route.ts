/**
 * POST /api/push/send
 *   Body: { title: string, body: string, url?: string, tag?: string }
 *   Auth: Authorization: Bearer $LAZYOS_PUSH_SECRET  (Pflicht)
 *
 *   Sendet die Notifikation an alle aktuell gespeicherten Subscriptions.
 *   Abgelaufene Subscriptions (410/404) werden serverseitig entfernt.
 */
import { NextResponse, type NextRequest } from "next/server";
import { BRAND_NAME } from "@/lib/brand";
import { list, remove } from "@/lib/pwa/store";
import { getPushClient } from "@/lib/pwa/pushServer";
import { verifyBearer } from "@/lib/security/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SendBody {
  title?: unknown;
  body?: unknown;
  url?: unknown;
  tag?: unknown;
  ruleId?: unknown;
}

function authorized(req: NextRequest): boolean {
  return verifyBearer(req, process.env.LAZYOS_PUSH_SECRET).ok;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: SendBody;
  try {
    payload = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const title = typeof payload.title === "string" && payload.title.length > 0 ? payload.title : BRAND_NAME;
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/";
  const tag = typeof payload.tag === "string" ? payload.tag : undefined;
  // Pattern 6a Telemetrie (2026-05-01): ruleId in `data` damit der SW
  // beim Click/Dismiss /api/push/feedback mit der ruleId callen kann.
  const ruleId = typeof payload.ruleId === "string" ? payload.ruleId : undefined;

  const subs = await list();
  if (subs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, removed: 0, note: "no subscriptions" });
  }

  let client: ReturnType<typeof getPushClient>;
  try {
    client = getPushClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "push client init failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const notif = JSON.stringify({ title, body, url, tag, ruleId });

  let sent = 0;
  let removed = 0;
  const errors: Array<{ endpoint: string; statusCode?: number; message: string }> = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await client.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          notif,
          { TTL: 60 },
        );
        sent += 1;
      } catch (err: unknown) {
        const statusCode =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        const message = err instanceof Error ? err.message : String(err);
        // 404/410 = endpoint dauerhaft tot, aufraeumen
        if (statusCode === 404 || statusCode === 410) {
          await remove(sub.endpoint).catch(() => undefined);
          removed += 1;
        }
        errors.push({ endpoint: sub.endpoint.slice(0, 60) + "...", statusCode, message });
      }
    }),
  );

  return NextResponse.json({ ok: true, sent, removed, failures: errors.length, errors: errors.slice(0, 5) });
}
