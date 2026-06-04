/**
 * FS-Sandbox — buildSandboxSpec + resolveSandboxMode + wrapWithSandbox Tests.
 * Runner: node --import tsx --test lib/security/fs-sandbox/__tests__/profile.test.ts
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSandboxSpec, ENV_SECRET_DENY_SENTINEL } from '../profile';
import { resolveSandboxMode, wrapWithSandbox } from '../wrapper';
import type { FsSandboxSpec } from '../types';

// Host-neutral fixture paths rooted at the home dir.
const HOME = homedir();
const DOCS = join(HOME, 'Documents');
const CRM = join(DOCS, 'demo-pv-crm');
const WEB = join(DOCS, 'demo-pv-web');
const WORKTREE = join(CRM, '.lazing-worktrees', 'wt-abc');

describe('buildSandboxSpec', () => {
  it('rwPaths enthält den Worktree zuerst', () => {
    const spec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
    assert.equal(spec.rwPaths[0], WORKTREE);
  });

  it('roPaths enthält roRoots + liveGitDir', () => {
    const spec = buildSandboxSpec({
      worktreePath: WORKTREE,
      homeDir: HOME,
      roRoots: [WEB],
      liveGitDir: join(CRM, '.git'),
    });
    assert.ok(spec.roPaths.includes(WEB));
    assert.ok(spec.roPaths.includes(join(CRM, '.git')));
  });

  it('hardDeny enthält ~/.lazyos + ~/.codex + otherWorkspaceRoots', () => {
    const spec = buildSandboxSpec({
      worktreePath: WORKTREE,
      homeDir: HOME,
      otherWorkspaceRoots: [join(DOCS, 'other-project')],
    });
    assert.ok(spec.hardDeny.includes(`${HOME}/.lazyos`));
    assert.ok(spec.hardDeny.includes(`${HOME}/.codex`));
    assert.ok(spec.hardDeny.includes(join(DOCS, 'other-project')));
  });

  it('~/.claude ist NICHT in hardDeny, aber ~/.claude/credentials schon', () => {
    const spec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
    // ~/.claude bleibt lesbar (OAuth) → als ro-Pfad, NICHT in hardDeny.
    assert.ok(!spec.hardDeny.includes(`${HOME}/.claude`));
    assert.ok(spec.roPaths.includes(`${HOME}/.claude`));
    // credentials darunter wird hart gedenyed.
    assert.ok(spec.hardDeny.includes(`${HOME}/.claude/credentials`));
  });

  it('hardDeny enthält den .env-Secret-Sentinel', () => {
    const spec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
    assert.ok(spec.hardDeny.includes(ENV_SECRET_DENY_SENTINEL));
  });

  it('hardDeny enthält ssh/aws/gcloud immer', () => {
    const spec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
    assert.ok(spec.hardDeny.includes(`${HOME}/.ssh`));
    assert.ok(spec.hardDeny.includes(`${HOME}/.aws`));
    assert.ok(spec.hardDeny.includes(`${HOME}/.config/gcloud`));
  });

  it('allowNetwork ist default true (FS-Härtung, nicht Netz)', () => {
    const spec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
    assert.equal(spec.allowNetwork, true);
  });

  it('Bridge-Grants landen je nach access in rw/ro', () => {
    const spec = buildSandboxSpec({
      worktreePath: WORKTREE,
      homeDir: HOME,
      bridgeGrantedPaths: [
        { absPath: join(DOCS, 'shared-rw'), access: 'rw' },
        { absPath: join(DOCS, 'shared-ro'), access: 'ro' },
      ],
    });
    assert.ok(spec.rwPaths.includes(join(DOCS, 'shared-rw')));
    assert.ok(spec.roPaths.includes(join(DOCS, 'shared-ro')));
  });

  it('extraRwRoots werden zu rwPaths hinzugefügt', () => {
    const spec = buildSandboxSpec({
      worktreePath: WORKTREE,
      homeDir: HOME,
      extraRwRoots: [join(CRM, '.lazing-worktrees', 'wt-2')],
    });
    assert.ok(spec.rwPaths.includes(join(CRM, '.lazing-worktrees', 'wt-2')));
  });

  it('trailing-Slashes werden normalisiert (kein Duplikat)', () => {
    const spec = buildSandboxSpec({
      worktreePath: WORKTREE + '/',
      homeDir: HOME + '/',
    });
    assert.equal(spec.rwPaths[0], WORKTREE);
    assert.equal(spec.homeDir, HOME);
  });

  it('leerer homeDir wirft (fail-closed)', () => {
    assert.throws(() => buildSandboxSpec({ worktreePath: WORKTREE, homeDir: '   ' }));
  });
});

describe('resolveSandboxMode', () => {
  it('undefined-env → enforce', () => {
    assert.equal(resolveSandboxMode({} as NodeJS.ProcessEnv), 'enforce');
  });

  it("LAZYOS_FS_SANDBOX='off' → off", () => {
    assert.equal(
      resolveSandboxMode({ LAZYOS_FS_SANDBOX: 'off' } as unknown as NodeJS.ProcessEnv),
      'off',
    );
  });

  it("LAZYOS_FS_SANDBOX='on' → enforce (nur 'off' deaktiviert)", () => {
    assert.equal(
      resolveSandboxMode({ LAZYOS_FS_SANDBOX: 'on' } as unknown as NodeJS.ProcessEnv),
      'enforce',
    );
  });

  it("LAZYOS_FS_SANDBOX='ENFORCE' (Tippfehler-Casing) → enforce", () => {
    assert.equal(
      resolveSandboxMode({ LAZYOS_FS_SANDBOX: 'ENFORCE' } as unknown as NodeJS.ProcessEnv),
      'enforce',
    );
  });
});

describe('wrapWithSandbox', () => {
  const spec: FsSandboxSpec = buildSandboxSpec({ worktreePath: WORKTREE, homeDir: HOME });
  const innerCmd = `cd ${WORKTREE} && claude --version`;

  it("mode='off' → command === innerCmd, profilePath null, cleanup noop", () => {
    const wrap = wrapWithSandbox(innerCmd, spec, { mode: 'off' });
    assert.equal(wrap.command, innerCmd);
    assert.equal(wrap.profilePath, null);
    assert.doesNotThrow(() => wrap.cleanup());
  });

  it("mode='enforce' → command startet mit sandbox-exec -f, profilePath gesetzt", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fs-sandbox-test-'));
    const wrap = wrapWithSandbox(innerCmd, spec, { mode: 'enforce', tmpDir });
    assert.ok(wrap.command.startsWith('sandbox-exec -f '));
    assert.ok(wrap.command.includes('bash -c '));
    assert.ok(wrap.profilePath !== null);
    assert.ok(existsSync(wrap.profilePath as string));
    // cleanup entfernt das Profil-Tempfile wieder.
    wrap.cleanup();
    assert.ok(!existsSync(wrap.profilePath as string));
  });

  it("mode='enforce' → innerCmd ist shell-gequotet im command enthalten", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fs-sandbox-test-'));
    const wrap = wrapWithSandbox(innerCmd, spec, { mode: 'enforce', tmpDir });
    // Der gequotete innerCmd erscheint single-quoted am Ende des Befehls.
    assert.ok(wrap.command.includes(`'${innerCmd}'`));
    wrap.cleanup();
  });
});
