# Auto-dispatch · build mode

## What

The auto-dispatch sub-agents (senior-dev / code-reviewer / critic) write **real
code diffs** instead of Markdown sketches.

## Mode switches

| ENV var | Default | Effect |
|--|--|--|
| `LAZYOS_BUILD_MODE` | `build` | Sub-agents get tool use, write code, and commit |
| `LAZYOS_BUILD_MODE=plan` | — | Legacy behavior: Markdown sketches only, no file edits |
| `LAZYOS_DISABLE_AUTO_DISPATCH=1` | — | Auto-dispatch fully off |
| `LAZYOS_AUTODISPATCH_PAUSE_MS` | `25000` | Sniper pause before sub-spawns (0 = off) |

## How

### Build mode (default)

1. **senior-dev** gets `Read, Write, Edit, Bash, Grep, Glob` and
   `--permission-mode acceptEdits`.
2. The working dir of the tmux session = `workspacePath` (= the target repo).
3. senior-dev MUST:
   - Make file edits (not Markdown-only).
   - Commit with a `[skip-mirror]` footer (mandatory — otherwise an echo loop).
   - Not push, not reset, not force-push.
4. **code-reviewer** gets `Read, Bash, Grep, Glob` (read-only), reads
   `git log -1` + `git diff HEAD~1 HEAD`, and returns
   `APPROVED` / `CHANGES_REQUESTED` + findings.
5. **critic** is like the reviewer, plus a 5-perspective critique.

### Acceptance check

After all stages, the spawner checks via `git log --since=@<unix-ts>` whether at
least 1 commit was created since the pipeline started.

- 0 commits → the sub-ticket stays `executing`, the master does NOT auto-close.
  A `transition: 'no_code_written'` event and a `kind: 'auto-dispatch-no-code'`
  comment are emitted.
- ≥ 1 commit → the sub-ticket is `closed`; the master auto-closes when all
  siblings are also closed.

### Plan mode (legacy)

`LAZYOS_BUILD_MODE=plan` reactivates the old behavior: no tool use, all stages
produce Markdown sketches on the sub-ticket. The acceptance check is disabled in
plan mode.

## Echo-loop protection

Three layers:

1. **The senior-dev prompt forbids** `git push`, `git reset`, `--no-verify`,
   force-push, and amend without operator OK.
2. **The commit footer `[skip-mirror]`** is mandatory. The senior-dev prompt
   states this explicitly.
3. **The `isSkipMirrorEvent()` guard** in `lib/tickets/auto-dispatch.ts`:
   `commented`/`created` events with `[skip-mirror]` in the body/subject are
   ignored in `maybeAutoDispatch` and `maybeAutoCloseMaster`.
4. **Chat-mirror skip** in `lib/chat/event-to-surface.ts`: the git-commit surface
   returns `null` when `messageSubject` contains the marker → no toast in chat.

## Tools allow-list (security)

`server/agents/tmux-spawn.ts` contains a `SAFE_TOOLS` allow-list
(`Read, Write, Edit, Bash, Grep, Glob`). Other values are filtered out before
being passed through to the Claude CLI.

## Rollback

On an incident:

```bash
export LAZYOS_BUILD_MODE=plan
systemctl restart lazyos-web
```

Sub-agents immediately fall back to the old Markdown-sketch mode. No tool use, no
file edits, no git commits from auto-dispatch.
