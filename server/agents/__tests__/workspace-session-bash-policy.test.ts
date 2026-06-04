/**
 * workspace-session — Bash-Policy-Hook-Verdrahtung
 * ============================================================================
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     server/agents/__tests__/workspace-session-bash-policy.test.ts
 *
 * Verifiziert, dass `bashPolicyArgs(true)` das `--settings`-Flag mit dem
 * absoluten Hook-Pfad als PreToolUse-Bash-Matcher liefert — und im
 * non-fullAccess-Zweig (`false`) NICHTS hinzufügt.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  bashPolicyArgs,
  buildBashPolicySettingsJson,
} from '../../workspace-session';

describe('workspace-session bash-policy wiring', () => {
  it('fullAccess → injects --settings with the PreToolUse Bash hook', () => {
    const args = bashPolicyArgs(true);
    expect(args[0]).toBe('--settings');
    const settingsJson = args[1];
    expect(typeof settingsJson).toBe('string');

    const parsed = JSON.parse(settingsJson as string);
    const pre = parsed.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe('Bash');
    const hook = pre[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.timeout).toBe(5000);
    // command = `node <abs>/server/agents/bash-path-policy.cjs`
    expect(hook.command).toMatch(/^node\s+\//);
    expect(hook.command.endsWith(path.join('server', 'agents', 'bash-path-policy.cjs'))).toBe(true);
  });

  it('non-fullAccess → no --settings, no hook (unchanged behavior)', () => {
    const args = bashPolicyArgs(false);
    expect(args).toEqual([]);
  });

  it('the injected hook path is absolute', () => {
    const json = JSON.parse(buildBashPolicySettingsJson());
    const cmd: string = json.hooks.PreToolUse[0].hooks[0].command;
    const absPart = cmd.replace(/^node\s+/, '');
    expect(path.isAbsolute(absPart)).toBe(true);
  });
});
