/**
 * WorkspaceFoldersEditor Tests · 2026-05-26 (Workspace-Isolations-Modell, FS-1).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/workspaces/__tests__/WorkspaceFoldersEditor.test.tsx
 *
 * Cases:
 *   1. Render: zeigt Headline + initiale Roots (Pfad sichtbar).
 *   2. Primary-Root: trägt „primär"-Badge UND hat KEINEN Remove-Button.
 *   3. Add-Pfad: gültiger absoluter Pfad → POST gegen fs-roots, neue Row erscheint.
 *   4. Add-Pfad invalide (kein „/") → Fehler, KEIN POST.
 *   5. ro/rw-Toggle: optimistic Wechsel + POST mit neuem access.
 *   6. Remove (nicht-primary): optimistic-Entfernung + DELETE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { WorkspaceFoldersEditor, type FsRoot } from '../WorkspaceFoldersEditor';

const WS = 'demo-pv';

function makeRoot(partial: Partial<FsRoot> & { id: string; absPath: string }): FsRoot {
  return {
    workspaceId: WS,
    role: 'repo',
    access: 'rw',
    isGit: true,
    githubRepoId: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

const PRIMARY = makeRoot({
  id: 'r1',
  absPath: '/tmp/lazyos-test/demo-pv-crm',
  role: 'primary',
});
const SECOND = makeRoot({
  id: 'r2',
  absPath: '/tmp/lazyos-test/demo-pv-web',
  role: 'repo',
  access: 'rw',
});

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(initialRoots: FsRoot[]): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <WorkspaceFoldersEditor workspaceId={WS} initialRoots={initialRoots} />,
    );
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

function byTest<T extends HTMLElement = HTMLElement>(c: HTMLElement, id: string): T {
  const el = c.querySelector<T>(`[data-test="${id}"]`);
  if (!el) throw new Error(`data-test ${id} not found`);
  return el;
}

function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('WorkspaceFoldersEditor', () => {
  it('renders the user-facing headline + initial roots', () => {
    const h = mount([PRIMARY, SECOND]);
    try {
      expect(h.container.textContent ?? '').toContain(
        'Welche Ordner gehören zu diesem Projekt?',
      );
      // NICHT „Sandbox" o.ä. — bleibt unsichtbar.
      expect((h.container.textContent ?? '').toLowerCase()).not.toContain('sandbox');
      expect(h.container.textContent ?? '').toContain('/tmp/lazyos-test/demo-pv-crm');
      expect(h.container.textContent ?? '').toContain('/tmp/lazyos-test/demo-pv-web');
    } finally {
      h.unmount();
    }
  });

  it('marks the primary root with a badge and hides its remove button', () => {
    const h = mount([PRIMARY, SECOND]);
    try {
      // Primary-Badge existiert.
      const badge = byTest(h.container, 'ws-folder-primary-badge');
      expect(badge.textContent).toContain('primär');
      // Primary hat KEINEN Remove-Button …
      expect(
        h.container.querySelector('[data-test="ws-folder-remove-r1"]'),
      ).toBeNull();
      // … aber der Second-Root schon.
      expect(
        h.container.querySelector('[data-test="ws-folder-remove-r2"]'),
      ).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('POSTs a valid absolute path and appends the new root', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          root: makeRoot({ id: 'r3', absPath: body.absPath, access: body.access }),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount([PRIMARY]);
    try {
      const input = byTest<HTMLInputElement>(h.container, 'ws-folder-input');
      const add = byTest<HTMLButtonElement>(h.container, 'ws-folder-add');

      act(() => {
        typeInto(input, '/tmp/lazyos-test/demo-pv-docs');
      });
      await act(async () => {
        add.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain(`/api/workspaces/${WS}/fs-roots`);
      expect((init as RequestInit).method).toBe('POST');
      const sent = JSON.parse(((init as RequestInit).body as string) ?? '{}');
      expect(sent).toMatchObject({ absPath: '/tmp/lazyos-test/demo-pv-docs', access: 'rw' });

      // Neue Row erscheint im DOM.
      expect(h.container.textContent ?? '').toContain('/tmp/lazyos-test/demo-pv-docs');
    } finally {
      h.unmount();
    }
  });

  it('rejects a non-absolute path without any POST', async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );
    const h = mount([PRIMARY]);
    try {
      const input = byTest<HTMLInputElement>(h.container, 'ws-folder-input');
      const add = byTest<HTMLButtonElement>(h.container, 'ws-folder-add');
      act(() => {
        typeInto(input, 'relative/path');
      });
      await act(async () => {
        add.click();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const err = byTest(h.container, 'ws-folders-error');
      expect(err.textContent ?? '').toContain('absoluten Pfad');
    } finally {
      h.unmount();
    }
  });

  it('toggles ro/rw optimistically and POSTs the new access', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ root: SECOND }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount([PRIMARY, SECOND]);
    try {
      const toggle = byTest<HTMLButtonElement>(h.container, 'ws-folder-access-r2');
      expect(toggle.getAttribute('data-access')).toBe('rw');
      expect(toggle.textContent).toContain('Schreiben');

      await act(async () => {
        toggle.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // Optimistic: UI zeigt jetzt 'ro'.
      const toggleAfter = byTest<HTMLButtonElement>(h.container, 'ws-folder-access-r2');
      expect(toggleAfter.getAttribute('data-access')).toBe('ro');
      expect(toggleAfter.textContent).toContain('Nur lesen');

      // POST mit access:'ro' gefeuert.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(
        ((fetchMock.mock.calls[0][1] as RequestInit).body as string) ?? '{}',
      );
      expect(sent).toMatchObject({ absPath: SECOND.absPath, access: 'ro' });
    } finally {
      h.unmount();
    }
  });

  it('removes a non-primary root optimistically and DELETEs it', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount([PRIMARY, SECOND]);
    try {
      const remove = byTest<HTMLButtonElement>(h.container, 'ws-folder-remove-r2');
      await act(async () => {
        remove.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // Row weg.
      expect(
        h.container.querySelector('[data-test="ws-folder-row-r2"]'),
      ).toBeNull();
      // DELETE gefeuert.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain(`/api/workspaces/${WS}/fs-roots/r2`);
      expect((init as RequestInit).method).toBe('DELETE');
    } finally {
      h.unmount();
    }
  });
});
