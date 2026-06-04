/**
 * Tests fuer Cluster D (Sub-Plan 3, 2026-05-01).
 *
 * Tool/Step-Konsolidierung: agent, swarm, live-swarm, bug-fix-swarm,
 * loop-phase, tier-choice werden zu einem `<surface:agent-step mode=...>`
 * gemerged. Mode-Diskriminator routet auf den vorhandenen Renderer.
 *
 * Plus: Sicherstellt dass canonicalKind alle Tool/Step-Kinds auf
 * agent-step mappt.
 */

import { describe, expect, it } from 'vitest';

import { canonicalKind } from '../replace-logic';
import { renderSurface } from '../SurfaceRenderer';

const WS_A = '01J0000000000000000000000A';

describe('Cluster D · agent-step-Renderer', () => {
  it('mode=agent rendert Teammate', () => {
    const out = renderSurface('agent-step', {
      mode: 'agent',
      role: 'senior-dev',
      status: 'laeuft',
    });
    expect(out).toBeTruthy();
  });

  it('mode=swarm rendert Heatmap', () => {
    const out = renderSurface('agent-step', {
      mode: 'swarm',
      title: 'Konsens',
      cells: [
        { variant: 'consensus' },
        { variant: 'median' },
        { variant: 'outlier' },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('mode=live-swarm rendert LiveSwarm', () => {
    const out = renderSurface('agent-step', {
      mode: 'live-swarm',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      tierMix: { opus: 2, sonnet: 1, haiku: 0 },
    });
    expect(out).toBeTruthy();
  });

  it('mode=bug-fix-swarm rendert BugFixSwarm', () => {
    const out = renderSurface('agent-step', {
      mode: 'bug-fix-swarm',
      swarmId: 'sw-1',
      workspaceId: 'ws-1',
      workstreamId: WS_A,
      masterTicketId: 'TCK-1',
      bugDescription: 'Form crashes on mobile',
    });
    expect(out).toBeTruthy();
  });

  it('mode=loop-phase rendert LoopPhase', () => {
    const out = renderSurface('agent-step', {
      mode: 'loop-phase',
      kind: 'auto-dispatch-stage',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      stage: 'senior-dev',
    });
    expect(out).toBeTruthy();
  });

  it('mode=tier-choice rendert TierChoice', () => {
    const out = renderSurface('agent-step', {
      mode: 'tier-choice',
      title: 'Wie tief?',
      workspaceId: 'ws-1',
      planTitle: 'Refactor X',
    });
    expect(out).toBeTruthy();
  });

  it('Sniffing: ohne mode wird BugFixSwarm anhand swarmId+bugDescription erkannt', () => {
    const out = renderSurface('agent-step', {
      swarmId: 'sw-2',
      workspaceId: 'ws-1',
      workstreamId: WS_A,
      masterTicketId: 'TCK-1',
      bugDescription: 'sniff',
    });
    expect(out).toBeTruthy();
  });

  it('Sniffing: ohne mode wird LiveSwarm anhand tierMix erkannt', () => {
    const out = renderSurface('agent-step', {
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      tierMix: { opus: 1, sonnet: 0, haiku: 0 },
    });
    expect(out).toBeTruthy();
  });

  it('Sniffing: ohne mode wird Agent anhand role erkannt', () => {
    const out = renderSurface('agent-step', {
      role: 'critic',
      status: 'idle',
    });
    expect(out).toBeTruthy();
  });

  it('komplett leer -> null', () => {
    const out = renderSurface('agent-step', {});
    expect(out).toBeNull();
  });
});

describe('Cluster D · Mapping', () => {
  it('alle Tool/Step-Kinds mappen auf agent-step', () => {
    const family = [
      'agent',
      'swarm',
      'live-swarm',
      'bug-fix-swarm',
      'loop-phase',
      'tier-choice',
    ] as const;
    for (const k of family) {
      expect(canonicalKind(k)).toBe('agent-step');
    }
  });
});
