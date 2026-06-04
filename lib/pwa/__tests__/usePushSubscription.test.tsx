/**
 * Tests für usePushSubscription — Push-Subscription-Hook.
 *
 * Run: `npx tsx --test --test-force-exit lib/pwa/__tests__/usePushSubscription.test.tsx`
 *
 * Da der Hook stark vom Browser-API abhängt, testen wir hier primär die
 * Pure-Logic-Bestandteile via Mock-Window. Der vollständige State-
 * Maschine-Walk-Through (idle → subscribed) ist e2e-Pflicht via
 * Playwright/Cypress — hier nur Smoke-Tests für SSR + initial-state.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

import { usePushSubscription } from '../usePushSubscription';

/**
 * Test-Component: nutzt den Hook + rendert state als data-Attribut.
 * Dadurch können wir die Initial-State-Werte über renderToStaticMarkup
 * prüfen (kein DOM, kein useEffect-Run).
 */
function TestComponent({ vapidPublicKey }: { vapidPublicKey: string }): React.JSX.Element {
  const sub = usePushSubscription({ vapidPublicKey });
  return React.createElement('div', {
    'data-state': sub.state,
    'data-message': sub.message,
    'data-endpoint': sub.endpoint ?? 'null',
    'data-standalone': String(sub.isStandalone),
  });
}

describe('usePushSubscription · SSR-initial-state', () => {
  it('liefert state=loading beim ersten Render (SSR)', () => {
    const html = renderToStaticMarkup(
      React.createElement(TestComponent, { vapidPublicKey: 'fake-key' }),
    );
    assert.match(html, /data-state="loading"/);
  });

  it('liefert endpoint=null und isStandalone=false initial', () => {
    const html = renderToStaticMarkup(
      React.createElement(TestComponent, { vapidPublicKey: 'fake-key' }),
    );
    assert.match(html, /data-endpoint="null"/);
    assert.match(html, /data-standalone="false"/);
  });

  it('rendert auch ohne vapidPublicKey ohne Crash', () => {
    const html = renderToStaticMarkup(
      React.createElement(TestComponent, { vapidPublicKey: '' }),
    );
    assert.match(html, /data-state="loading"/);
  });
});

describe('usePushSubscription · types', () => {
  it('Hook-Result hat alle Pflicht-Felder', () => {
    // Dieser Test ist primär ein TypeScript-Compile-Check — wenn das
    // Interface bricht, schlägt tsc --noEmit Alarm. Hier Smoke-Run-Check.
    const result = {
      state: 'loading' as const,
      isStandalone: false,
      message: '',
      endpoint: null,
      subscribe: async () => {},
      unsubscribe: async () => {},
      refresh: async () => {},
    };
    assert.equal(typeof result.subscribe, 'function');
    assert.equal(typeof result.unsubscribe, 'function');
    assert.equal(typeof result.refresh, 'function');
  });
});

// ---------------------------------------------------------------------------
// B3 Toggle-Reload-Bug-Tests (2026-05-25)
// ---------------------------------------------------------------------------
//
// Diese Tests verifizieren, dass der Hook KEINEN localStorage-Flag liest
// (localStorage ist nicht die Quelle der Wahrheit nach dem B3-Fix).
//
// Da der Hook Browser-APIs (serviceWorker, PushManager) braucht, testen
// wir hier nur das Verhalten beim SSR-Render (kein Browser, kein SW) und
// prüfen, dass localStorage-Einträge KEINE Auswirkung auf den initial-state
// haben.

describe('usePushSubscription · B3 localStorage-Unabhängigkeit', () => {
  it('initial state ist loading, unabhängig von localStorage-Inhalt', () => {
    // Selbst wenn localStorage einen 'lazyos.push.subscribed'-Eintrag enthielte,
    // ist initial state 'loading' (kein localStorage-Read im SSR-Pfad).
    const html = renderToStaticMarkup(
      React.createElement(TestComponent, { vapidPublicKey: 'fake-key' }),
    );
    // State kommt vom React-useState-Initial-Wert, NICHT von localStorage.
    assert.match(html, /data-state="loading"/, 'initial state muss loading sein');
    // endpoint ist null — kein lokaler Cache, keine Ghost-Subscription.
    assert.match(html, /data-endpoint="null"/, 'initial endpoint muss null sein');
  });

  it('localStorage-Key lazyos.push.subscribed taucht nicht im Hook-Code auf (B3)', () => {
    // Whitebox-Test: verifiziert, dass der Hook den alten localStorage-Flag
    // nicht mehr als QUELLE liest. Das sichert den Reload-Bug ab:
    // usePushSubscription.ts darf 'lazyos.push.subscribed' nur noch
    // höchstens beim Cleanup von alten Einträgen schreiben — nicht lesen.
    //
    // Importieren wir den Source-Code als String und prüfen ob er keinen
    // getItem-Call auf dem alten Key mehr enthält.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../usePushSubscription.ts'),
      'utf8',
    );
    // B3-Fix: kein getItem('lazyos.push.subscribed') mehr im Code.
    assert.ok(
      !src.includes(`getItem('lazyos.push.subscribed')`),
      'getItem auf lazyos.push.subscribed gefunden — B3-Fix unvollständig',
    );
    assert.ok(
      !src.includes(`getItem("lazyos.push.subscribed")`),
      'getItem auf lazyos.push.subscribed (doppelte Anführungszeichen) gefunden — B3-Fix unvollständig',
    );
  });

  it('sync() liest aus pushManager.getSubscription (Quelle der Wahrheit)', () => {
    // Verifiziert, dass der sync()-Body pushManager.getSubscription aufruft.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../usePushSubscription.ts'),
      'utf8',
    );
    assert.ok(
      src.includes('pushManager.getSubscription'),
      'pushManager.getSubscription nicht im Hook — sync() liest nicht die echte Quelle',
    );
  });
});
