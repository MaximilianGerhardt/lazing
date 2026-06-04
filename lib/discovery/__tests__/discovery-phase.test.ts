/**
 * Slice C · C2 — Discovery-Phase Unit-Tests (2026-05-29).
 *
 * Zero-Network: alle Tests stubben den `urlFetcher`. Zero-DB: nichts touched
 * SQLite/getDb (Discovery liest nicht aus dem Workspace).
 */

import { describe, it, expect } from 'vitest';
import {
  runDiscovery,
  renderDiscoveryContextBlock,
  type FetchPayload,
  type UrlFetcher,
} from '../discovery-phase';

const HTML_EXAMPLE_AGENCY = `
<!doctype html><html><head>
  <title>example-agency — AI for the rest of us</title>
  <meta name="description" content="example-agency baut maßgeschneiderte AI-Lösungen.">
</head><body>
  <h1>Willkommen bei example-agency</h1>
  <p>Wir liefern AI-Workflows für Mittelstand und Agenturen.</p>
  <script>alert('x')</script>
</body></html>`;

const HTML_PA = `
<!doctype html><html><head>
  <title>example.com — Strategie und Engineering</title>
</head><body>
  <h2>Unsere Leistung</h2>
  <p>Strategie, Build, Betrieb in einem Team.</p>
</body></html>`;

function makeStubFetcher(map: Record<string, Partial<FetchPayload>>): UrlFetcher {
  return async (url, _opts) => {
    const hit = map[url];
    if (!hit) {
      return { status: 404, body: '' };
    }
    return {
      status: hit.status ?? 200,
      contentType: hit.contentType ?? 'text/html; charset=utf-8',
      body: hit.body ?? '',
    };
  };
}

describe('runDiscovery — Owner-Prompt example-agency.example + example.com + Meisterdokument', () => {
  it('fetcht beide bare-Domains (https-erzwungen) und liefert Snapshots + DocMention', async () => {
    const fetcher = makeStubFetcher({
      'https://example-agency.example': { body: HTML_EXAMPLE_AGENCY },
      'https://example.com': { body: HTML_PA },
    });

    const r = await runDiscovery({
      workspaceId: 'ws-test',
      intent:
        'Bitte schau dir example-agency.example und example.com an. Ich sende dir gleich das Meisterdokument als PDF.',
      urlFetcher: fetcher,
    });

    expect(r.urls).toHaveLength(2);
    const aivi = r.urls.find((u) => u.url === 'https://example-agency.example');
    const pa = r.urls.find((u) => u.url === 'https://example.com');
    expect(aivi?.status).toBe('ok');
    expect(aivi?.title).toContain('example-agency');
    expect(aivi?.summary).toMatch(/AI-Workflows/i);
    expect(pa?.status).toBe('ok');

    // DocMention erkannt.
    expect(r.pendingDocRequests.length).toBeGreaterThan(0);
    expect(r.pendingDocRequests.join(' ')).toMatch(/Meisterdokument/i);

    // Kontextblock enthält Header + Domains + DocMention-Anweisung.
    expect(r.builtContext).toContain('Aktuelle Discovery (vor dem Plan)');
    expect(r.builtContext).toContain('example-agency');
    expect(r.builtContext).toContain('example.com');
    expect(r.builtContext).toMatch(/Dokumente vom Owner anforder/);
  });
});

describe('runDiscovery — fail-soft Verhalten', () => {
  it('eine tote URL kippt nicht den ganzen Discovery (andere bleiben grün)', async () => {
    const fetcher: UrlFetcher = async (url) => {
      if (url === 'https://dead.example') throw new Error('ECONNREFUSED');
      return { status: 200, contentType: 'text/html', body: HTML_EXAMPLE_AGENCY };
    };
    const r = await runDiscovery({
      workspaceId: 'ws-x',
      intent: 'Refs: https://dead.example und https://example-agency.example/about',
      urlFetcher: fetcher,
    });
    expect(r.urls).toHaveLength(2);
    const dead = r.urls.find((u) => u.url === 'https://dead.example');
    const alive = r.urls.find((u) => u.url === 'https://example-agency.example/about');
    expect(dead?.status).toBe('failed');
    expect(alive?.status).toBe('ok');
  });

  it('Timeout wird als „timeout"-Status erkennbar', async () => {
    const fetcher: UrlFetcher = async (_url, { signal }) => {
      // Warte explizit auf das Abort-Signal — simulieren eines hängenden Hosts.
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted: discovery-timeout'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    };
    const r = await runDiscovery({
      workspaceId: 'ws-x',
      intent: 'siehe https://slow.example',
      urlFetcher: fetcher,
      fetchTimeoutMs: 1_000,
    });
    expect(r.urls).toHaveLength(1);
    expect(r.urls[0]?.status).toBe('timeout');
  });

  it('leerer Output ⇒ leerer Kontextblock (Caller-Idempotenz)', async () => {
    const r = await runDiscovery({ workspaceId: 'ws', intent: 'nur ein Satz ohne Refs.' });
    expect(r.urls).toEqual([]);
    expect(r.pendingDocRequests).toEqual([]);
    expect(r.builtContext).toBe('');
  });

  it('DocMention OHNE URL ⇒ Kontextblock nur mit DocMention-Anweisung', async () => {
    const r = await runDiscovery({
      workspaceId: 'ws',
      intent: 'Ich sende dir gleich das Meisterdokument als PDF.',
    });
    expect(r.urls).toEqual([]);
    expect(r.pendingDocRequests.length).toBeGreaterThan(0);
    expect(r.builtContext).toContain('Aktuelle Discovery');
    expect(r.builtContext).toMatch(/Dokumente vom Owner anforder/);
  });
});

describe('runDiscovery — parallel + cap', () => {
  it('maxUrls capped die Anzahl der Fetches', async () => {
    const fetcher = makeStubFetcher({
      'https://a.com': { body: '<title>A</title>' },
      'https://b.com': { body: '<title>B</title>' },
      'https://c.com': { body: '<title>C</title>' },
    });
    const r = await runDiscovery({
      workspaceId: 'ws',
      intent: 'a.com b.com c.com',
      urlFetcher: fetcher,
      maxUrls: 2,
    });
    expect(r.urls).toHaveLength(2);
  });

  it('fetcht parallel (alle laufen in der gleichen Zeit-Spanne, nicht sequenziell)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher: UrlFetcher = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: 200, body: '<title>x</title>' };
    };
    await runDiscovery({
      workspaceId: 'ws',
      intent: 'a.com b.com c.com d.com e.com',
      urlFetcher: fetcher,
      maxParallel: 5,
    });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

describe('renderDiscoveryContextBlock — Format', () => {
  it('leer + leer ⇒ leerer String', () => {
    expect(renderDiscoveryContextBlock([], [])).toBe('');
  });

  it('failed-URL erscheint mit „nicht erreichbar"-Hinweis', () => {
    const block = renderDiscoveryContextBlock(
      [{ url: 'https://x.io', status: 'failed', source: 'fetched' }],
      [],
    );
    expect(block).toContain('nicht erreichbar (failed)');
  });

  it('ok-URL mit Title rendert als „**Title** — url"', () => {
    const block = renderDiscoveryContextBlock(
      [{ url: 'https://x.io', status: 'ok', title: 'X-Site', summary: 'Hallo', source: 'fetched' }],
      [],
    );
    expect(block).toContain('**X-Site** — https://x.io');
    expect(block).toContain('> Hallo');
  });
});
