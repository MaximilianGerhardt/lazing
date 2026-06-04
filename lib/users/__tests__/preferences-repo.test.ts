/**
 * preferences-repo Integration-Tests (Owner-Fix Live-Test 2026-05-28).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     pnpm exec vitest run lib/users/__tests__/preferences-repo.test.ts
 *
 * Wir fahren gegen eine echte tmp-SQLite-DB, damit:
 *   - die Migration 0114_user_preferences.sql wirklich angewendet wird,
 *   - der CHECK-Constraint auf `default_permission_mode` bestätigt ist,
 *   - der upsert-Pfad (INSERT … ON CONFLICT … DO UPDATE) verifiziert ist,
 *   - N10 content_hash deterministisch ist (gleicher Input → gleicher Hash).
 *
 * Wir laufen unter vitest (statt node:test), weil `getDb()` einen
 * stuck-detector setInterval startet — vitest räumt das beim Run-Exit auf,
 * node:test bliebe ewig hängen.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set DB path + repo-fallback BEFORE importing the repo (getDb() reads env on first call).
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-prefs-')),
    'prefs-test.db',
  );
}
// FK-Disable: Migration 0036 baut auf vorhandenen Org-Rows auf, die ein
// frischer Test-Spawn nicht hat. Vom Repo nicht selbst gebraucht, aber
// Migrations-Apply würde sonst frühzeitig wirfen.
process.env.LAZYOS_TEST_DISABLE_FK = '1';

import {
  getUserPreferences,
  getUserDefaultPermissionMode,
  setUserDefaultPermissionMode,
} from '../preferences-repo';
import { getDb } from '@/db/client';

function wipeUser(userId: string): void {
  const db = getDb();
  db.$raw.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(userId);
}

describe('preferences-repo · setUserDefaultPermissionMode', () => {
  beforeAll(() => {
    // Triggert das Migrations-Apply einmalig.
    getDb();
  });

  beforeEach(() => {
    wipeUser('u_alpha');
    wipeUser('u_beta');
  });

  it('legt eine Row an wenn keine existiert (insert-fresh)', () => {
    const after = setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein',
      reason: 'test-insert',
      source: 'permission-toggle',
    });
    expect(after.userId).toBe('u_alpha');
    expect(after.defaultPermissionMode).toBe('freerein');
    expect(after.source).toBe('permission-toggle');
    expect(after.reason).toBe('test-insert');
    // sha256 hex
    expect(after.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ist idempotent — zweiter Aufruf mit gleichem Input ist UPDATE, kein Crash (upsert-idempotent)', () => {
    setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein',
      source: 'api',
    });
    const second = setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein',
      source: 'api',
    });
    expect(second.defaultPermissionMode).toBe('freerein');
    const db = getDb();
    const count = db.$raw
      .prepare('SELECT COUNT(*) as c FROM user_preferences WHERE user_id = ?')
      .get('u_alpha') as { c: number };
    expect(count.c).toBe(1);
  });

  it('Wechsel des Modes wird übernommen (update-mode-changed)', () => {
    setUserDefaultPermissionMode({ userId: 'u_alpha', mode: 'ask' });
    setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein-with-audit',
    });
    const got = getUserPreferences('u_alpha');
    expect(got?.defaultPermissionMode).toBe('freerein-with-audit');
  });

  it('content_hash ist deterministisch (same-input-same-hash)', () => {
    const a = setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein',
      reason: 'r',
      source: 'api',
    });
    const b = setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'freerein',
      reason: 'r',
      source: 'api',
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('getUserDefaultPermissionMode → null wenn keine Row (null-when-missing)', () => {
    expect(getUserDefaultPermissionMode('u_never_set')).toBeNull();
  });

  it('ungültiger Mode wirft (reject-invalid-mode)', () => {
    expect(() =>
      setUserDefaultPermissionMode({
        userId: 'u_alpha',
        // @ts-expect-error — wir testen den Schutz gegen invalide Werte.
        mode: 'not-a-mode',
      }),
    ).toThrow();
  });

  it("ungültige source fällt auf 'api' zurück (source-whitelist-fallback)", () => {
    const after = setUserDefaultPermissionMode({
      userId: 'u_alpha',
      mode: 'ask',
      // @ts-expect-error — non-whitelist Source.
      source: 'totally-bogus',
    });
    expect(after.source).toBe('api');
  });

  it('zwei User → zwei unabhängige Rows (per-user-isolation)', () => {
    setUserDefaultPermissionMode({ userId: 'u_alpha', mode: 'freerein' });
    setUserDefaultPermissionMode({ userId: 'u_beta', mode: 'ask' });
    expect(getUserDefaultPermissionMode('u_alpha')).toBe('freerein');
    expect(getUserDefaultPermissionMode('u_beta')).toBe('ask');
  });
});
