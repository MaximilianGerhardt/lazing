/**
 * Tests für POST /api/intake — Lane-A Communication-Intake erreichbar
 * (Lane-D · 2026-05-30).
 *
 * Hier wird die ECHTE Lane-A-Logik (buildSourceEnvelope + insertIntakeEvent)
 * gegen eine in-memory better-sqlite3-DB aus der ECHTEN Migration 0119 gefahren
 * (kein LLM in Lane A — deterministisch). Nur Auth + getDb sind gemockt.
 *
 * Fokus:
 *   (a) Auth: kein Subject → 401; Nicht-Member → 403.
 *   (b) Bad-Body: kaputtes JSON → 400; fehlende workspaceId → 400; unbekanntes
 *       sourceKind → 400; leerer rawContent → 400; fremde sensitivity → 400.
 *   (c) Happy-Path: member → EINE intake_events-Row im FSM 'staged', rawContent
 *       VERBATIM (N1) in der DB; Response trägt intakeEventId + contentHash.
 *   (d) Idempotenz (N10): zweiter identischer POST → deduplicated=true, KEINE
 *       zweite Row.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: vi.fn().mockReturnValue('user-1'),
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: vi.fn().mockReturnValue('member'),
  canEditWorkspaceContent: vi.fn().mockReturnValue(true),
}));

// getDb().$raw → die test-eigene in-memory DB.
let testRaw: import('better-sqlite3').Database;
vi.mock('@/db/client', () => ({
  getDb: vi.fn(() => ({ $raw: testRaw })),
}));

import { POST } from '../route';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent } from '@/lib/security/permissions';

const mockUser = vi.mocked(currentUserIdResolved);
const mockCanEdit = vi.mocked(canEditWorkspaceContent);

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.exec(
    readFileSync(
      path.join(process.cwd(), 'db', 'migrations', '0119_intake_events.sql'),
      'utf8',
    ),
  );
  return raw;
}

function makeReq(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  testRaw = freshDb();
});

afterEach(() => {
  vi.clearAllMocks();
  mockUser.mockReturnValue('user-1');
  mockCanEdit.mockReturnValue(true);
  try {
    testRaw.close();
  } catch {
    /* noop */
  }
});

describe('POST /api/intake — auth', () => {
  it('401 ohne Subject', async () => {
    mockUser.mockReturnValue(null);
    const res = await POST(
      makeReq({ workspaceId: 'ws1', sourceKind: 'whatsapp', rawContent: 'x' }),
    );
    expect(res.status).toBe(401);
  });

  it('403 für Nicht-Member', async () => {
    mockCanEdit.mockReturnValue(false);
    const res = await POST(
      makeReq({ workspaceId: 'ws1', sourceKind: 'whatsapp', rawContent: 'x' }),
    );
    expect(res.status).toBe(403);
    const count = testRaw
      .prepare('SELECT COUNT(*) AS c FROM intake_events')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('POST /api/intake — bad body', () => {
  it('400 bei kaputtem JSON', async () => {
    const res = await POST(makeReq('{bad', true));
    expect(res.status).toBe(400);
  });

  it('400 ohne workspaceId', async () => {
    const res = await POST(
      makeReq({ sourceKind: 'whatsapp', rawContent: 'x' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 bei unbekanntem sourceKind', async () => {
    const res = await POST(
      makeReq({ workspaceId: 'ws1', sourceKind: 'carrier-pigeon', rawContent: 'x' }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_source_kind');
  });

  it('400 bei leerem rawContent', async () => {
    const res = await POST(
      makeReq({ workspaceId: 'ws1', sourceKind: 'whatsapp', rawContent: '   ' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 bei fremder sensitivity', async () => {
    const res = await POST(
      makeReq({
        workspaceId: 'ws1',
        sourceKind: 'whatsapp',
        rawContent: 'x',
        sensitivity: 'top-secret',
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_sensitivity');
  });
});

describe('POST /api/intake — happy path', () => {
  it('200 → EINE staged-Row, rawContent VERBATIM (N1)', async () => {
    const verbatim = 'Kunde sagt:   „Bitte   Deadline   auf Freitag."\nDanke!';
    const res = await POST(
      makeReq({
        workspaceId: 'ws1',
        sourceKind: 'whatsapp',
        rawContent: verbatim,
        speaker: 'contact-42',
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      intakeEventId: string;
      deduplicated: boolean;
      contentHash: string;
      classificationStatus: string;
    };
    expect(json.intakeEventId).toMatch(/^INE-/);
    expect(json.deduplicated).toBe(false);
    expect(json.classificationStatus).toBe('staged'); // §7.2 kein auto-run
    expect(json.contentHash).toBeTruthy();

    const row = testRaw
      .prepare(
        'SELECT raw_content, fsm_state, source_kind, speaker_external_id FROM intake_events WHERE id = ?',
      )
      .get(json.intakeEventId) as {
      raw_content: string;
      fsm_state: string;
      source_kind: string;
      speaker_external_id: string | null;
    };
    expect(row.raw_content).toBe(verbatim); // N1: kein slice
    expect(row.fsm_state).toBe('staged');
    expect(row.source_kind).toBe('whatsapp');
    expect(row.speaker_external_id).toBe('contact-42');
  });

  it('Idempotenz (N10): zweiter identischer POST → deduplicated, KEINE 2. Row', async () => {
    const body = {
      workspaceId: 'ws1',
      sourceKind: 'telegram',
      rawContent: 'Exakt derselbe Inhalt.',
      externalId: 'fixed-ext-1',
      receivedAt: 1_700_000_000_000,
    };
    const r1 = await POST(makeReq(body));
    const j1 = (await r1.json()) as { intakeEventId: string; deduplicated: boolean };
    expect(j1.deduplicated).toBe(false);

    const r2 = await POST(makeReq(body));
    const j2 = (await r2.json()) as { intakeEventId: string; deduplicated: boolean };
    expect(r2.status).toBe(200);
    expect(j2.deduplicated).toBe(true);
    expect(j2.intakeEventId).toBe(j1.intakeEventId);

    const count = testRaw
      .prepare('SELECT COUNT(*) AS c FROM intake_events')
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
