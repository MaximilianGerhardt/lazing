#!/usr/bin/env node
/**
 * lazyOS — Review-Ticket CLI
 * --------------------------
 * Generiert ein Review-Ticket-Event + Push-Notifikation, damit Max
 * informiert wird, sobald eine Phase testreif ist.
 *
 * Nutzung:
 *   node scripts/review-ticket.mjs \
 *     --title "Phase 2 live" \
 *     --body "Event-Log + API + Health getestet. Oeffne /design." \
 *     --url "/design" \
 *     --ticket "TCK-PHASE-2" \
 *     --segment "@system" \
 *     --checklist "API /api/health antwortet 200" \
 *                 "Seed-Daten sichtbar in /decisions" \
 *                 "SSE-Stream funktioniert"
 *
 * Env (mit Fallback auf .env.local):
 *   LAZYOS_PUSH_URL      — Default: https://example.com
 *   LAZYOS_PUSH_SECRET   — Bearer-Token (Pflicht)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI-Parsing — leichtgewichtig, kein yargs-Dependency
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    title: undefined,
    body: undefined,
    url: "/",
    ticket: undefined,
    segment: undefined,
    checklist: [],
  };

  const multiValueFlags = new Set(["checklist"]);
  let current = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (!(name in out)) {
        console.error(`Unbekannter Flag: --${name}`);
        process.exit(2);
      }
      current = name;
      // gleich naechstes Argument als Wert lesen, solange es nicht mit --
      // beginnt. Fuer multi-value-Flags so viele wie moeglich sammeln.
      if (multiValueFlags.has(name)) {
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          out[name].push(argv[++i]);
        }
      } else {
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          out[name] = argv[++i];
        }
      }
    } else if (current && multiValueFlags.has(current)) {
      out[current].push(tok);
    }
  }

  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.title || !args.body) {
  console.error(
    'Usage: node scripts/review-ticket.mjs --title "..." --body "..." [--url /path] [--ticket TCK-X] [--segment @system] [--checklist "item1" "item2"]',
  );
  process.exit(2);
}

if (!args.url.startsWith("/")) {
  console.error(`--url muss mit / beginnen (bekam: ${args.url})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// .env.local-Fallback
// ---------------------------------------------------------------------------

let baseUrl = process.env.LAZYOS_PUSH_URL;
let secret = process.env.LAZYOS_PUSH_SECRET;

if (!secret || !baseUrl) {
  const envPath = resolve(__dirname, "..", ".env.local");
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "LAZYOS_PUSH_SECRET" && !secret) secret = m[2];
      if (m[1] === "LAZYOS_PUSH_URL" && !baseUrl) baseUrl = m[2];
    }
  }
}

baseUrl = baseUrl ?? "https://example.com";
// Wenn user die alte /api/push/send URL uebergeben hat, wollen wir die Base
// extrahieren — wir haengen unseren eigenen Pfad an.
baseUrl = baseUrl.replace(/\/api\/push\/.*$/, "").replace(/\/+$/, "");

if (!secret) {
  console.error(
    "LAZYOS_PUSH_SECRET fehlt. Entweder Env exportieren oder .env.local pflegen.",
  );
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Request bauen — Checklist landet im Body-Text mit Bullet-Prefix
// ---------------------------------------------------------------------------

const checklistText = args.checklist.length
  ? "\n\nChecklist:\n" + args.checklist.map((c) => `• ${c}`).join("\n")
  : "";

const payload = {
  title: args.title,
  body: args.body + checklistText,
  url: args.url,
};
if (args.ticket) payload.ticketId = args.ticket;
if (args.segment) payload.segmentId = args.segment;

const endpoint = `${baseUrl}/api/push/notify-review`;

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  console.error(`notify-review failed (${res.status}):`, text);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { raw: text };
}

console.log("notify-review OK:");
console.log(JSON.stringify(parsed, null, 2));
console.log(`\nPreview: ${baseUrl}${args.url}`);
if (args.ticket) {
  console.log(`Ticket im Event-Log: ${args.ticket}`);
}
