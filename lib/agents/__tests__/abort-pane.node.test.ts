// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// node:test suite for lib/agents/fleet-registry abortPane / findFleetByPaneId.
// CP-2 / UX-Audit 2026-05-28 — verifies the in-process pane-abort path that
// the new POST /api/workstreams/[id]/subagent/[paneId]/abort route delegates
// to.

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  __resetFleetRegistry,
  __seedFleetPane,
  abortPane,
  findFleetByPaneId,
  getFleet,
} from '../fleet-registry';
import type { SubagentPane } from '@/lib/chat/SubagentFleetCard.types';

function seedRunningPane(fleetId: string, subagentId: string): SubagentPane {
  const pane: SubagentPane = {
    subagentId,
    role: 'coder',
    title: `coder — test ${subagentId}`,
    status: 'running',
    startedAt: Date.now(),
    tokensStreamed: 0,
  };
  __seedFleetPane(fleetId, pane, 'test-intent');
  return pane;
}

beforeEach(() => {
  __resetFleetRegistry();
});

afterEach(() => {
  __resetFleetRegistry();
});

describe('fleet-registry — findFleetByPaneId', () => {
  it('locates the parent fleet by paneId', () => {
    seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    seedRunningPane('fleet-b', 'sub-coder-bbbbbbbb');
    assert.equal(findFleetByPaneId('sub-coder-aaaaaaaa'), 'fleet-a');
    assert.equal(findFleetByPaneId('sub-coder-bbbbbbbb'), 'fleet-b');
  });

  it('returns null for unknown paneIds', () => {
    seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    assert.equal(findFleetByPaneId('sub-coder-ghost'), null);
  });
});

describe('fleet-registry — abortPane', () => {
  it('transitions a running pane to aborted + stamps endedAt', () => {
    const pane = seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    const result = abortPane('fleet-a', pane.subagentId);
    assert.ok(result);
    assert.equal(result.status, 'aborted');
    assert.equal(result.previousStatus, 'running');

    const snap = getFleet('fleet-a');
    assert.ok(snap);
    const updated = snap.panes.find((p) => p.subagentId === pane.subagentId);
    assert.ok(updated);
    assert.equal(updated.status, 'aborted');
    assert.ok(typeof updated.endedAt === 'number' && updated.endedAt > 0);
  });

  it('is idempotent — second abort on aborted pane is unchanged', () => {
    const pane = seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    const first = abortPane('fleet-a', pane.subagentId);
    assert.equal(first?.status, 'aborted');
    const second = abortPane('fleet-a', pane.subagentId);
    assert.equal(second?.status, 'unchanged');
    assert.equal(second?.previousStatus, 'aborted');
  });

  it('does not overwrite a terminal `done` pane', () => {
    const pane: SubagentPane = {
      subagentId: 'sub-coder-aaaaaaaa',
      role: 'coder',
      title: 'coder — finished',
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    __seedFleetPane('fleet-a', pane);
    const result = abortPane('fleet-a', pane.subagentId);
    assert.equal(result?.status, 'unchanged');
    assert.equal(result?.previousStatus, 'done');
    const snap = getFleet('fleet-a');
    assert.equal(snap?.panes[0]?.status, 'done');
  });

  it('returns null for unknown fleetId', () => {
    assert.equal(abortPane('fleet-ghost', 'sub-coder-aaaaaaaa'), null);
  });

  it('returns null for unknown paneId in known fleet', () => {
    seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    assert.equal(abortPane('fleet-a', 'sub-coder-ghost'), null);
  });
});

describe('fleet-registry — abortPane only touches the targeted pane', () => {
  it('leaves siblings untouched', () => {
    seedRunningPane('fleet-a', 'sub-coder-aaaaaaaa');
    seedRunningPane('fleet-a', 'sub-tester-bbbbbbbb');
    const result = abortPane('fleet-a', 'sub-coder-aaaaaaaa');
    assert.equal(result?.status, 'aborted');
    const snap = getFleet('fleet-a');
    const coder = snap?.panes.find((p) => p.subagentId === 'sub-coder-aaaaaaaa');
    const tester = snap?.panes.find((p) => p.subagentId === 'sub-tester-bbbbbbbb');
    assert.equal(coder?.status, 'aborted');
    assert.equal(tester?.status, 'running');
  });
});
