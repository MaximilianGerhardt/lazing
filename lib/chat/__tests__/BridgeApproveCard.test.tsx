/**
 * BridgeApproveCard Tests · 2026-05-26 (Workspace-Isolations-Modell, FS-5).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/BridgeApproveCard.test.tsx
 *
 * Cases:
 *   1. Der verbatim-Grund wird WORTGETREU gerendert (N1, nicht paraphrasiert).
 *   2. Ziel-Pfad + Workspace + access werden gezeigt.
 *   3. Approve feuert onApprove (genau einmal).
 *   4. Deny feuert onDeny (genau einmal).
 *   5. Nach einer Entscheidung sind beide Aktionen gesperrt (kein Doppel-Tap).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BridgeApproveCard } from '../BridgeApproveCard';

const REASON =
  'Schritt »Logo generieren« möchte ~/other-project lesen';

interface Harness {
  root: Root;
  container: HTMLElement;
  onApprove: ReturnType<typeof vi.fn>;
  onDeny: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function mount(
  overrides: Partial<{
    reason: string;
    fromWorkspaceId: string;
    targetPath: string;
    access: 'ro' | 'rw';
  }> = {},
): Harness {
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BridgeApproveCard
        reason={overrides.reason ?? REASON}
        fromWorkspaceId={overrides.fromWorkspaceId ?? 'demo-pv'}
        targetPath={overrides.targetPath ?? '~/other-project'}
        access={overrides.access ?? 'ro'}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
  });
  return {
    root,
    container,
    onApprove,
    onDeny,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function byTest<T extends HTMLElement = HTMLElement>(c: HTMLElement, id: string): T {
  const el = c.querySelector<T>(`[data-test="${id}"]`);
  if (!el) throw new Error(`data-test ${id} not found`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('BridgeApproveCard', () => {
  it('renders the verbatim reason word-for-word (N1)', () => {
    const h = mount();
    try {
      const reason = byTest(h.container, 'bridge-reason');
      // EXAKTER Text, keine Paraphrase, keine Kürzung.
      expect(reason.textContent).toBe(REASON);
    } finally {
      h.unmount();
    }
  });

  it('shows the target path, workspace and access right', () => {
    const h = mount({ access: 'rw' });
    try {
      expect(byTest(h.container, 'bridge-from').textContent).toContain(
        'demo-pv',
      );
      expect(byTest(h.container, 'bridge-target').textContent).toContain(
        '~/other-project',
      );
      expect(byTest(h.container, 'bridge-access').textContent).toContain(
        'Lesen & Schreiben',
      );
    } finally {
      h.unmount();
    }
  });

  it('fires onApprove exactly once when Erlauben is tapped', () => {
    const h = mount();
    try {
      const approve = byTest<HTMLButtonElement>(h.container, 'bridge-approve');
      act(() => {
        approve.click();
      });
      expect(h.onApprove).toHaveBeenCalledTimes(1);
      expect(h.onDeny).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('fires onDeny exactly once when Ablehnen is tapped', () => {
    const h = mount();
    try {
      const deny = byTest<HTMLButtonElement>(h.container, 'bridge-deny');
      act(() => {
        deny.click();
      });
      expect(h.onDeny).toHaveBeenCalledTimes(1);
      expect(h.onApprove).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('locks both actions after the first decision (no double-tap)', () => {
    const h = mount();
    try {
      const approve = byTest<HTMLButtonElement>(h.container, 'bridge-approve');
      const deny = byTest<HTMLButtonElement>(h.container, 'bridge-deny');
      act(() => {
        approve.click();
        approve.click();
        deny.click();
      });
      expect(h.onApprove).toHaveBeenCalledTimes(1);
      expect(h.onDeny).not.toHaveBeenCalled();
      // Buttons sind disabled.
      expect(approve.disabled).toBe(true);
      expect(deny.disabled).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
