/**
 * POST /api/push/test
 *   Body: { title?: string, body?: string }
 *   Auth: SESSION-COOKIE (no Bearer needed)
 *
 * Browser-callable test-push trigger for the Settings-Hub. The Bearer-only
 * `/api/push/send` endpoint stays untouched (Server-to-Server contract).
 * This route is session-authed, then internally posts the notification
 * using the same primitives as `/api/push/send`.
 *
 * Why a separate route: the client (Settings-Hub) cannot ship the server
 * secret LAZYOS_PUSH_SECRET. Instead, the user's session cookie is the
 * authentication factor here. Internal call avoids HTTP-roundtrip + the
 * bearer header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { list, remove } from "@/lib/pwa/store";
import { getPushClient } from "@/lib/pwa/pushServer";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TestBody {
  title?: unknown;
  body?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = currentUserIdResolved({ headers: req.headers });
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", hint: "session required" },
      { status: 401 },
    );
  }

  // Validate that the secret is actually configured server-side. The
  // browser never sees this value — we just want a clear error if the
  // server is missing the credential entirely.
  if (!process.env.LAZYOS_PUSH_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_configured",
        hint: "LAZYOS_PUSH_SECRET fehlt in .env.local — Server-Restart nach Setzen nötig.",
      },
      { status: 503 },
    );
  }

  let payload: TestBody = {};
  try {
    payload = (await req.json()) as TestBody;
  } catch {
    // empty body is fine — use defaults
  }

  const title =
    typeof payload.title === "string" && payload.title.length > 0
      ? payload.title
      : "laz.ing Test-Push";
  const body =
    typeof payload.body === "string" && payload.body.length > 0
      ? payload.body
      : "Wenn du das siehst, läuft Push.";

  const subs = await list();
  if (subs.length === 0) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      removed: 0,
      note: "no subscriptions",
    });
  }

  let client: ReturnType<typeof getPushClient>;
  try {
    client = getPushClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "push client init failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const notif = JSON.stringify({ title, body, url: "/settings", tag: "lazyos-test" });

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
        if (statusCode === 404 || statusCode === 410) {
          await remove(sub.endpoint).catch(() => undefined);
          removed += 1;
        }
        errors.push({
          endpoint: sub.endpoint.slice(0, 60) + "...",
          statusCode,
          message,
        });
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    sent,
    removed,
    failures: errors.length,
    errors: errors.slice(0, 5),
  });
}
