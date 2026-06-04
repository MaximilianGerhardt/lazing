/**
 * NewWorkspaceForm Tests · 2026-05-03.
 *
 * Run: pnpm exec vitest run lib/nav/__tests__/NewWorkspaceForm.test.tsx
 *
 * Cases (5):
 *   1. submit-disabled wenn Label < 2 Zeichen
 *   2. Type-Pill-Auswahl ändert aria-checked
 *   3. Erfolgreiches Anlegen → onSuccess + dispatchWorkspaceDataChange-Event
 *   4. POST 409 → Inline-Error sichtbar, Form bleibt offen, kein onSuccess
 *   5. Cancel-Button + ESC ruft onCancel
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NewWorkspaceForm } from '../NewWorkspaceForm';
import { WORKSPACE_DATA_CHANGE_EVENT } from '../hooks';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(props: {
  defaultOrgId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSuccess?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCancel?: any;
} = {}): Harness & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSuccess: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCancel: any;
} {
  const onSuccess = props.onSuccess ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NewWorkspaceForm
        defaultOrgId={props.defaultOrgId ?? 'demo-pv'}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />,
    );
  });
  return {
    root,
    container,
    onSuccess,
    onCancel,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function findByTestId<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  id: string,
): T {
  const el = c.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`testid ${id} not found`);
  return el;
}

/**
 * React listens on the native `value`-setter to detect controlled-input
 * changes. Setting `el.value = "x"` directly bypasses that; we have to
 * call the prototype setter so React's synthetic-event system fires.
 */
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

describe('NewWorkspaceForm', () => {
  it('disables submit until label has ≥ 2 chars', () => {
    const h = mount();
    try {
      const submit = findByTestId<HTMLButtonElement>(h.container, 'new-ws-submit');
      expect(submit.disabled).toBe(true);

      const label = findByTestId<HTMLInputElement>(h.container, 'new-ws-label');
      act(() => {
        typeInto(label, 'A');
      });
      // Even with 1 char (< MIN=2) submit must remain disabled.
      expect(submit.disabled).toBe(true);

      act(() => {
        typeInto(label, 'AB');
      });
      expect(submit.disabled).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('toggles aria-checked when picking a type pill', () => {
    const h = mount();
    try {
      const defaultPill = findByTestId<HTMLButtonElement>(
        h.container,
        'new-ws-type-default',
      );
      const productPill = findByTestId<HTMLButtonElement>(
        h.container,
        'new-ws-type-product',
      );
      // Default is „default" → aria-checked=true.
      expect(defaultPill.getAttribute('aria-checked')).toBe('true');
      expect(productPill.getAttribute('aria-checked')).toBe('false');

      act(() => {
        productPill.click();
      });

      expect(productPill.getAttribute('aria-checked')).toBe('true');
      expect(defaultPill.getAttribute('aria-checked')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('submits successfully → fires onSuccess + dispatches workspace-data-change', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          workspace: {
            id: 'demo-fitness-backend',
            label: body.label,
            organizationId: body.organizationId,
            workspaceType: body.workspaceType,
            contextGroup: body.contextGroup ?? null,
            sensitivity: body.sensitivity,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const eventListener = vi.fn();
    window.addEventListener(WORKSPACE_DATA_CHANGE_EVENT, eventListener);

    const onSuccess = vi.fn();
    const h = mount({ onSuccess });

    try {
      const label = findByTestId<HTMLInputElement>(h.container, 'new-ws-label');
      const ctx = findByTestId<HTMLInputElement>(h.container, 'new-ws-context');
      const submit = findByTestId<HTMLButtonElement>(h.container, 'new-ws-submit');

      act(() => {
        typeInto(label, 'Demo Fitness Backend');
        typeInto(ctx, 'CRM');
      });
      await act(async () => {
        submit.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(((callArgs[1] as RequestInit).body as string) ?? '{}');
      expect(sentBody).toMatchObject({
        label: 'Demo Fitness Backend',
        organizationId: 'demo-pv',
        workspaceType: 'default',
        contextGroup: 'CRM',
        sensitivity: 'low',
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess.mock.calls[0][0]).toMatchObject({
        id: 'demo-fitness-backend',
        contextGroup: 'CRM',
      });
      expect(eventListener).toHaveBeenCalled();
    } finally {
      window.removeEventListener(WORKSPACE_DATA_CHANGE_EVENT, eventListener);
      h.unmount();
    }
  });

  it('shows inline error on 409 conflict and keeps form open', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'id-taken', message: 'ID existiert bereits' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const onSuccess = vi.fn();
    const h = mount({ onSuccess });

    try {
      const label = findByTestId<HTMLInputElement>(h.container, 'new-ws-label');
      const submit = findByTestId<HTMLButtonElement>(h.container, 'new-ws-submit');
      act(() => {
        typeInto(label, 'Conflict Workspace');
      });
      await act(async () => {
        submit.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const err = h.container.querySelector<HTMLElement>('[data-testid="new-ws-error"]');
      expect(err).not.toBeNull();
      expect(err?.textContent ?? '').toContain('existiert bereits');
      expect(onSuccess).not.toHaveBeenCalled();
      // Form bleibt sichtbar — Submit-Button wieder enabled.
      expect(submit.disabled).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('calls onCancel on Cancel-button + on ESC keypress', () => {
    const onCancel = vi.fn();
    const h = mount({ onCancel });
    try {
      const cancelBtn = h.container.querySelector<HTMLButtonElement>(
        '.new-ws-form__btn--ghost',
      );
      expect(cancelBtn).not.toBeNull();
      act(() => {
        cancelBtn?.click();
      });
      expect(onCancel).toHaveBeenCalledTimes(1);

      // ESC keypress fires onCancel as well (form-level shortcut).
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onCancel).toHaveBeenCalledTimes(2);
    } finally {
      h.unmount();
    }
  });
});
