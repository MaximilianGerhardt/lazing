/**
 * lib/agents/__tests__/profiles-service.test.ts — Mitarbeiter-Profile Slice 1.
 *
 * Echte db/client (Migration 0129) auf temporärer DB. LAZYOS_DB_PATH muss VOR
 * dem ersten db/client-Import gesetzt sein → dynamische Imports.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'agp-test-'));
process.env.LAZYOS_DB_PATH = path.join(dir, 'test.db');
process.env.LAZYOS_TEST_DISABLE_FK = '1';

const {
  createAgentProfile,
  listAgentProfiles,
  getAgentProfile,
  archiveAgentProfile,
  resolveProfileAllowlist,
  AgentProfileError,
} = await import('@/lib/agents/profiles-service');

describe('profiles-service', () => {
  it('legt ein Profil mit Rolle + Capability-Bundle an und liest es zurück', () => {
    const p = createAgentProfile({
      name: 'Kunden-Report-Mitarbeiter Nord',
      description: 'Monatliche Reports (xlsx + pdf + Brand)',
      role: 'scribe',
      skills: ['xlsx', 'pdf', 'brand-guidelines'],
      mcpServers: ['github'],
      sops: ['lazing-policy-checker'],
      workspaceId: 'ws-nord',
      createdBy: 'u1',
    });
    expect(p.id).toMatch(/^AGP-/);
    expect(p.name).toBe('Kunden-Report-Mitarbeiter Nord');
    expect(p.role).toBe('scribe');
    expect(p.skills).toEqual(['xlsx', 'pdf', 'brand-guidelines']);
    expect(p.sops).toEqual(['lazing-policy-checker']);

    const back = getAgentProfile(p.id)!;
    expect(back.skills).toEqual(['xlsx', 'pdf', 'brand-guidelines']);
    expect(back.mcpServers).toEqual(['github']);
  });

  it('lehnt eine unbekannte Rolle ab (N6-Validierung)', () => {
    expect(() =>
      createAgentProfile({ name: 'X', role: 'ceo' }),
    ).toThrow(AgentProfileError);
  });

  it('lehnt leeren Namen ab (N1)', () => {
    expect(() => createAgentProfile({ name: '   ', role: 'coder' })).toThrow(AgentProfileError);
  });

  it('Workspace-Liste enthält eigene + globale (workspace_id NULL) Profile', () => {
    createAgentProfile({ name: 'WS-spezifisch', role: 'coder', workspaceId: 'ws-A' });
    createAgentProfile({ name: 'Global', role: 'researcher', workspaceId: null });
    createAgentProfile({ name: 'Anderer WS', role: 'coder', workspaceId: 'ws-B' });
    const names = listAgentProfiles({ workspaceId: 'ws-A' }).map((p) => p.name);
    expect(names).toContain('WS-spezifisch');
    expect(names).toContain('Global');
    expect(names).not.toContain('Anderer WS');
  });

  it('archiviert (Soft-Delete) → fällt aus der aktiven Liste', () => {
    const p = createAgentProfile({ name: 'Temp', role: 'tester', workspaceId: 'ws-arch' });
    expect(listAgentProfiles({ workspaceId: 'ws-arch' }).some((x) => x.id === p.id)).toBe(true);
    expect(archiveAgentProfile(p.id)).toBe(true);
    expect(listAgentProfiles({ workspaceId: 'ws-arch' }).some((x) => x.id === p.id)).toBe(false);
  });

  it('resolveProfileAllowlist: Profil-Skills gewinnen; leer → Rollen-Defaults', () => {
    const withSkills = createAgentProfile({
      name: 'mit',
      role: 'researcher',
      skills: ['xlsx', 'pdf'],
      workspaceId: 'ws-r',
    });
    expect(resolveProfileAllowlist(withSkills)).toEqual(['xlsx', 'pdf']);

    const nakedRow = createAgentProfile({ name: 'nackt', role: 'researcher', workspaceId: 'ws-r' });
    // Rollen-Default (ROLE_SKILL_MAP.researcher) enthält u.a. 'web-search'.
    expect(resolveProfileAllowlist(nakedRow)).toContain('web-search');
  });
});
