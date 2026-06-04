/**
 * mcp-proxy-Tests (Phase 2 Workspace-Isolation, 2026-05-03).
 *
 * Run: `npx tsx --test --test-force-exit lib/rag/__tests__/mcp-proxy.test.ts`
 *
 * 4 Cases laut Phase-2-Spec:
 *   (a) ws-spezifisches Doc -> durchgelassen
 *   (b) globales Doc ohne ws-Slug -> sharedKnowledge=true (+ Audit)
 *   (c) sensitivity=high -> blockiert (auch wenn ws-Slug matcht)
 *   (d) cross-ws-search ohne expliziten admin-flag -> blockiert
 *
 * Audit-Inserts werden hier NICHT gegen die DB validiert — der Proxy
 * schluckt DB-Fehler defensiv. Ob die Audit-Tabelle live geschrieben
 * wird, deckt `cross-workspace-leak.test.ts` ab.
 */

import { strict as assert } from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { enforceMcpWorkspaceScope } from '../mcp-proxy';

// Build knowledge-base paths under the home dir so the tests are host-neutral.
// The proxy's WS_SLUG_RE matches `/workspace/<slug>/` anywhere in the path.
const kb = (...segments: string[]): string =>
  path.join(os.homedir(), 'knowledge-base', ...segments);
const std = (...segments: string[]): string =>
  path.join(os.homedir(), 'standards', ...segments);

describe('enforceMcpWorkspaceScope · 4 cases', () => {
  it('(a) ws-spezifisches Doc -> durchgelassen, workspaceMatch=true', () => {
    const result = enforceMcpWorkspaceScope(
      [{ filePath: kb('workspace', 'demo-fitness', 'notes.md') }],
      { workspaceId: 'demo-fitness', store: 'local-rag', userId: 'usr_1' },
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].workspaceMatch, true);
    assert.equal(result.hits[0].sharedKnowledge, false);
    assert.equal(result.hits[0].blocked, false);
    assert.equal(result.sharedKnowledgeCount, 0);
    assert.equal(result.blockedCount, 0);
  });

  it('(b) globales Doc ohne ws-Slug -> sharedKnowledge=true', () => {
    const result = enforceMcpWorkspaceScope(
      [{ filePath: kb('research', 'foo.md') }],
      {
        workspaceId: 'demo-fitness',
        store: 'local-rag',
        userId: 'usr_1',
        reason: 'spawn-context',
      },
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].workspaceMatch, false);
    assert.equal(result.hits[0].sharedKnowledge, true);
    assert.equal(result.hits[0].blocked, false);
    assert.equal(result.hits[0].scopeReason, 'no-workspace-slug');
    assert.equal(result.sharedKnowledgeCount, 1);
  });

  it('(c) sensitivity=high -> blockiert, auch wenn ws-Slug matcht', () => {
    const result = enforceMcpWorkspaceScope(
      [
        {
          filePath: kb('workspace', 'demo-fitness', 'secret.md'),
          sensitivity: 'high',
        },
      ],
      { workspaceId: 'demo-fitness', store: 'local-rag', userId: 'usr_1' },
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].blocked, true);
    assert.equal(result.hits[0].workspaceMatch, false);
    assert.equal(result.hits[0].scopeReason, 'sensitivity-high');
    assert.equal(result.blockedCount, 1);
  });

  it('(d) cross-ws-search ohne expliziten admin-flag -> blockiert', () => {
    const result = enforceMcpWorkspaceScope(
      [
        {
          filePath: kb('workspace', 'demo-client', 'leads.md'),
        },
      ],
      { workspaceId: 'demo-fitness', store: 'local-rag', userId: 'usr_1' },
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].blocked, true);
    assert.equal(result.hits[0].workspaceMatch, false);
    assert.match(result.hits[0].scopeReason, /^wrong-workspace:demo-client$/);
    assert.equal(result.blockedCount, 1);
  });

  it('hardDrop: blockierte Hits werden komplett entfernt', () => {
    const result = enforceMcpWorkspaceScope(
      [
        { filePath: kb('workspace', 'demo-fitness', 'ok.md') },
        { filePath: kb('workspace', 'demo-client', 'leak.md') },
      ],
      {
        workspaceId: 'demo-fitness',
        store: 'local-rag',
        userId: 'usr_1',
        hardDrop: true,
      },
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].workspaceMatch, true);
    assert.equal(result.dropped, 1);
    assert.equal(result.blockedCount, 1);
  });

  it('standards-rag: alles shared-by-design, kein blocked', () => {
    const result = enforceMcpWorkspaceScope(
      [
        { filePath: std('web', 'web-001.md') },
        { filePath: std('legal', 'leg-006.md') },
      ],
      { workspaceId: 'demo-fitness', store: 'standards-rag', userId: 'usr_1' },
    );
    assert.equal(result.hits.length, 2);
    for (const h of result.hits) {
      assert.equal(h.sharedKnowledge, true);
      assert.equal(h.blocked, false);
      assert.equal(h.scopeReason, 'standards-shared-by-design');
    }
    assert.equal(result.blockedCount, 0);
    assert.equal(result.auditId, null);
  });

  it('Hard-Fail bei leerem workspaceId', () => {
    assert.throws(
      () =>
        enforceMcpWorkspaceScope([], {
          workspaceId: '',
          store: 'local-rag',
        }),
      /workspaceId required/,
    );
  });

  it('Mixed batch: 4 hits = 1 ws-match + 1 shared + 1 wrong-ws + 1 high', () => {
    const result = enforceMcpWorkspaceScope(
      [
        { filePath: kb('workspace', 'demo-fitness', 'a.md') },
        { filePath: kb('research', 'topic.md') },
        { filePath: kb('workspace', 'demo-client', 'leak.md') },
        {
          filePath: kb('workspace', 'demo-fitness', 'secret.md'),
          sensitivity: 'high',
        },
      ],
      { workspaceId: 'demo-fitness', store: 'local-rag', userId: 'usr_1' },
    );
    assert.equal(result.hits.length, 4);
    assert.equal(result.sharedKnowledgeCount, 1);
    assert.equal(result.blockedCount, 2); // wrong-ws + sensitivity-high
  });
});
