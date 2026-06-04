/**
 * WorkspaceSwitcher / OrgSwitcher — Volles Label statt 3-Buchstaben-Stummel
 * (Apple-UX Slice 1, 2026-05-30).
 *
 * Owner-Schmerz: mobil gequetschte „WOR/MY"-Stummel. Fix: der `.slice(0,3)`
 * im Trigger ist gelöscht; gerendert wird das VOLLE Label (CSS trägt die
 * Ellipsis). Apple-HIG: Hierarchie statt Abkürzung.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/nav/__tests__/switcher-full-label.test.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const FULL_WS_LABEL = 'Workspace Marketing Nord';
const FULL_ORG_NAME = 'My Agency GmbH';

vi.mock('../hooks', () => ({
  ORG_ALL_ID: '__all__',
  useWorkspaces: () => ({ workspaces: [], isLoading: false }),
  useCurrentWorkspace: () => ({
    id: 'ws-1',
    label: FULL_WS_LABEL,
    accent: 'north',
  }),
  useSetWorkspace: () => () => undefined,
  useUserOrgs: () => ({
    orgs: [{ id: 'org-acme-1', name: FULL_ORG_NAME, paletteIndex: 2 }],
    isLoading: false,
  }),
  useCurrentOrgId: () => 'org-acme-1',
  useSetOrg: () => () => undefined,
}));

// eslint-disable-next-line import/first
import { WorkspaceSwitcher } from '../WorkspaceSwitcher';
// eslint-disable-next-line import/first
import { OrgSwitcher } from '../OrgSwitcher';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(node: React.ReactElement): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkspaceSwitcher — full label (Slice 1)', () => {
  it('rendert das VOLLE Workspace-Label, keinen 3-Buchstaben-Stummel', () => {
    const h = mount(<WorkspaceSwitcher />);
    try {
      const label = h.container.querySelector('.topnav-ws-trigger-label');
      expect(label?.textContent).toBe(FULL_WS_LABEL);
      // Der alte Stummel-Span existiert nicht mehr im Markup.
      expect(
        h.container.querySelector('.topnav-ws-trigger-short'),
      ).toBeNull();
      // Kein „WOR"-Slice irgendwo als Element-Text.
      const slug = FULL_WS_LABEL.slice(0, 3).toUpperCase();
      const hasSlugStub = Array.from(h.container.querySelectorAll('*')).some(
        (el) => el.children.length === 0 && el.textContent === slug,
      );
      expect(hasSlugStub).toBe(false);
    } finally {
      h.unmount();
    }
  });
});

describe('OrgSwitcher — full label (Slice 1)', () => {
  it('rendert den VOLLEN Org-Namen, keinen 3-Buchstaben-Slug', () => {
    const h = mount(<OrgSwitcher />);
    try {
      const label = h.container.querySelector('.topnav-org-trigger-label');
      expect(label?.textContent).toBe(FULL_ORG_NAME);
      expect(
        h.container.querySelector('.topnav-org-trigger-short'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
