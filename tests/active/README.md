# tests/active — Active Smoke Harness gegen Live :4200

Owner-Direktive (2026-05-28): „Wir müssen jetzt wirklich in das aktive Testing
gehen! Und auch schauen, ob die UI richtig alles auslöst. … Nutze am besten das
System selber, um an dem System zu arbeiten und überprüfe dann beobachte wo was
harkt."

## Was hier drin ist

Read-only-bevorzugtes Smoke-Set gegen die LAUFENDE laz.ing-Instanz
(`http://127.0.0.1:4200` Web + `http://127.0.0.1:4201` agent-server).
**Berührt NICHT** `lib/`, `app/`, `server/`, `db/` — nur Test-/Harness-Dateien.

- `fetch-smoke.ts` — kein Browser, nur HTTP. Boot-Smoke, Auth-Bypass-via-Master-
  Login, Route-Smokes, 403-Repro, Permission-Mode-Round-Trip (read-only GET).
- `db-verifier.ts` — `sqlite3`-CLI gegen `./data/lazyos.db`. Liest
  `rag_chunks`, `workspace_beliefs`, `decision_outcomes`, `reasoning_audit`.
  KEINE Writes. Snapshot-Delta vor/nach Chat-Trigger.
- `ui-smoke.spec.ts` + `playwright.config.ts` — echte Chromium-Smokes, mobil
  (375 × 812) + desktop (1280 × 800). Worker-Pill, Open-Questions-Pill, Settings-
  Overflow, Console-Error-Sweep.
- `utils/auth.ts` — holt Session-Cookie via `POST /api/auth/master-login`.
- `utils/report.ts` — strukturiertes JSON-Result-Format, das vom Reporter-
  Skript zu Markdown konvertiert wird.

## Wie laufen lassen

```bash
# 1. Sicherstellen dass :4200 und :4201 laufen.
curl -s http://127.0.0.1:4200/api/health | jq .

# 2. Fetch-Smoke (sofort, keine extra Setup).
set -a && source .env.local && set +a
pnpm exec tsx tests/active/fetch-smoke.ts

# 3. DB-Verifier (read-only).
pnpm exec tsx tests/active/db-verifier.ts

# 4. Playwright UI (braucht installiertes Chromium).
pnpm exec playwright install chromium    # nur einmalig
pnpm exec playwright test --config tests/active/playwright.config.ts
```

## Defensive Defaults

- **Lese-Operationen first.** Schreiben (z.B. `POST /api/permission/.../mode`)
  passiert nur mit explizitem GET-Vorher (Zustand snapshot) + GET-Nachher
  (Zustand restore), und nur wenn `LAZYOS_SMOKE_ALLOW_WRITES=1`.
- **Kein Workspace-Create im Live-DB** ohne Cleanup-Path. Falls Smoke einen
  Test-Workspace braucht: separater Test-DB-Path via `LAZYOS_DB_PATH=...`.
- **Kein `next build` / kein `next start` / kein Service-Restart** — wir testen
  was läuft.
- **Kein destruktiver DB-Schreibvorgang** ohne Snapshot-Restore.

## Auth-Mechanismus

Die Smoke-Tests authentifizieren über `POST /api/auth/master-login` mit
`LAZYOS_ACCESS_CODE` aus `.env.local`. Das gibt ein echtes Session-Cookie
(`lazyos_session=…`) auf den ersten Founder-User in der DB.

**Bearer-Auth-Hinweis:** `LAZYOS_CHAT_KEY` / `LAZYOS_CLI_KEY` passt zwar die
Edge-Middleware (subject = `agent:cli`), aber HTML-Pages UND alle Routes die
`currentUserIdResolved()` aufrufen geben `401 auth-required` zurück — Bearer
ist nur für Service-to-Service-API-Calls geeignet, nicht für UI/Permission-
Surfaces. Deshalb master-login.
