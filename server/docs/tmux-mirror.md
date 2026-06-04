# lazyOS tmux Mirror (Option C1)

_Last updated: 2026-04-24_

## Why

the owner's demand: "wenn ich `tmux attach -t lazyos-ws-lazyos` mache, möchte
ich live sehen, was die PWA gerade mit dem Workspace-Chat treibt — und
parallel im gleichen Terminal Bash-Arbeit machen können."

Pre-Option-C layout: `lazyos-ws-<id>` was a single tmux window with one
Bash pane. `claude` never ran inside it — the agent-server spawned it
directly via `child_process.spawn`. Attaching the tmux session showed a
plain shell, nothing chat-related. Invisible to Max = useless to Max.

## What

**Variant C1 — Node drives the Claude-CLI child directly (as before),
and in parallel writes a human-readable ANSI-coloured transcript to
`/tmp/lazyos-transcript-<workspaceId>.log`. The top tmux pane runs
`tail -F` on that file.**

Layout after `ensureSession`:

```
┌─────────────────────────────────────────── pane 0 (30%) ─┐
│ lazyOS · Workspace: Demo PV · attach via: tmux attach ...│
│ ─── Live Chat Transcript ───                              │
│ ─── Turn 3 · 14:02:11 ───                                 │
│ > liste files in cwd                                      │
│                                                            │
│ Klar, hier sind die Files…                                 │
│ [Bash] {"command":"ls -la"}                                │
│   ↳ total 48 -rw-r--r-- 1 root root 8300 Apr 24 ...        │
│                                                            │
│ ──── end · 1730ms · 214 chars · 1 tools ────              │
├─────────────────────────────────────────── pane 1 (70%) ─┤
│ lazyOS · PV Demo (demo-pv) · ~/projects/demo-pv           │
│ user@host:~/projects/demo-pv# █                           │
└───────────────────────────────────────────────────────────┘
```

Pane 0 is the **live chat mirror** (read-only, rendered via tail -F).
Pane 1 is a plain Bash in the workspace cwd where Max can `git log`,
`grep`, inspect files, run commands — without disturbing the chat.

## Trade-off vs Variant C2

Not implemented here: full bidirectional mirror, where Claude runs
interactively inside the tmux session itself and Node reads its output
via `pipe-pane`. That would let Max type `claude` or any other command
in the terminal and have the PWA see it. But:

- ANSI parsing is fragile (Claude-CLI uses rich TUI sequences)
- No structured JSONL stream → tool-call detection becomes heuristic
- Race conditions between "prompt sent" and "response started"

C1 keeps the robust JSONL path and delivers the part Max actually
asked for ("I see what the PWA does when I attach"). The inverse
direction ("PWA sees what I type in terminal") is a future iteration.

## Data flow

```
 ┌────────────┐   JSONL   ┌─────────────┐   tokens/tools   ┌──────────────┐
 │ claude-CLI │ ────────> │ Node server │ ───────────────> │ SSE to PWA   │
 └────────────┘           │  (spawn)    │                   └──────────────┘
                          │             │
                          │ Transcript- │   ANSI text      ┌──────────────┐
                          │ Writer      │ ───────────────> │/tmp/log file │
                          └─────────────┘                   └──────┬───────┘
                                                                   │ tail -F
                                                                   ▼
                                                            ┌──────────────┐
                                                            │ tmux pane 0  │
                                                            └──────────────┘
```

## Files

- `server/transcript-writer.ts` — opens/trims/appends to the log file
- `server/workspace-session.ts`
  - `ensureMirrorLayout()` / `createMirrorSession()` — tmux split
  - `sendPrompt()` — fan-out emit that calls caller + transcript
- `server/tmux-controller.ts`
  - `splitWindow`, `listPanes`, `selectPane`, `sendKeysToPane`

## Migration

Sessions created before this refactor have one pane (plain bash).
`ensureMirrorLayout()` detects `panes.length < 2` on an existing
session, kills it, and recreates with the split layout. This happens
lazily on the next `/chat` call per workspace — no migration script
needed.

## File lifecycle

- File: `/tmp/lazyos-transcript-<workspaceId>.log`
- Trimmed on each `openTranscript()` to the last 10 000 lines
- Not cleaned up on workspace deletion (low priority — /tmp clears on
  reboot and files are small)
- tail -F survives truncation in place (it re-opens the file)

## Known caveats

1. **Delayed first render**: `tail -F` needs ~100 ms to start reading,
   so the banner line "─── Live Chat Transcript ───" may appear a
   beat before the first turn header. Harmless.
2. **Multi-byte tokens**: the writer appends tokens verbatim. A token
   split across a multi-byte UTF-8 boundary could theoretically show
   as a broken char in tail's render for a frame; in practice
   Claude-CLI's stream_event deltas are already UTF-8-safe chunks.
3. **Legacy session migration kills tmux state**: if Max had opened a
   workspace session and left a half-typed command in the pane, the
   first chat call after this deploy will kill and recreate. User
   visible. Warn in release notes.

## Future work (C2 / bidirectional)

- Run claude *inside* the tmux session as the main pane
- Node talks via `send-keys` + `pipe-pane` instead of child_process
- Would make `tmux attach → type → PWA sees` work
- Not blocking anything today
