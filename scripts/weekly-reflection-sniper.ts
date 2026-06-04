#!/usr/bin/env tsx
/**
 * Weekly Reflection Sniper — the real Pattern 9 "Unlearning" (P14, 2026-05-01).
 *
 * Sundays 22:30 (AFTER retry-sniper 21:00, BEFORE stale-detection 22:00 — wait,
 * stale-detection is at Sunday 22:00. 22:30 is after stale-detection and
 * before the retry-sniper hard cutoff of the next week). Sends a
 * reflection push to the PWA with three rotating question sets, so the
 * user answers exactly one question weekly.
 *
 * The answer lands via the existing chat flow as an event with eventType
 * 'weekly_reflection_response' (see spec) → we route via payload.kind
 * because the enum entry is missing.
 *
 * Default DRY-RUN. `--apply` sends a real push.
 *
 * Hard cap: at most 1 push per week. In apply mode that is enforced by the
 * systemd timer frequency (OnCalendar=Sun 22:30:00) — the sniper
 * has no de-dupe logic of its own. If the timer fires more often, that is a
 * systemd bug, not a sniper bug.
 */

import { ulid } from "@/lib/ulid";

const ENDPOINT_PATH = "/api/push/notify-review";

const QUESTION_SETS: ReadonlyArray<ReadonlyArray<string>> = [
  // Set A — thesis / stack
  [
    "Welche These dachtest du letzte Woche, die heute nicht mehr stimmt?",
    "Welcher Stack/Lib war state-of-the-art und ist es nicht mehr?",
    "Was hast du recherchiert wo experimentieren schneller gewesen wäre?",
  ],
  // Set B — Workflow / Library
  [
    "Welcher Workflow hat dich diese Woche frustriert? Was war die Annahme die nicht stimmte?",
    "Welche Library hat dich enttäuscht — schon ersetzt?",
    "Welches Pattern nutzt du noch obwohl du gemerkt hast es klappt nicht mehr?",
  ],
  // Set C — Mindset / Habits
  [
    "Welche Annahme über deine Produktivität hat sich diese Woche als falsch erwiesen?",
    "Was hast du als 'unmöglich' abgehakt — würde es einen Re-Try wert sein?",
    "Welche Routine läuft auf Autopilot, obwohl ihr Nutzen unklar ist?",
  ],
];

function selectSet(now: Date = new Date()): ReadonlyArray<string> {
  // Selected by week modulo 3. ISO week = robust across year boundaries.
  const isoWeek = getIsoWeek(now);
  const idx = isoWeek % QUESTION_SETS.length;
  return QUESTION_SETS[idx];
}

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function buildBody(
  now: Date,
  set: ReadonlyArray<string>,
): {
  title: string;
  body: string;
  url: string;
  ticketId: string;
  segmentId: "lazyos";
} {
  const iso = now.toISOString().slice(0, 10);
  const ticketId = `TCK-WEEKLY-REFLECTION-${iso}`;
  // We pick ONE question from the set per run (rotation: the ulid suffix
  // determines which). So over several weeks the user gets all
  // questions from all sets.
  const dayHash = (now.getUTCDate() + now.getUTCMonth()) % set.length;
  const question = set[dayHash];
  return {
    title: "Wöchentliche Reflexion",
    body: question,
    url: `/inbox?ticket=${encodeURIComponent(ticketId)}`,
    ticketId,
    segmentId: "lazyos",
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  const set = selectSet(now);
  const body = buildBody(now, set);

  if (!apply) {
    console.log(
      JSON.stringify({
        ok: true,
        applied: false,
        wouldSendTo: ENDPOINT_PATH,
        ticketId: body.ticketId,
        title: body.title,
        body: body.body,
        url: body.url,
        segmentId: body.segmentId,
        nonce: `nonce_${ulid()}`,
      }),
    );
    return;
  }

  const baseUrl = process.env.LAZYOS_BASE_URL ?? "http://127.0.0.1:3000";
  const secret = process.env.LAZYOS_PUSH_SECRET;
  if (!secret) {
    console.error("LAZYOS_PUSH_SECRET nicht gesetzt — push abgebrochen");
    process.exit(1);
  }

  const res = await fetch(`${baseUrl}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(
    JSON.stringify({
      ok: res.ok,
      applied: true,
      status: res.status,
      ticketId: body.ticketId,
      response: json,
    }),
  );
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
