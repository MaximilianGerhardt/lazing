/**
 * Tests für POST /api/innovate — Innovation-Mode-Engine erreichbar
 * (Lane-D · 2026-05-30).
 *
 * Fokus (Route-Contract, runInnovate gemockt):
 *   (a) Auth: kein Subject → 401; Nicht-Member → 403.
 *   (b) Bad-Body: kaputtes JSON → 400; fehlende workspaceId → 400; leerer
 *       rawText → 400.
 *   (c) Happy-Path: member + gestubbte Engine → runInnovate aufgerufen mit
 *       VERBATIM rawText (N1) → 200 mit Artefakten + counts.
 *   (d) Engine fehlt → 503; runInnovate wirft → 500.
 *
 * Mock-Architektur wie app/api/flow/compose-and-run/__tests__/route.test.ts —
 * Auth/DB/Engine/runInnovate gemockt, KEIN echtes LLM/DB.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: vi.fn().mockReturnValue('user-1'),
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: vi.fn().mockReturnValue('member'),
  canEditWorkspaceContent: vi.fn().mockReturnValue(true),
}));

vi.mock('@/db/client', () => ({
  getDb: vi.fn(() => ({ $raw: {} })),
}));

vi.mock('@/lib/llm/engines/selector', () => ({
  detectEngines: vi.fn().mockResolvedValue({}),
  pickEngine: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({ text: '{}' }),
  }),
}));

vi.mock('@/lib/innovate/contract', () => ({
  runInnovate: vi.fn(),
}));

import { POST, GET } from '../route';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent } from '@/lib/security/permissions';
import { pickEngine } from '@/lib/llm/engines/selector';
import { runInnovate } from '@/lib/innovate/contract';

const mockUser = vi.mocked(currentUserIdResolved);
const mockCanEdit = vi.mocked(canEditWorkspaceContent);
const mockPickEngine = vi.mocked(pickEngine);
const mockRunInnovate = vi.mocked(runInnovate);

function makeReq(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/innovate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mockUser.mockReturnValue('user-1');
  mockCanEdit.mockReturnValue(true);
  mockPickEngine.mockReturnValue({
    chat: vi.fn().mockResolvedValue({ text: '{}' }),
  } as never);
});

describe('POST /api/innovate — auth', () => {
  it('401 ohne Subject', async () => {
    mockUser.mockReturnValue(null);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(401);
  });

  it('403 für Nicht-Member', async () => {
    mockCanEdit.mockReturnValue(false);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(403);
    expect(mockRunInnovate).not.toHaveBeenCalled();
  });
});

describe('POST /api/innovate — bad body', () => {
  it('400 bei kaputtem JSON', async () => {
    const res = await POST(makeReq('{not json', true));
    expect(res.status).toBe(400);
  });

  it('400 ohne workspaceId', async () => {
    const res = await POST(makeReq({ rawText: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 bei leerem rawText', async () => {
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: '   ' }));
    expect(res.status).toBe(400);
    expect(mockRunInnovate).not.toHaveBeenCalled();
  });
});

describe('POST /api/innovate — happy path', () => {
  it('200 + ruft runInnovate mit VERBATIM rawText (N1)', async () => {
    const verbatim = 'Wir nehmen heygen, weil   es   schnell ist.\n\nAber warum?';
    mockRunInnovate.mockResolvedValue({
      assumptions: [{ id: 'A1', content: 'a' } as never],
      reframes: [{ id: 'R1', content: 'r' } as never],
      roasts: [{ id: 'X1', content: 'x' } as never],
      counterEvidenceSurfaces: ['<surface:counter-evidence>…</surface>'],
    });

    const res = await POST(
      makeReq({ workspaceId: 'ws1', rawText: verbatim }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      counts: { assumptions: number; reframes: number; roasts: number };
      counterEvidenceSurfaces: string[];
    };
    expect(json.counts).toEqual({ assumptions: 1, reframes: 1, roasts: 1 });
    expect(json.counterEvidenceSurfaces).toHaveLength(1);

    // N1: rawText 1:1 (kein slice/trim) durchgereicht.
    expect(mockRunInnovate).toHaveBeenCalledTimes(1);
    const args = mockRunInnovate.mock.calls[0][1];
    expect(args.workspaceId).toBe('ws1');
    expect(args.rawText).toBe(verbatim);
    expect(typeof args.callEngine).toBe('function');
  });
});

describe('POST /api/innovate — engine/fehler', () => {
  it('503 wenn keine Engine verfügbar', async () => {
    mockPickEngine.mockReturnValue(null);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(503);
  });

  it('500 wenn runInnovate wirft', async () => {
    mockRunInnovate.mockRejectedValue(new Error('boom'));
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; reqId: string };
    expect(json.error).toBe('innovate_failed');
    expect(json.reqId).toBeTruthy();
  });
});

describe('GET /api/innovate', () => {
  it('401 ohne Subject, 200 mit', async () => {
    mockUser.mockReturnValue(null);
    const r1 = await GET(
      new NextRequest('http://localhost/api/innovate', { method: 'GET' }),
    );
    expect(r1.status).toBe(401);

    mockUser.mockReturnValue('user-1');
    const r2 = await GET(
      new NextRequest('http://localhost/api/innovate', { method: 'GET' }),
    );
    expect(r2.status).toBe(200);
    const json = (await r2.json()) as { status: string };
    expect(json.status).toBe('live');
  });
});
