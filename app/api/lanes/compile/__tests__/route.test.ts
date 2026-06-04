/**
 * Tests für POST /api/lanes/compile — Expertise-Compiler erreichbar
 * (Lane-D · 2026-05-30).
 *
 * Fokus (Route-Contract, compileKnowledgeForms gemockt):
 *   (a) Auth: kein Subject → 401; Nicht-Member → 403.
 *   (b) Bad-Body: kaputtes JSON → 400; fehlende workspaceId → 400; KEIN/
 *       BEIDE Quellen (intakeEventId + rawText) → 400 (XOR).
 *   (c) Happy-Path rawText: member + Engine → compileKnowledgeForms mit
 *       VERBATIM rawText (N1) → 200 { forms, count }.
 *   (d) Happy-Path intakeEventId → durchgereicht.
 *   (e) Compiler wirft 'not found' → 404; sonstiger Bedienfehler → 400;
 *       keine Engine → 503.
 *
 * Mock-Architektur wie compose-and-run route.test.ts.
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
    chat: vi.fn().mockResolvedValue({ text: '{"forms":[]}' }),
  }),
}));

vi.mock('@/lib/lanes/expertise-compiler/compile', () => ({
  compileKnowledgeForms: vi.fn(),
}));

import { POST } from '../route';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent } from '@/lib/security/permissions';
import { pickEngine } from '@/lib/llm/engines/selector';
import { compileKnowledgeForms } from '@/lib/lanes/expertise-compiler/compile';

const mockUser = vi.mocked(currentUserIdResolved);
const mockCanEdit = vi.mocked(canEditWorkspaceContent);
const mockPickEngine = vi.mocked(pickEngine);
const mockCompile = vi.mocked(compileKnowledgeForms);

function makeReq(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/lanes/compile', {
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
    chat: vi.fn().mockResolvedValue({ text: '{"forms":[]}' }),
  } as never);
});

describe('POST /api/lanes/compile — auth', () => {
  it('401 ohne Subject', async () => {
    mockUser.mockReturnValue(null);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(401);
  });

  it('403 für Nicht-Member', async () => {
    mockCanEdit.mockReturnValue(false);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(403);
    expect(mockCompile).not.toHaveBeenCalled();
  });
});

describe('POST /api/lanes/compile — bad body', () => {
  it('400 bei kaputtem JSON', async () => {
    const res = await POST(makeReq('{bad', true));
    expect(res.status).toBe(400);
  });

  it('400 ohne workspaceId', async () => {
    const res = await POST(makeReq({ rawText: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 wenn WEDER intakeEventId NOCH rawText (XOR)', async () => {
    const res = await POST(makeReq({ workspaceId: 'ws1' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_source');
    expect(mockCompile).not.toHaveBeenCalled();
  });

  it('400 wenn BEIDE Quellen (XOR)', async () => {
    const res = await POST(
      makeReq({ workspaceId: 'ws1', rawText: 'x', intakeEventId: 'INE-1' }),
    );
    expect(res.status).toBe(400);
    expect(mockCompile).not.toHaveBeenCalled();
  });
});

describe('POST /api/lanes/compile — happy path', () => {
  it('200 + VERBATIM rawText (N1) → forms/count', async () => {
    const verbatim = 'PV-Planung:   Wenn   Dachneigung > 35°, dann …';
    mockCompile.mockResolvedValue({
      forms: [{ id: 'KFM-1' } as never, { id: 'KFM-2' } as never],
      rejectedCount: 1,
      intakeEventId: null,
    });

    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: verbatim }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      forms: unknown[];
      count: number;
      rejectedCount: number;
    };
    expect(json.count).toBe(2);
    expect(json.rejectedCount).toBe(1);

    expect(mockCompile).toHaveBeenCalledTimes(1);
    const args = mockCompile.mock.calls[0][0];
    expect(args.workspaceId).toBe('ws1');
    expect(args.rawText).toBe(verbatim); // N1: 1:1
    expect(args.intakeEventId).toBeUndefined();
    expect(typeof args.callEngine).toBe('function');
  });

  it('200 + intakeEventId durchgereicht', async () => {
    mockCompile.mockResolvedValue({
      forms: [],
      rejectedCount: 0,
      intakeEventId: 'INE-7',
    });
    const res = await POST(
      makeReq({ workspaceId: 'ws1', intakeEventId: 'INE-7' }),
    );
    expect(res.status).toBe(200);
    const args = mockCompile.mock.calls[0][0];
    expect(args.intakeEventId).toBe('INE-7');
    expect(args.rawText).toBeUndefined();
  });
});

describe('POST /api/lanes/compile — engine/fehler', () => {
  it('503 wenn keine Engine', async () => {
    mockPickEngine.mockReturnValue(null);
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(503);
  });

  it('404 wenn Compiler "not found" wirft', async () => {
    mockCompile.mockRejectedValue(
      new Error("intake_event 'INE-x' not found in workspace 'ws1'"),
    );
    const res = await POST(
      makeReq({ workspaceId: 'ws1', intakeEventId: 'INE-x' }),
    );
    expect(res.status).toBe(404);
  });

  it('400 bei sonstigem Compiler-Bedienfehler', async () => {
    mockCompile.mockRejectedValue(new Error('callEngine fn required'));
    const res = await POST(makeReq({ workspaceId: 'ws1', rawText: 'x' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('compile_failed');
  });
});
