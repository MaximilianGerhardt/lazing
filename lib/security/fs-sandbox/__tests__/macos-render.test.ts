/**
 * FS-Sandbox — renderSeatbeltProfile Tests (macOS seatbelt).
 * Runner: node --import tsx --test lib/security/fs-sandbox/__tests__/macos-render.test.ts
 *
 * Der Reihenfolge-Test (credentials-deny NACH ~/.claude-allow) ist
 * sicherheits-kritisch: seatbelt wertet last-match-wins aus.
 */

import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';

import { buildSandboxSpec } from '../profile';
import { renderSeatbeltProfile } from '../macos';

// Host-neutral fixture paths rooted at the home dir. The seatbelt renderer
// emits forward-slash subpaths, so we build with `/` (not path.join).
const HOME = homedir();
const DOCS = `${HOME}/Documents`;
const CRM = `${DOCS}/demo-pv-crm`;
const WEB = `${DOCS}/demo-pv-web`;
const OTHER = `${DOCS}/other-project`;
const WORKTREE = `${CRM}/.lazing-worktrees/wt-abc`;

function render(extra?: Parameters<typeof buildSandboxSpec>[0]): string {
  const spec = buildSandboxSpec({
    worktreePath: WORKTREE,
    homeDir: HOME,
    liveGitDir: `${CRM}/.git`,
    roRoots: [WEB],
    otherWorkspaceRoots: [OTHER],
    ...extra,
  });
  return renderSeatbeltProfile(spec);
}

describe('renderSeatbeltProfile', () => {
  it('enthält (version 1) und (deny default)', () => {
    const sb = render();
    assert.ok(sb.includes('(version 1)'));
    assert.ok(sb.includes('(deny default)'));
  });

  it('importiert bsd.sb NACH (version 1) und VOR (deny default)', () => {
    const sb = render();
    const ver = sb.indexOf('(version 1)');
    const imp = sb.indexOf('(import "bsd.sb")');
    const denyDefault = sb.indexOf('(deny default)');
    assert.ok(imp >= 0, 'bsd.sb-Import muss vorhanden sein (sonst startet kein Binary)');
    assert.ok(ver < imp, 'Import muss nach (version 1) stehen');
    assert.ok(imp < denyDefault, 'Import muss vor (deny default) stehen');
  });

  it('erlaubt process-fork + process-exec', () => {
    const sb = render();
    assert.ok(sb.includes('(allow process-fork)'));
    assert.ok(sb.includes('(allow process-exec)'));
  });

  it('enthält rw-allow auf den Worktree (subpath)', () => {
    const sb = render();
    assert.ok(
      sb.includes(`(allow file-read* file-write* (subpath "${WORKTREE}"))`),
      'Worktree muss als rw-subpath erlaubt sein',
    );
  });

  it('enthält ro-allow auf den Live-.git', () => {
    const sb = render();
    assert.ok(sb.includes(`(allow file-read* (subpath "${CRM}/.git"))`));
  });

  it('enthält network-allow (FS-Härtung, nicht Netz)', () => {
    const sb = render();
    assert.ok(sb.includes('(allow network*)'));
  });

  it('emittiert /tmp/lazyos-* als rw', () => {
    const sb = render();
    assert.ok(sb.includes('^/tmp/lazyos-'));
  });

  it('REIHENFOLGE: credentials-deny kommt NACH der ~/.claude-allow (last-match-wins)', () => {
    const sb = render();
    const allowClaude = sb.indexOf(`(allow file-read* (subpath "${HOME}/.claude"))`);
    // Die credentials-deny ist eine regex-Zeile; im seatbelt-regex-Literal
    // sind die Slashes escaped (\/), daher matchen wir die escaped Form.
    const denyCreds = sb.indexOf('\\.claude\\/credentials');
    assert.ok(allowClaude >= 0, '~/.claude muss als ro-allow vorhanden sein');
    assert.ok(denyCreds >= 0, 'credentials-deny muss vorhanden sein');
    assert.ok(
      denyCreds > allowClaude,
      'credentials-deny MUSS nach der ~/.claude-allow stehen (seatbelt: letzte Regel gewinnt)',
    );
  });

  it('REIHENFOLGE: harte Denies stehen nach den allow-Regeln (Worktree)', () => {
    const sb = render();
    const allowWt = sb.indexOf(`(allow file-read* file-write* (subpath "${WORKTREE}"))`);
    const denyLazyos = sb.indexOf(`(deny file-read* file-write* (subpath "${HOME}/.lazyos"))`);
    assert.ok(allowWt >= 0 && denyLazyos >= 0);
    assert.ok(denyLazyos > allowWt, 'harte Denies müssen nach allow-Regeln stehen');
  });

  it('denyt ~/.lazyos (Live-DB) und ~/.codex und andere Workspaces hart', () => {
    const sb = render();
    assert.ok(sb.includes(`(deny file-read* file-write* (subpath "${HOME}/.lazyos"))`));
    assert.ok(sb.includes(`(deny file-read* file-write* (subpath "${HOME}/.codex"))`));
    assert.ok(
      sb.includes(`(deny file-read* file-write* (subpath "${OTHER}"))`),
    );
  });

  it('emittiert eine .env-Secret-deny per regex', () => {
    const sb = render();
    // regex-Deny auf \.env — escaped als \\.env im seatbelt-String.
    assert.ok(sb.includes('(deny file-read* file-write* (regex #"\\.env"))'));
  });

  it('escaped Pfade mit Anführungszeichen defensiv', () => {
    const sb = renderSeatbeltProfile(
      buildSandboxSpec({ worktreePath: `${HOME}/weird"name`, homeDir: HOME }),
    );
    // Das Doublequote im Pfad muss escaped sein (\") — sonst bricht das Literal.
    assert.ok(sb.includes('weird\\"name'));
  });

  it('ist ein nicht-leeres Profil mit trailing newline', () => {
    const sb = render();
    assert.ok(sb.length > 0);
    assert.ok(sb.endsWith('\n'));
  });
});
