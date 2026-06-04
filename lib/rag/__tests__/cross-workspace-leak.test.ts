/**
 * Cross-Workspace-Leak-Tests (Phase 2 Workspace-Isolation, 2026-05-03).
 *
 * Run: `LAZYOS_DB_PATH="$HOME/.lazyos/lazyos-staging.db" \
 *       npx tsx --test --test-force-exit lib/rag/__tests__/cross-workspace-leak.test.ts`
 *
 * Was wir hier abdecken (Acceptance-Plan §11):
 *   1. retrieve({ workspaceId: 'A' }) liefert keinen Chunk mit
 *      workspace_id != 'A', auch nicht wenn die Tabelle Cross-Workspace-
 *      Chunks enthaelt.
 *   2. retrieve({ workspaceId: '' }) wirft RagWorkspaceRequiredError.
 *   3. Trigger blockiert direkten INSERT INTO rag_chunks mit Phantom-ws-id.
 *   4. View v_rag_chunks_workspace liefert die nicht-high-Chunks aller
 *      Workspaces, NIE high-Chunks.
 *   5. retrieveAcrossWorkspaces() schreibt einen Audit-Row.
 *   6. retrieveAcrossWorkspaces() ohne userId/reason/wsIds wirft.
 *
 * Test-Setup nutzt eine eigene Test-Workspace 'rag-leak-test-A' / 'rag-leak-test-B'
 * + manuell eingefuegte Test-Chunks. Cleanup am Ende.
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import { ulid } from '@/lib/ulid';
import { getDb } from '@/db/client';
import { ragChunks, ragCrossWorkspaceAudit } from '@/db/schema/rag';
import { workspaces } from '@/db/schema/workspaces';
import { and, eq, like } from 'drizzle-orm';
import {
  retrieve,
  retrieveAcrossWorkspaces,
  RagWorkspaceRequiredError,
} from '../retriever';
import { packEmbedding } from '../embedder';

const WS_A = 'rag-leak-test-a';
const WS_B = 'rag-leak-test-b';
const TEST_USER = 'usr_rag_leak_test';

// Deterministisches Embedding (avoid Xenova-Modell-Download im Test).
function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.001);
  }
  return v;
}

function insertWorkspace(id: string): void {
  const db = getDb();
  // Idempotent (INSERT OR IGNORE): wenn schon da, gar nichts.
  db.$raw
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, label, accent, path, sensitivity, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `Leak-Test ${id}`,
      'own',
      `/tmp/${id}`,
      'low',
      0,
      Date.now(),
      Date.now(),
    );
}

function insertChunk(opts: {
  workspaceId: string;
  text: string;
  sensitivity?: 'low' | 'med' | 'high';
  seed: number;
}): string {
  const db = getDb();
  const id = ulid();
  db.insert(ragChunks)
    .values({
      id,
      workspaceId: opts.workspaceId,
      sourceType: 'file',
      sourceId: `test-${opts.seed}.md`,
      sourceVersion: null,
      chunkIndex: 0,
      text: opts.text,
      embedding: packEmbedding(fakeVec(opts.seed)),
      tokenCount: Math.ceil(opts.text.length / 4),
      sensitivity: opts.sensitivity ?? 'low',
      indexedAt: Date.now(),
      expiresAt: null,
    })
    .run();
  return id;
}

function cleanup(): void {
  const db = getDb();
  // Chunks weg
  db.delete(ragChunks)
    .where(eq(ragChunks.workspaceId, WS_A))
    .run();
  db.delete(ragChunks)
    .where(eq(ragChunks.workspaceId, WS_B))
    .run();
  // Audit-Rows weg
  db.delete(ragCrossWorkspaceAudit)
    .where(eq(ragCrossWorkspaceAudit.userId, TEST_USER))
    .run();
  // Test-Workspaces weg
  db.delete(workspaces)
    .where(like(workspaces.id, 'rag-leak-test-%'))
    .run();
}

describe('cross-workspace-leak (DB-integration)', () => {
  before(() => {
    cleanup();
    insertWorkspace(WS_A);
    insertWorkspace(WS_B);
    // 5 Chunks in A
    for (let i = 0; i < 5; i++) {
      insertChunk({
        workspaceId: WS_A,
        text: `Workspace A chunk ${i} — production deploys via Vercel`,
        seed: 100 + i,
      });
    }
    // 5 Chunks in B
    for (let i = 0; i < 5; i++) {
      insertChunk({
        workspaceId: WS_B,
        text: `Workspace B chunk ${i} — production deploys via Vercel`,
        seed: 200 + i,
      });
    }
    // 1 high-sensitivity Chunk in A (darf NIE in retrieve() landen)
    insertChunk({
      workspaceId: WS_A,
      text: 'TOP SECRET classified-dossier — never leak',
      sensitivity: 'high',
      seed: 999,
    });
  });

  after(() => {
    cleanup();
  });

  it('retrieve(WS_A) liefert ausschliesslich Chunks aus WS_A', async () => {
    const result = await retrieve({
      workspaceId: WS_A,
      query: 'production deploys',
      topK: 20,
    });
    for (const hit of result.hits) {
      assert.equal(
        hit.workspaceId,
        WS_A,
        `Leak: hit ${hit.id} hat workspaceId=${hit.workspaceId}, expected ${WS_A}`,
      );
    }
    // totalCandidates = nur die nicht-high WS_A chunks
    assert.equal(result.totalCandidates, 5);
  });

  it('retrieve(WS_B) liefert ausschliesslich Chunks aus WS_B', async () => {
    const result = await retrieve({
      workspaceId: WS_B,
      query: 'production deploys',
      topK: 20,
    });
    for (const hit of result.hits) {
      assert.equal(hit.workspaceId, WS_B);
    }
    assert.equal(result.totalCandidates, 5);
  });

  it('retrieve({}) ohne workspaceId wirft RagWorkspaceRequiredError', async () => {
    await assert.rejects(
      // @ts-expect-error — Test verletzt die Pflicht-Type bewusst.
      () => retrieve({ query: 'foo' }),
      RagWorkspaceRequiredError,
    );
  });

  it('retrieve({ workspaceId: "" }) wirft RagWorkspaceRequiredError', async () => {
    await assert.rejects(
      () => retrieve({ workspaceId: '', query: 'foo' }),
      RagWorkspaceRequiredError,
    );
  });

  it('retrieve(WS_A) liefert NIEMALS high-sensitivity Chunks', async () => {
    const result = await retrieve({
      workspaceId: WS_A,
      query: 'classified-dossier',
      topK: 20,
    });
    for (const hit of result.hits) {
      assert.notEqual(
        hit.text.toLowerCase().includes('top secret'),
        true,
        `high-sensitivity Chunk geleaked: ${hit.id}`,
      );
    }
  });

  it('Trigger blockiert INSERT mit Phantom-Workspace-ID', () => {
    const db = getDb();
    assert.throws(
      () =>
        db.$raw
          .prepare(
            `INSERT INTO rag_chunks (id, workspace_id, source_type, source_id, chunk_index, text, embedding, sensitivity, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ulid(),
            'phantom-ws-does-not-exist',
            'file',
            'test.md',
            0,
            'leak attempt',
            packEmbedding(fakeVec(1)),
            'low',
            Date.now(),
          ),
      /must reference workspaces\.id/,
    );
  });

  it('Trigger blockiert INSERT mit leerem workspace_id', () => {
    const db = getDb();
    assert.throws(
      () =>
        db.$raw
          .prepare(
            `INSERT INTO rag_chunks (id, workspace_id, source_type, source_id, chunk_index, text, embedding, sensitivity, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ulid(),
            '',
            'file',
            'test.md',
            0,
            'leak attempt',
            packEmbedding(fakeVec(1)),
            'low',
            Date.now(),
          ),
      /must reference workspaces\.id/,
    );
  });

  it('View v_rag_chunks_workspace zeigt NIE high-sensitivity Chunks', () => {
    const db = getDb();
    const rows = db.$raw
      .prepare(
        `SELECT id, sensitivity FROM v_rag_chunks_workspace WHERE workspace_id = ?`,
      )
      .all(WS_A) as Array<{ id: string; sensitivity: string }>;
    for (const r of rows) {
      assert.notEqual(r.sensitivity, 'high');
    }
    // 5 nicht-high in WS_A erwartet (high wird gefiltert)
    assert.equal(rows.length, 5);
  });

  it('retrieveAcrossWorkspaces schreibt Audit-Row', async () => {
    const result = await retrieveAcrossWorkspaces({
      userId: TEST_USER,
      workspaceIds: [WS_A, WS_B],
      query: 'production deploys',
      reason: 'leak-test-cross-search',
      topK: 20,
    });
    assert.ok(result.auditId, 'auditId should be returned');
    const db = getDb();
    const rows = db
      .select()
      .from(ragCrossWorkspaceAudit)
      .where(
        and(
          eq(ragCrossWorkspaceAudit.userId, TEST_USER),
          eq(ragCrossWorkspaceAudit.id, result.auditId),
        ),
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'leak-test-cross-search');
    assert.ok(rows[0].hits >= 0);
    const seen = JSON.parse(rows[0].workspacesSeen);
    assert.ok(Array.isArray(seen));
  });

  it('retrieveAcrossWorkspaces ohne userId wirft', async () => {
    await assert.rejects(
      () =>
        retrieveAcrossWorkspaces({
          userId: '',
          workspaceIds: [WS_A],
          query: 'foo',
          reason: 'test',
        }),
      /userId required/,
    );
  });

  it('retrieveAcrossWorkspaces ohne reason wirft', async () => {
    await assert.rejects(
      () =>
        retrieveAcrossWorkspaces({
          userId: TEST_USER,
          workspaceIds: [WS_A],
          query: 'foo',
          reason: '',
        }),
      /reason required/,
    );
  });

  it('retrieveAcrossWorkspaces mit leerem workspaceIds wirft', async () => {
    await assert.rejects(
      () =>
        retrieveAcrossWorkspaces({
          userId: TEST_USER,
          workspaceIds: [],
          query: 'foo',
          reason: 'test',
        }),
      RagWorkspaceRequiredError,
    );
  });
});
