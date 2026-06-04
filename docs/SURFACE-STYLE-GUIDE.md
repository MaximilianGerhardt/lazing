# Surface style guide

> SOP for chat-surface cards in laz.ing.
> Required reading before adding new cards in `lib/chat/*Card.tsx`.

This guide is the **operative specification** for all surfaces rendered in the
chat stream as a "loud card" or "quiet inline". It is the interface between
design intent (iMessage/Apple-pure) and code discipline (token-bound, no inline
style).

If you build a new card or touch an existing one and you are unsure:
**read here first, then code.**

---

## A. When to use which token?

Tokens live in `app/globals.css` and are referenced via `var(--name)`. Inline
values (e.g. `borderRadius: 18`) are **forbidden** — see section E.

### A.1 Radius steps

| Token | Value | When to use |
|---|---|---|
| `--radius-xs` | 5px | Slider thumbs, mini-pills, inline badges |
| `--radius-sm` | 10px | Standard buttons, input fields, chips |
| `--radius-md` | 14px | Card inner sections (inside an outer card) |
| `--radius-lg` | 18px | Card outer (quiet cards, standard surfaces) |
| `--radius-xl` | 24px | Hero cards (milestone, decision, consensus) |
| `--radius-pill` | 100px | Pill buttons, status badges, engine tags |

Rule of thumb: **loud cards = `--radius-xl`**, **quiet cards = `--radius-lg`**,
**inner sections = `--radius-md`**. Never mix in `borderRadius: 12` or similar —
if a value is missing, propose a new token instead of hardcoding.

### A.2 Spring stack

| Token | Easing | When |
|---|---|---|
| `--spring-snappy` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for sheet-in, hover-reveal, general mounting |
| `--spring-smooth` | `cubic-bezier(0.32, 0.72, 0, 1)` | iMessage bubble pop (warmer than snappy) |
| `--spring-bouncy` | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` | Hero mount, top-nav pop, anything where overshoot is wanted |
| `--spring-precise` | `cubic-bezier(0.4, 0, 0.2, 1)` | Material-style linear, for press/hover color swaps |

Rule of thumb: **card mount = `bouncy`**, **bubble pop = `smooth`**,
**press feedback = `precise`**, everything else = `snappy`.

### A.3 Duration

| Token | Value | When |
|---|---|---|
| `--dur-instant` | 80ms | Press feedback, active-state flash |
| `--dur-quick` | 140ms | Hover, color swap, tooltip reveal |
| `--dur-base` | 220ms | Card mount, default transition |
| `--dur-slow` | 360ms | Sheet-in, modal reveal, fade |
| `--dur-glacial` | 600ms | Hero pop, choreographed sequences |

### A.4 Press scale

| Token | Value | When |
|---|---|---|
| `--press-scale` | 0.96 | Default for clickable buttons |
| `--press-scale-strong` | 0.92 | Hero CTA, primary action in a loud card |

Pattern (CSS):
```css
.srf-foo__cta:active {
  transform: scale(var(--press-scale));
  transition: transform var(--dur-instant) var(--spring-precise);
}
```

---

## B. Bubble tokens (iMessage look)

Bubble tokens are **only** relevant in `lib/chat/Bubble*.tsx` and the composer —
not for surface cards. Documented here anyway because quiet cards can dock onto
bubbles.

| Token | Value | When |
|---|---|---|
| `--bubble-radius` | 18px | Standard bubble corner |
| `--bubble-tail-radius` | 6px | Asymmetric tail corner (sender/receiver side) |
| `--bubble-padding` | 10px 14px | Standard inner spacing |
| `--bubble-padding-compact` | 6px 10px | Inline action bubbles, status pings |
| `--bubble-gap-same-sender` | 4px | Cluster (same sender, no new stack) |
| `--bubble-gap-new-sender` | 14px | Stack change (different sender / new topic) |
| `--bubble-max` | 560px | Max width for readability |

Same-sender clustering happens **automatically via CSS** (the `+` selector in
`app/components.css`) — no React state needed. If you set bubble spacing
manually, you are doing something wrong.

---

## C. iOS-native patterns

laz.ing is also installed as an iOS PWA. These patterns are not optional —
Apple-pure means: **the same surface feels native.**

### C.1 Safe area

Tokens (set in `app/globals.css` via `env(safe-area-inset-*)`):

- `--safe-top` — notch / dynamic island
- `--safe-bottom` — home indicator
- `--safe-left`, `--safe-right` — landscape notch

Pattern:
```css
.srf-composer {
  padding-bottom: max(12px, var(--safe-bottom));
  padding-left: max(12px, var(--safe-left));
}
```

Never set `padding-bottom: 0` without accounting for the safe area — otherwise
the home indicator clips the composer.

### C.2 Composer clearance

If your surface renders under the fixed composer (end of the chat stream):
```css
.srf-stream {
  padding-bottom: var(--composer-clearance);
}
```

Composer height + safe-bottom + breathing space are factored in here.

### C.3 Splash screen / app icon

In `app/layout.tsx`, `appleStartupImage` must be defined for every iOS device
class. If you need a new splash (e.g. a dark-mode variant):

1. Place the asset in `public/splash/`.
2. Add an entry to the `appleStartupImage` array (alphabetical by device class).
3. Test manually on an iPhone — the simulator shows the splash unreliably.

### C.4 Haptic hook

Use `useHaptic()` from `lib/ios/useHaptic.ts` for important user actions:

```tsx
const haptic = useHaptic();

<button
  className="srf-milestone__cta"
  onClick={() => {
    haptic('success');
    onConfirm();
  }}
>
```

Available strengths: `'light' | 'medium' | 'heavy' | 'success' | 'warning'`.

**When to trigger?** On every destructive action (`heavy`/`warning`), approval
(`success`), toggle (`light`). Never on pure hover effects.

---

## D. Surface-card pattern

All new surfaces follow this pattern. Example: `srf-milestone`.

### D.1 Class naming (BEM-like)

- Container: `.srf-{kind}` — e.g. `.srf-milestone`
- Children: `.srf-{kind}__{element}` — e.g. `.srf-milestone__header`
- Modifier: `.srf-{kind}--{variant}` — e.g. `.srf-milestone--compact`

Never use generic classes like `.card`, `.row`, `.title` — they collide with
other surfaces. Always prefixed.

### D.2 Container defaults

```css
.srf-{kind} {
  max-width: 560px;
  border: 0.5px solid var(--line-2);
  background: var(--sheet-2);
  border-radius: var(--radius-xl);   /* or -lg for quiet */
  animation: srf-pop var(--dur-base) var(--spring-bouncy) both;
}
```

`@keyframes srf-pop` is defined globally in `app/components.css`. A custom
mount animation? **No** — use srf-pop. The only exception is hero surfaces with
choreography, which must then be documented separately.

### D.3 Reduced motion

All surface cards respect `prefers-reduced-motion`. Global block in
`app/components.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .srf-milestone, .srf-subws, .srf-iterate, .srf-pipeline, .srf-consensus {
    animation: none;
  }
}
```

**When you create a new surface, add its class to this block.**

---

## E. The inline-style ban

### E.1 Forbidden in `lib/chat/*Card.tsx`

```tsx
// ❌ DO NOT
<div style={{ padding: 20, borderRadius: 16, fontSize: 14 }}>

// ✅ INSTEAD
<div className="srf-foo">
```

**Forbidden properties** (checked via `audit-inline-styles.ts`):

- `borderRadius`
- `fontSize`
- `padding` (all variants: paddingTop, paddingLeft, ...)
- `margin` (all variants)

### E.2 Exceptions — `surface-lint-ignore`

Dynamically computed values (width from props, color per variant, layout from
runtime data) may be set inline. Required: a marker comment on the line directly
above:

```tsx
// surface-lint-ignore — dynamic width depending on score
<div style={{ width: `${score}%` }} />
```

The linter then skips the hit. Misuse is called out in PRs — the marker is for
**real** dynamics, not for circumventing the token requirement.

### E.3 Pre-push linter

```bash
pnpm lint:surfaces       # surface lint only
pnpm lint:all            # tsc + surface lint
```

Threshold via ENV (gradual migration):
```bash
LAZYOS_SURFACE_LINT_THRESHOLD=20 pnpm lint:surfaces
```

**Run manually before every push** (see CONTRIBUTING.md, section
"Chat surface cards"). Husky auto-install is not part of the repo — no side
effect on `pnpm install`.

---

## F. Apple-pure checklist

Go through this before every surface-card PR:

- [ ] Border radius exclusively via a token (`--radius-*`)
- [ ] Spring easing for all animations (no `ease`, no `linear`)
- [ ] Press scale on all clickable elements
- [ ] Safe-area inset for the bottom composer / floating elements
- [ ] Haptic hook on important user actions (approval, destructive, toggle)
- [ ] iMessage tail on chat bubbles (`--bubble-tail-radius`)
- [ ] Same-sender clustering automatically via CSS (`+` selector, no state)
- [ ] `prefers-reduced-motion` respected (class added to the global block)
- [ ] No inline `borderRadius`/`fontSize`/`padding`/`margin`
- [ ] `pnpm lint:surfaces` clean (or the threshold documented)

---

## G. What stays explicitly NOT Apple-pure?

Some identity markers are **deliberately** lazyOS-specific and not iOS-native.
Do not "fix" them:

- **Workspace accent colors** (`--a-north`, `--a-clientb`, `--a-own`,
  `--a-private`) — our own system for multi-workspace disambiguation. Apple does
  not have this, but we need it.
- **Engine badges** (`--e-claude`, `--e-codex`, `--e-local`) — they visualize
  which AI engine answered. Vendor-specific, stays.
- **Pitch-black background** (`--sheet: #070707`) — the lazyOS identity, not the
  iOS default dark (which is closer to `#1c1c1e`). A deliberate deviation.
- **Sniper-inject UI** (countdown pill, pause card) — does not exist on iOS like
  this. An architectural primitive of lazyOS.

If you want to "improve" these → discuss it in the PR description first, do not
just switch to iOS defaults.

---

## Appendix: migration workflow for existing cards

When you refactor an existing card:

1. Read the card completely.
2. Identify all inline styles → write the class counterpart in
   `app/components.css` as `.srf-{kind}` and `.srf-{kind}__{el}`.
3. Replace the inline styles with `className="srf-{kind}__{el}"`.
4. Add the reduced-motion block.
5. `pnpm lint:surfaces` locally — the hit count must drop.
6. `npx tsc --noEmit` clean.
7. Commit: `refactor(srf): {kind} - tokens + classes`.

For larger refactors: do one small card as a pilot first, then transfer the
pattern.
