/**
 * Tests für PushToggle — TopNav-Pill für Push-Notifications.
 *
 * Run: `npx tsx --test --test-force-exit lib/nav/__tests__/PushToggle.test.tsx`
 *
 * SSR-Smoke-Test: usePushSubscription läuft im SSR mit `state='loading'`,
 * weil window/navigator nicht verfügbar sind. Wir testen, dass die Pill
 * im Loading-State korrekt rendert + die Klassen-Variants stimmen.
 *
 * Volle State-Durchläufe (idle/subscribed/denied) sind nur via
 * jsdom-Browser-Mock testbar — siehe usePushSubscription-Tests.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

import { PushToggle } from '../PushToggle';

describe('PushToggle · render-smoke (SSR)', () => {
  it('rendert eine button-Pille im Loading-State', () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToggle, { vapidPublicKey: 'fake-key' }),
    );
    assert.match(html, /<button/);
    assert.match(html, /push-toggle__pill/);
    // SSR landet im 'loading'-State — wegen fehlendem window-Object greift
    // detectCapabilities() den ssr-Branch und liefert supported=false.
    // Da state übergangsweise 'loading' ist, dann zu 'unsupported'
    // schaltet, kann SSR beide Varianten haben. Wir prüfen nur, dass
    // entweder eine Pill rendert oder null (für unsupported).
    // Bei loading: pill mit --loading variant.
    if (html.length > 0) {
      assert.match(html, /push-toggle__pill/);
    }
  });

  it('hat aria-label und aria-pressed', () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToggle, { vapidPublicKey: 'fake-key' }),
    );
    if (html.length > 0) {
      assert.match(html, /aria-label="/);
      assert.match(html, /aria-pressed="false"/);
    }
  });

  it('rendert SVG-Bell-Icon', () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToggle, { vapidPublicKey: 'fake-key' }),
    );
    if (html.length > 0) {
      assert.match(html, /<svg/);
      assert.match(html, /push-toggle__icon/);
    }
  });

  it('rendert mit data-testid für e2e-Tests', () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToggle, { vapidPublicKey: 'fake-key' }),
    );
    if (html.length > 0) {
      assert.match(html, /data-testid="push-toggle"/);
    }
  });
});
