/**
 * CredentialRequestCard Tests · mobile + OAuth pass (2026-05-30).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/CredentialRequestCard.test.tsx
 *
 * Cases:
 *   1. authKind='apikey' → password-Input + Speichern-Button.
 *   2. authKind='oauth' (Backend pending) → OAuth-Start-Button + ehrlicher
 *      „pending"-Hinweis; Klick schaltet auf manuellen Token-Fallback (Input).
 *   3. authKind='none' (engine-backed) → KEIN Input, nur Info-Hinweis.
 *   4. capability / signupUrl / credentialFieldHint werden gerendert.
 *   5. SECURITY: secret-Input ist type="password".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CredentialRequestCard, type CredentialRequestCardProps } from '../CredentialRequestCard';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(props: Partial<CredentialRequestCardProps> = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CredentialRequestCard
        provider={props.provider ?? 'heygen-avatar'}
        workspaceId={props.workspaceId ?? 'ws-test'}
        {...props}
      />,
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

function q<T extends HTMLElement = HTMLElement>(c: HTMLElement, sel: string): T | null {
  return c.querySelector<T>(sel);
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('CredentialRequestCard', () => {
  it('(1) apikey → password-Input + Speichern-Button', () => {
    const h = mount({ authKind: 'apikey' });
    const input = q<HTMLInputElement>(h.container, 'input[type="password"]');
    expect(input).not.toBeNull();
    const card = q(h.container, '[data-authkind="apikey"]');
    expect(card).not.toBeNull();
    expect(h.container.textContent).toContain('Speichern');
    h.unmount();
  });

  it('(2) oauth (Backend pending) → OAuth-Button + pending-Hinweis; Klick → Token-Fallback', () => {
    const h = mount({ authKind: 'oauth' });
    const btn = q<HTMLButtonElement>(h.container, '[data-test="oauth-start-btn"]');
    expect(btn).not.toBeNull();
    // Ehrlicher pending-Hinweis (kein Fake-Redirect).
    expect(q(h.container, '[data-test="oauth-pending"]')).not.toBeNull();
    // Vor Klick: kein password-Input.
    expect(q(h.container, 'input[type="password"]')).toBeNull();

    // Klick → manueller Token-Fallback erscheint (password-Input).
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(h.container, 'input[type="password"]')).not.toBeNull();
    expect(q(h.container, '[data-authkind="oauth-manual"]')).not.toBeNull();
    h.unmount();
  });

  it('(3) none (engine-backed) → KEIN Input, nur Info', () => {
    const h = mount({ authKind: 'none', engineBacked: true });
    expect(q(h.container, 'input')).toBeNull();
    expect(q(h.container, '[data-authkind="none"]')).not.toBeNull();
    expect(h.container.textContent?.toUpperCase()).toContain('ENGINE-BACKED');
    h.unmount();
  });

  it('(4) capability + signupUrl + credentialFieldHint werden gerendert', () => {
    const h = mount({
      authKind: 'apikey',
      capability: 'video.avatar',
      signupUrl: 'https://app.heygen.com/login',
      credentialFieldHint: 'Füge deinen HeyGen-API-Key ein.',
    });
    const txt = h.container.textContent ?? '';
    expect(txt).toContain('video.avatar');
    expect(txt).toContain('Füge deinen HeyGen-API-Key ein.');
    const link = q<HTMLAnchorElement>(h.container, 'a.srf-cred__link');
    expect(link?.getAttribute('href')).toBe('https://app.heygen.com/login');
    h.unmount();
  });

  it('(5) SECURITY: secret-Input ist type=password + autoComplete=new-password', () => {
    const h = mount({ authKind: 'apikey' });
    const input = q<HTMLInputElement>(h.container, 'input[type="password"]');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('autocomplete')).toBe('new-password');
    h.unmount();
  });
});
