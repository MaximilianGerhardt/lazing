/**
 * Stream X1 (2026-05-28) — flow-coupling SOP + cost-hint extension tests.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/flow-coupling-onboarding-sop.test.tsx
 *
 * Coverage:
 *   1. Higgsfield provider → on tap "Koppeln", the SOP-Pane (signup/key/budget/
 *      credential steps) renders WITH a cost-hint line and the embedded
 *      CredentialRequestCard (type=password input).
 *   2. imagegen2 (engine-backed) → SOP renders WITHOUT an embedded credential
 *      input (no type=password), but with the info + budget steps.
 *   3. Unknown provider → backwards-compatible: original CredentialRequestCard
 *      pathway renders (no SOP wrapper, no cost hint with unknown:false).
 *   4. SECURITY: rendered DOM contains no plaintext secret + no 'sk_' / 'hf_'
 *      pre-filled values.
 *   5. Cost hint surfaces "unbekannt" (not 0) for unknown capability.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  root: Root;
  container: HTMLElement;
  pushed: string[];
  unmount: () => void;
}

function mount(data: unknown): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const pushed: string[] = [];
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={(c) => pushed.push(c)}
      >
        {renderSurface('flow-coupling', data)}
      </SurfaceActionProvider>,
    );
  });
  return {
    root,
    container,
    pushed,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function q<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  sel: string,
): T | null {
  return c.querySelector<T>(sel);
}
function qa<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  sel: string,
): T[] {
  return Array.from(c.querySelectorAll<T>(sel));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('flow-coupling → SOP-aware Coupling Pane (Stream X1)', () => {
  it('higgsfield provider: SOP renders 4 steps + cost hint + embedded credential card', () => {
    const h = mount({
      flowId: 'flow-x1',
      workspaceId: 'ws-x1',
      missingTools: [
        {
          stepId: 's1',
          stepTitle: 'Motion-Clip rendern',
          provider: 'higgsfield',
          neededCapabilities: ['video.motion'],
          reason: 'credential',
        },
      ],
    });
    try {
      // Open the coupling pane.
      const btn = q(h.container, '[data-test="flow-couple-btn"]');
      expect(btn).not.toBeNull();
      act(() => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // SOP pane appears with provider attribute.
      const sop = q(h.container, '[data-test="flow-onboarding-sop"]');
      expect(sop).not.toBeNull();
      expect(sop?.getAttribute('data-provider')).toBe('higgsfield');
      expect(sop?.getAttribute('data-engine-backed')).toBe('false');

      // 4 steps (signup, key, budget, credential).
      const steps = qa(h.container, '[data-test="flow-onboarding-step"]');
      expect(steps).toHaveLength(4);
      const kinds = steps.map((s) => s.getAttribute('data-step-kind'));
      expect(kinds).toEqual(['signup', 'key', 'budget', 'credential']);

      // Cost hint visible (known capability + provider).
      const cost = q(h.container, '[data-test="flow-coupling-cost-hint"]');
      expect(cost).not.toBeNull();
      expect(cost?.getAttribute('data-unknown')).toBe('false');
      const costText = cost?.textContent ?? '';
      expect(costText).toMatch(/Geschätzte Kosten/);
      expect(costText).toContain('Hinweis, kein Cap');

      // Embedded credential card with password input (Secret pathway preserved).
      const pw = q<HTMLInputElement>(h.container, 'input[type="password"]');
      expect(pw).not.toBeNull();
      expect(pw?.value ?? '').toBe(''); // SECURITY: never pre-filled.

      // External signup link is present and points to the provider.
      const links = qa<HTMLAnchorElement>(
        h.container,
        '[data-test="flow-onboarding-step-link"]',
      );
      expect(links.length).toBeGreaterThan(0);
      expect(links[0].getAttribute('href')).toBe('https://higgsfield.ai');
    } finally {
      h.unmount();
    }
  });

  it('imagegen2 (engine-backed): SOP renders info + budget, NO credential input', () => {
    const h = mount({
      flowId: 'flow-x2',
      workspaceId: 'ws-x2',
      missingTools: [
        {
          stepId: 's2',
          stepTitle: 'Hero-Bild generieren',
          provider: 'imagegen2',
          neededCapabilities: ['image.generate'],
          reason: 'profile',
        },
      ],
    });
    try {
      const btn = q(h.container, '[data-test="flow-couple-btn"]');
      act(() => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const sop = q(h.container, '[data-test="flow-onboarding-sop"]');
      expect(sop).not.toBeNull();
      expect(sop?.getAttribute('data-engine-backed')).toBe('true');

      // No credential-step kind for engine-backed; expect 'info' + 'budget'.
      const steps = qa(h.container, '[data-test="flow-onboarding-step"]');
      const kinds = steps.map((s) => s.getAttribute('data-step-kind'));
      expect(kinds).toContain('info');
      expect(kinds).toContain('budget');
      expect(kinds).not.toContain('credential');

      // No embedded password input — engine-backed.
      expect(q(h.container, 'input[type="password"]')).toBeNull();

      // Cost hint still visible (engine-backed range 0..0.05 €).
      const cost = q(h.container, '[data-test="flow-coupling-cost-hint"]');
      expect(cost).not.toBeNull();
      expect(cost?.getAttribute('data-unknown')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('unknown provider: backwards-compatible — original credential card, NO SOP wrapper', () => {
    const h = mount({
      flowId: 'flow-x3',
      workspaceId: 'ws-x3',
      missingTools: [
        {
          stepId: 's3',
          stepTitle: 'CRM-Termin anlegen',
          provider: 'salesforce',
          neededCapabilities: ['calendar.create'],
          reason: 'credential',
        },
      ],
    });
    try {
      const btn = q(h.container, '[data-test="flow-couple-btn"]');
      act(() => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // No SOP wrapper for unknown providers.
      expect(q(h.container, '[data-test="flow-onboarding-sop"]')).toBeNull();
      // But the original credential card still renders.
      expect(q(h.container, '[data-test="flow-couple-credential"]')).not.toBeNull();
      expect(q<HTMLInputElement>(h.container, 'input[type="password"]')).not.toBeNull();

      // Cost hint shows "unbekannt" since salesforce has no pricing entry.
      const cost = q(h.container, '[data-test="flow-coupling-cost-hint"]');
      expect(cost).not.toBeNull();
      expect(cost?.getAttribute('data-unknown')).toBe('true');
      expect(cost?.textContent ?? '').toContain('unbekannt');
    } finally {
      h.unmount();
    }
  });

  it('SECURITY: rendered DOM contains no plaintext key / pre-filled secret', () => {
    const h = mount({
      flowId: 'flow-x4',
      workspaceId: 'ws-x4',
      missingTools: [
        {
          stepId: 's4',
          stepTitle: 'Avatar-Erklärfilm',
          provider: 'heygen-avatar',
          neededCapabilities: ['video.avatar'],
          reason: 'credential',
        },
      ],
    });
    try {
      const btn = q(h.container, '[data-test="flow-couple-btn"]');
      act(() => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const text = h.container.textContent ?? '';
      // None of the obvious leak shapes show up.
      expect(text).not.toMatch(/sk_live_/);
      expect(text).not.toMatch(/sk_test_/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
      expect(text).not.toMatch(/hf_[A-Za-z0-9]{16,}/);
      // The password input must be empty.
      const pw = q<HTMLInputElement>(h.container, 'input[type="password"]');
      expect(pw?.value ?? '').toBe('');
    } finally {
      h.unmount();
    }
  });
});
