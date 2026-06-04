/**
 * Plan-Dispatch Child-Subplan `collapsed:true` Test · Owner-Fix (2026-05-28).
 *
 * Owner-Befund 2026-05-28: T+0s emittierten 3x `<surface:subplan>` simultan
 * (parent + 2 children, lib/plan-first/plan-dispatch.ts:223 + :270). Fix:
 * jedes Child-Subplan-Payload traegt nun `collapsed:true` — die SubplanCard
 * startet als Pill und der Parent bleibt der einzige offene Plan-Block.
 *
 * Vertrag (pure, ohne LLM-Mock):
 *   - Wir laufen den FOR-Loop NICHT (das wuerde resourcePool, broadcast,
 *     createWorkstream, getDb forken — alles integration-heavy). Wir testen
 *     die Forms direkt: lesen den Modul-Source als String und pruefen, dass
 *     der Child-Payload `collapsed: true` enthaelt und der Parent-Emit
 *     (Schritt 6) NICHT.
 *
 * Begruendung: Plan-Dispatch ist als File-Snapshot stabil; das Property
 * existiert oder nicht. Ein Integration-Test waere 300 Zeilen Stub fuer
 * eine zwei-Zeilen-Aenderung — pragma-Snapshot ist hier ausreichend.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/plan-first/__tests__/plan-dispatch-child-collapsed.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DISPATCH_PATH = join(__dirname, '..', 'plan-dispatch.ts');

describe('plan-dispatch — child-subplan collapsed flag (Owner-Fix 2026-05-28)', () => {
  it('child payload contains `collapsed: true`', () => {
    const src = readFileSync(DISPATCH_PATH, 'utf8');
    // Locate the child-payload literal (Schleife :270 in plan-dispatch.ts).
    // Find the block introduced by `const childPayload = {` and inspect it.
    const childIdx = src.indexOf('const childPayload = {');
    expect(childIdx).toBeGreaterThan(-1);
    const block = src.slice(childIdx, childIdx + 800);
    expect(block).toContain('collapsed: true');
  });

  it('parent (root) surface emit does NOT add collapsed:true', () => {
    const src = readFileSync(DISPATCH_PATH, 'utf8');
    // The parent emit builds a `surfacePayload` for the root subplan and
    // emits it via emitOrUpdateCard. We assert the parent block does not
    // carry collapsed:true. Look for `const surfacePayload = {`.
    const parentIdx = src.indexOf('const surfacePayload = {');
    expect(parentIdx).toBeGreaterThan(-1);
    // Take the next 400 chars as the literal block.
    const block = src.slice(parentIdx, parentIdx + 400);
    expect(block).not.toContain('collapsed: true');
  });
});
