# Design consistency charter

> As of 2026-05-01.
> Binding for lib/chat/, app/, lib/nav/, and all surfaces.
> Violations are surfaced via `pnpm lint:design`.

---

## 1. Token contracts

### Hierarchy

| Layer | File | Content | Rule |
|-------|------|---------|------|
| Primary | `app/globals.css` | Semantic tokens (`--sheet`, `--ink`, `--line`, `--accent`, the spacing scale) | Single source of truth |
| Components | `app/components.css` | Component-local, module-specific tokens | Must not override primary |
| Dynamic | `app/organizations-palette.css` | Per-org palette (24 slots) | Activated via `:root[data-org]` |
| Runtime | `lib/nav/TopNav.tsx`, etc. | Layout-reactive tokens (`--topnav-h`) | Set via `setProperty` in JS |

### Anti-patterns

- **Ghost tokens** — `var(--xxx)` without a definition anywhere. `--a-border`,
  `--a-text`, `--a-bg-elev` were examples (all removed 2026-05-01). Audit:
  `pnpm lint:tokens`, a hard FAIL.
- **Hex colors in TSX** — `background: '#FF0050'` bypasses the theme system.
  Exceptions: UI primitives (toggle thumb = `var(--ink)`), never brand colors.
  Audit: `pnpm lint:hex` (informational).
- **Inline styles for spacing** — `padding: 12` instead of `var(--s-3)`. Target
  state: 0 hits. Audit: `pnpm lint:surfaces`.

### Token naming

- `--sheet`, `--sheet-1`, `--sheet-2`, `--sheet-3` — background depth steps (dark → less-dark)
- `--ink`, `--ink-2`, `--ink-3`, `--ink-4` — text depth steps (full → muted)
- `--line`, `--line-2` — border steps
- `--card`, `--card-2`, `--card-3` — semi-transparent card backgrounds (rgba layers)
- `--a-now`, `--a-north`, `--a-clientb`, `--a-own`, `--a-private` — brand accents
- `--a-danger`, `--a-warn` — status accents
- `--e-claude`, `--e-codex`, `--e-local` — engine accents
- `--s-1` ... `--s-8` — the spacing scale (4/8/12/16/24/32 grid)

---

## 2. Spacing scale

Binding:

```
--s-1: 4px    micro gap, icon-text gap
--s-2: 8px    pill padding, tight card gap
--s-3: 12px   default card gap, button padding
--s-4: 16px   card padding, tight section gap
--s-6: 24px   section gap, large card padding
--s-8: 32px   page-section gap, modal padding
```

**Migration schedule:**

| Wave | Date | Threshold (`LAZYOS_SURFACE_LINT_THRESHOLD`) | Scope |
|------|------|---------------------------------------------|-------|
| 1 | 2026-05-01 | 200 | Ghost tokens + spacing scale introduced |
| 2 | 2026-05-08 | 100 | Card sweep + composer |
| 3 | 2026-05-15 | 50 | Lab + routines |
| 4 | 2026-05-22 | 0 | Strict — all inline padding/margin/gap replaced |

The audit counts `padding`, `margin`, `gap`, `width`, `height` (incl. sub-variants)
as inline-style hits.

---

## 3. Spring decision memo

**Decision 2026-05-01:** pure-CSS springs win, `motion@12` deprecated.

### Rationale

| Aspect | Pure CSS | motion@12 |
|--------|----------|-----------|
| Bundle impact | 0 KB | ~85 KB (gzipped) |
| Performance | GPU compositor | JS-tick-driven |
| iOS behavior | native | known glitches on scroll-during-animation |
| API surface | `transition: ... cubic-bezier(...)` | `<motion.div animate={...}>` |
| Debugging | Devtools animations tab | not inspectable without motion-internal state |

### Migration plan

1. **2026-05-01:** motion@12 stays for 1 week of telemetry data via the `/lab` toggle.
2. **2026-05-08:** telemetry review — if pure CSS is equal or better, a `motion`
   removal PR.
3. **2026-05-15:** the `motion` dependency removed from package.json, code sweep.

ENV: `LAZYOS_SPRING_ENGINE` = `"css"` (default) | `"motion"` (lab toggle).

**Anti-pattern:** a mid-component switch (some motion, some CSS) — forbidden.
One engine per component.

---

## 4. Dark/light anti-patterns

lazyOS is dark-first. Light mode is explicitly out of scope.

### Forbidden

- **`@media (prefers-color-scheme: light)`** without explicit designer sign-off —
  there are no light tokens, so this makes the UI inconsistent.
- **Hardcoded `#fff`/`white`** as a card background — use `var(--sheet-2)` or
  `var(--card-2)`. Exception: UI primitives like the toggle thumb (= `var(--ink)`).
- **`color-mix(... transparent)` for card backgrounds** — the mix causes parent
  bleed (the background shimmers through). Use an opaque token (`var(--sheet-2)`).
  Glass effects with `backdropFilter: blur(...)` are allowed — they need transparency.

### Allowed

- `color-mix` for accent tints: `color-mix(in oklab, var(--a-now) 14%, transparent)`
  (glow, pill background).
- `backdropFilter: blur(...)` with a transparent background — explicit glass
  surface (composer, modals).

---

## 5. Wording glossary

User-facing text (TSX strings, JSX text, aria labels):

| Forbidden | Recommended | Scope |
|-----------|-------------|-------|
| Disagreement | "models disagree" | everywhere |
| Drift | "source deviation" | user-facing (outside `lib/audit/`) |
| Sniper | "direct intervention" | user-facing (outside API routes) |

**Reasoning:** "drift" and "sniper" are code terms (an audit bucket, a hook
pattern). User-facing, they read cold/militaristic. In code they may stay —
script names, API routes, comments.

Audit: `pnpm lint:wording` (informational, exit 0).

Bypass: `// audit-wording-ignore` above the line.

---

## 6. Surface-library requirement

**Pinned (decision 2026-04-29):** NO overlays — use the surface library.

- Existing `lib/ui/cht` + `SurfaceRenderer` + surface tags
- Do not invent sticky/floating cards/modals
- No custom z-index stack — use the existing stack
- No backdrop clones — use `lib/ui/Modal` or existing surface containers

**When unsure:** the surface style guide → `docs/SURFACE-STYLE-GUIDE.md`.

---

## 7. Lint workflow

```bash
# Individually
pnpm lint:surfaces   # inline styles in cards (gradual threshold)
pnpm lint:tokens     # ghost + dead tokens (HARD FAIL on ghosts)
pnpm lint:hex        # hex in TSX (informational)
pnpm lint:wording    # glossary lint (informational)

# Bundle (recommended for CI)
pnpm lint:design     # surfaces + tokens + hex
```

**CI integration:** the pre-commit hook uses `lint:design`, with an ENV override
per wave:

```yaml
env:
  LAZYOS_SURFACE_LINT_THRESHOLD: 200  # wave 1
```

---

## Ownership

- **Token hierarchy & spacing:** senior-dev + design team
- **Spring decision:** code-reviewer (telemetry audit), critic (final approval)
- **Wording glossary:** content ops, approved by the product owner
- **Lint scripts:** `scripts/audit-*.ts` — maintained by whoever writes the script

On conflicts: STICKY memory > standards > this file.
