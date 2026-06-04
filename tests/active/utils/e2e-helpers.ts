/**
 * tests/active/utils/e2e-helpers.ts
 *
 * Geteilte Playwright-Helper für Phase 1 Wave 2 — Browser-E2E gegen
 * example-website-3 (2026-05-29).
 *
 * Was hier drin liegt:
 *   - workspaceLogin(): Master-Login → Session-Cookie für die Page-Context.
 *   - ensurePaWebsite3Workspace(): findet ODER legt example-website-3 an
 *     (POST /api/workspaces, Owner-Label „PA Website 3 E2E"). Liefert die id.
 *   - selectWorkspace(): schreibt `lazyos.workspace` in localStorage UND
 *     feuert das `workspace-change` Event, damit ChatShell sofort umschwenkt
 *     (gleiche Mechanik wie useSetWorkspace in lib/nav/hooks.ts).
 *   - submitChatPrompt(): tippt + sendet Text im Composer. Greift den
 *     Composer-`textarea` per stable role (aria-label="Eingabe").
 *   - waitForSurface(): polling-Wait bis irgendein <details data-test=...>
 *     ODER irgendwo eine QuickChoice mit gewünschten Optionen erscheint.
 *
 * Disziplin:
 *   - KEIN App-Code-Edit. Wir reden NUR mit der existierenden Page.
 *   - Auth: master-login (gleicher Pfad wie ui-smoke.spec.ts).
 *   - Tailscale-URL standard; lokal:4200 via LAZYOS_SMOKE_BASE_URL=… override.
 */

import { expect, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

export const BASE =
  process.env.LAZYOS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4200';

const ACCESS_CODE = process.env.LAZYOS_ACCESS_CODE;

/**
 * Setzt das Session-Cookie via POST /api/auth/master-login auf den
 * BrowserContext. Wirft mit klarer Meldung wenn ACCESS_CODE fehlt.
 */
export async function workspaceLogin(context: BrowserContext): Promise<void> {
  if (!ACCESS_CODE || ACCESS_CODE.length < 16) {
    throw new Error(
      'LAZYOS_ACCESS_CODE not set or too short. Source .env.local before running.',
    );
  }
  const res = await context.request.post(`${BASE}/api/auth/master-login`, {
    headers: { 'content-type': 'application/json', origin: BASE },
    data: { accessCode: ACCESS_CODE },
  });
  expect(
    res.status(),
    `master-login failed: ${res.status()} ${await res.text()}`,
  ).toBe(200);
}

/**
 * Sucht in /api/workspaces den ersten Eintrag mit id oder label, der zu
 * example-website-3 passt — legt sonst einen frischen via POST an. Liefert die
 * Workspace-id zurück.
 *
 * Owner-Note (Handoff verbatim): „Erstelle dazu ggf. oder nutze den neuen
 * Workspace PA Website 3." → wir BEVORZUGEN existierende
 * example-website-3* / „PA Website 3"-Matches, damit der Owner den-selben
 * Workspace in der UI sieht den der Test traf.
 */
export interface EnsuredWorkspace {
  id: string;
  /** organization_id wenn bekannt — wird für selectWorkspace/applyWorkspaceSelection
   *  gebraucht, weil OrgSwitcher sonst auto-setOrg() auf die erste verfügbare
   *  Org schaltet und so __org_root__:<orgId> als Workspace setzt. */
  orgId?: string;
}

export async function ensurePaWebsite3Workspace(
  request: APIRequestContext,
): Promise<EnsuredWorkspace> {
  // Liste holen.
  const listRes = await request.get(`${BASE}/api/workspaces`);
  expect(
    listRes.status(),
    `GET /api/workspaces failed: ${listRes.status()}`,
  ).toBe(200);
  const body = (await listRes.json()) as
    | {
        ok?: boolean;
        workspaces?: Array<{ id: string; label: string; organization_id?: string; organizationId?: string }>;
      }
    | { items?: Array<{ id: string; label: string; organization_id?: string; organizationId?: string }> };
  const list = Array.isArray((body as { workspaces?: unknown }).workspaces)
    ? (body as { workspaces: Array<{ id: string; label: string; organization_id?: string; organizationId?: string }> }).workspaces
    : Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: Array<{ id: string; label: string; organization_id?: string; organizationId?: string }> }).items
      : [];

  const match =
    list.find(
      (w) =>
        w.id.startsWith('example-website-3') ||
        /^PA Website 3\b/i.test(w.label) ||
        /^PA Website 3 E2E$/i.test(w.label),
    ) ?? null;
  if (match) {
    return { id: match.id, orgId: match.organization_id ?? match.organizationId };
  }

  const createRes = await request.post(`${BASE}/api/workspaces`, {
    headers: { 'content-type': 'application/json' },
    data: { label: 'PA Website 3 E2E' },
  });
  expect(
    createRes.status(),
    `POST /api/workspaces failed: ${createRes.status()} ${await createRes.text()}`,
  ).toBeLessThan(400);
  const created = (await createRes.json()) as
    | { id?: string; workspace?: { id: string; organization_id?: string } }
    | { ok?: boolean; id?: string };
  const id =
    (created as { id?: string }).id ??
    (created as { workspace?: { id: string } }).workspace?.id ??
    '';
  if (!id) throw new Error('workspace create did not return an id');
  const orgId =
    (created as { workspace?: { organization_id?: string } }).workspace?.organization_id;
  return { id, orgId };
}

/**
 * Verdrahtet die Page mit dem gewünschten Workspace BEVOR ChatShell rendert.
 *
 * Empirischer Befund (2026-05-29, Wave-2-Debug-Run):
 *   `addInitScript`+localStorage allein reicht NICHT — useSyncExternalStore
 *   liest cachedWorkspaceId einmal und ChatShell rendert dann mit dem
 *   Default-Fallback (`__org_root__:workspace`). Symptom in den Tests:
 *   compose-and-run-Body = `{"workspaceId":"__org_root__:workspace"}` →
 *   HTTP 400 invalid_workspace_id.
 *
 * Fix (deterministisch + minimal-invasiv): VOR + nach `page.goto`:
 *   1. addInitScript schreibt localStorage so früh wie möglich.
 *   2. Nach goto: nochmals evaluate auf localStorage + DispatchEvent
 *      `workspace-change` → subscribe-Listener in lib/nav/hooks.ts:67
 *      ruft listener() → useSyncExternalStore re-rendert → ChatShell
 *      bekommt das neue currentWorkspace.
 *
 * Storage-Key + Event-Name verbatim aus lib/nav/types.ts:
 *   WORKSPACE_STORAGE_KEY = 'lazyos.workspace'
 *   WORKSPACE_CHANGE_EVENT = 'workspace-change'
 */
export async function selectWorkspace(
  page: Page,
  workspaceId: string,
  orgId?: string,
): Promise<void> {
  await page.addInitScript(
    ({ wsId, oId }: { wsId: string; oId: string | undefined }) => {
      try {
        window.localStorage.setItem('lazyos.workspace', wsId);
      } catch {
        /* non-fatal */
      }
      if (oId) {
        try {
          window.localStorage.setItem('lazyos.org', oId);
        } catch {
          /* non-fatal */
        }
      }
    },
    { wsId: workspaceId, oId: orgId },
  );
}

/**
 * Schreibt nach `page.goto` nochmals localStorage UND feuert das
 * `workspace-change` Event, damit alle useSyncExternalStore-Subscriber
 * (inkl. ChatShell.tsx über useCurrentWorkspace) sofort re-rendern.
 *
 * Idempotent — kann mehrfach aufgerufen werden.
 */
export async function applyWorkspaceSelection(
  page: Page,
  workspaceId: string,
  orgId?: string,
): Promise<void> {
  await page.evaluate(
    ({ wsId, oId }: { wsId: string; oId: string | undefined }) => {
      if (oId) {
        try {
          window.localStorage.setItem('lazyos.org', oId);
        } catch {
          /* non-fatal */
        }
        // Cookie SAR: lazyos.org wird auch als cookie persistiert; OrgSwitcher
        // liest beim mount aus localStorage, das reicht für den Auto-setOrg.
        try {
          document.cookie = `lazyos.org=${encodeURIComponent(oId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
        } catch {
          /* non-fatal */
        }
        try {
          window.dispatchEvent(new CustomEvent('org-change'));
        } catch {
          /* non-fatal */
        }
      }
      try {
        window.localStorage.setItem('lazyos.workspace', wsId);
      } catch {
        /* non-fatal */
      }
      try {
        window.dispatchEvent(
          new CustomEvent('workspace-change', {
            detail: { workspace: { id: wsId } },
          }),
        );
      } catch {
        /* non-fatal */
      }
    },
    { wsId: workspaceId, oId: orgId },
  );
}

/**
 * Tippt `text` in den Chat-Composer und sendet (Enter). Wartet darauf,
 * dass die Eingabe wirklich im Feld gelandet ist (defensive — page.fill
 * kann auf langsamen CI/Tailscale-Pfaden Race-Conditions zeigen).
 *
 * Selektoren basieren auf den verifizierten ChatComposer-Markern:
 *   - <textarea aria-label="..."> (Default-ariaLabel kommt vom Composer)
 *   - .lazyos-composer__input
 *   - <button aria-label="Senden" type="submit">
 */
export async function submitChatPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea.lazyos-composer__input').first();
  await composer.waitFor({ state: 'visible', timeout: 10_000 });
  await composer.click();
  await composer.fill(text);
  // Sicherstellen dass der Text wirklich im Feld ist (Tailscale-RTT-Schutz).
  const actual = await composer.inputValue();
  if (actual !== text) {
    // Letzter Versuch via type — fill kann bei extrem langen Strings
    // gelegentlich verkürzen.
    await composer.fill('');
    await composer.type(text, { delay: 0 });
  }
  // Senden — entweder Submit-Button oder Enter.
  const sendBtn = page.locator('button.lazyos-composer__send').first();
  const sendVisible = await sendBtn.isVisible().catch(() => false);
  if (sendVisible) {
    await sendBtn.click();
  } else {
    await composer.press('Enter');
  }
}

/**
 * Pollt bis ein Selector matcht ODER die Timeout-Zeit abgelaufen ist.
 * Liefert true bei Match, false sonst (KEIN Throw — der Test kann den
 * Befund als „rote Akzeptanz" dokumentieren).
 */
export async function pollFor(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loc = page.locator(selector).first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Polling-Wait auf ein erkennbares „der Flow ist gestartet"-Signal.
 * Heuristik: irgendeine Surface mit `data-test^="surface-"` ODER eine
 * QuickChoice-Surface (`.qc`) ODER ein Auto-Flow-Toast.
 */
export async function waitForAnySurface(page: Page, timeoutMs = 90_000): Promise<boolean> {
  const sel =
    '[data-test^="surface-"], .qc, [data-test="flow-graph-collapsed-chip"], [data-test="surface-flow-graph"], [data-test="surface-flow-coupling"], [data-test="surface-discovery"]';
  return pollFor(page, sel, timeoutMs);
}

/**
 * Sammelt alle Network-POSTs auf das gegebene URL-Suffix in der Page.
 * Wird mit Test-Start aufgerufen und am Ende per `getCounts()` ausgewertet.
 */
export interface RequestCollector {
  composeAndRun: number;
  chatStream: number;
  chatAnswer: number;
  composeAndRunBodies: Array<string>;
  /** Response-Status pro POST /api/flow/compose-and-run (chronologisch). */
  composeAndRunStatuses: Array<number>;
  /** Response-Body-Snippets (≤ 800 chars), chronologisch. */
  composeAndRunResponseSnippets: Array<string>;
}
export function collectRequests(page: Page): RequestCollector {
  const c: RequestCollector = {
    composeAndRun: 0,
    chatStream: 0,
    chatAnswer: 0,
    composeAndRunBodies: [],
    composeAndRunStatuses: [],
    composeAndRunResponseSnippets: [],
  };
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const u = req.url();
    if (u.includes('/api/flow/compose-and-run')) {
      c.composeAndRun++;
      try {
        const body = req.postData() ?? '';
        c.composeAndRunBodies.push(body.slice(0, 4000));
      } catch {
        /* ignore */
      }
    } else if (u.includes('/api/chat/stream')) {
      c.chatStream++;
    } else if (u.includes('/api/chat/answer')) {
      c.chatAnswer++;
    }
  });
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!u.includes('/api/flow/compose-and-run')) return;
    c.composeAndRunStatuses.push(resp.status());
    try {
      const text = await resp.text();
      c.composeAndRunResponseSnippets.push(text.slice(0, 800));
    } catch {
      c.composeAndRunResponseSnippets.push('<unreadable>');
    }
  });
  return c;
}
