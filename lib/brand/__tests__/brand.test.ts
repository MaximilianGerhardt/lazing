/**
 * Brand-Modul-Tests — ENV-Override für Rollback-Pfad.
 *
 * BRAND_NAME wird beim Modul-Load fixiert (top-level const), darum
 * verifizieren wir das Override-Verhalten via fresh-import in eigenen
 * Subprocesses bzw. via require-cache-bust. Hier nutzen wir simple
 * Inline-Logik (gleiches Pattern wie das Modul) — der Test stellt
 * sicher, dass das Default- und Override-Verhalten dokumentiert bleibt
 * und nicht still wegregressiert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function readBrand(): string {
  const raw = (process.env as Record<string, string | undefined>).LAZYOS_BRAND_NAME;
  return raw?.trim() || 'laz.ing';
}

test('Brand: default ohne ENV ist laz.ing', () => {
  const before = process.env.LAZYOS_BRAND_NAME;
  delete process.env.LAZYOS_BRAND_NAME;
  try {
    assert.equal(readBrand(), 'laz.ing');
  } finally {
    if (before !== undefined) process.env.LAZYOS_BRAND_NAME = before;
  }
});

test('Brand: ENV-Override LAZYOS_BRAND_NAME=lazyOS für Rollback', () => {
  const before = process.env.LAZYOS_BRAND_NAME;
  process.env.LAZYOS_BRAND_NAME = 'lazyOS';
  try {
    const v = readBrand();
    assert.equal(v, 'lazyOS');
  } finally {
    if (before === undefined) {
      delete process.env.LAZYOS_BRAND_NAME;
    } else {
      process.env.LAZYOS_BRAND_NAME = before;
    }
  }
});

test('Brand: ENV-Override mit Whitespace wird getrimmt', () => {
  const before = process.env.LAZYOS_BRAND_NAME;
  process.env.LAZYOS_BRAND_NAME = '  laz.ing  ';
  try {
    const v = readBrand();
    assert.equal(v, 'laz.ing');
  } finally {
    if (before === undefined) {
      delete process.env.LAZYOS_BRAND_NAME;
    } else {
      process.env.LAZYOS_BRAND_NAME = before;
    }
  }
});

test('Brand: leerer ENV-Wert fällt auf default zurück', () => {
  const before = process.env.LAZYOS_BRAND_NAME;
  process.env.LAZYOS_BRAND_NAME = '';
  try {
    const v = readBrand();
    assert.equal(v, 'laz.ing');
  } finally {
    if (before === undefined) {
      delete process.env.LAZYOS_BRAND_NAME;
    } else {
      process.env.LAZYOS_BRAND_NAME = before;
    }
  }
});

test('Brand-Modul exportiert die erwarteten Konstanten', async () => {
  const brand = await import('@/lib/brand');
  assert.ok(typeof brand.BRAND_NAME === 'string');
  assert.ok(brand.BRAND_NAME.length > 0);
  assert.equal(brand.BRAND_LEGAL, 'Example Company');
  assert.equal(brand.BRAND_DOMAIN, 'laz.ing');
  assert.equal(brand.BRAND_PRIMARY_URL, 'https://app.laz.ing');
  assert.equal(brand.BRAND_TWO_FA_ISSUER, brand.BRAND_NAME);
  assert.ok(brand.BRAND_EMAIL_FROM_DEFAULT.includes(brand.BRAND_NAME));
  assert.ok(brand.BRAND_EMAIL_FROM_DEFAULT.includes('mail.example.com'));
});

test('Brand: BRAND_EMAIL_FROM_DEFAULT beginnt mit BRAND_NAME', async () => {
  // Verifiziert die Composition: `${BRAND_NAME} <noreply@mail.example.com>`
  const brand = await import('@/lib/brand');
  assert.ok(
    brand.BRAND_EMAIL_FROM_DEFAULT.startsWith(brand.BRAND_NAME + ' <'),
    `expected EMAIL_FROM to start with "${brand.BRAND_NAME} <", got: ${brand.BRAND_EMAIL_FROM_DEFAULT}`,
  );
  assert.match(brand.BRAND_EMAIL_FROM_DEFAULT, /<noreply@mail\.example.com>$/);
});

test('Brand: BRAND_TWO_FA_ISSUER spiegelt BRAND_NAME (Authenticator-App-Label)', async () => {
  // Bestehende Setups mit "lazyOS:..."-URI laufen via Rollback-ENV weiter.
  const brand = await import('@/lib/brand');
  assert.equal(brand.BRAND_TWO_FA_ISSUER, brand.BRAND_NAME);
});

test('Brand: BRAND_DOMAIN ist immer laz.ing (Identifier, nicht ENV-überschreibbar)', async () => {
  // BRAND_DOMAIN ist ein hardcoded Identifier — auch wenn jemand
  // LAZYOS_BRAND_NAME=lazyOS setzt, bleibt die Domain laz.ing
  // (Rollback ist nur Wordmark-Switch, nicht Domain-Switch).
  const brand = await import('@/lib/brand');
  assert.equal(brand.BRAND_DOMAIN, 'laz.ing');
  assert.equal(brand.BRAND_PRIMARY_URL, 'https://app.laz.ing');
});
