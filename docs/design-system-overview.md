# Design-system overview — laz.ing

A general introduction to the app's UI design. As of 2026-05-02.

## 1. Brand identity

- **Brand name:** `laz.ing` (internal AND external, since the 2026-05-01 migration)
- **Code identifier:** stays `lazyos*` as the legacy schema (DB IDs, env vars
  `LAZYOS_*`, cookies, systemd units)
- **ENV rollback:** `LAZYOS_BRAND_NAME=lazyOS` reverts the user-facing wordmark
  without a code change
- **Background:** pitch-black `#070707` — the laz.ing identity, NOT the iOS
  default black
- **Font stack:** SF Pro Display (hero), SF Pro Text (body), SF Mono (code) with
  system fallbacks

## 2. Token system (CSS vars in app/globals.css)

**125 central tokens** in 8 categories:

### Surfaces (layering)
- `--sheet`, `--sheet-2`, `--sheet-3` — pitch-black with tints
- `--card`, `--card-2`, `--card-3` — card layers (rgba alpha 0.04/0.08/0.12)
- `--glass` — backdrop-filter blur(30px) for modals/drawer

### Typography (ink hierarchy)
- `--ink` (#F5F5F7), `--ink-2/-3/-4` — primary → dimmest text
- `--dim` — meta information

### Radius (canonical)
- `--radius-xs` (5px) — sliders, mini-pills
- `--radius-sm` (10px) — buttons
- `--radius-md` (14px) — card inner, inputs
- `--radius-lg` (18px) — card outer
- `--radius-xl` (24px) — hero cards (e.g. milestone)
- `--radius-pill` (100px) — pills, badges

### Spring easings
- `--spring-snappy` cubic-bezier(0.22, 1, 0.36, 1) — sheet-in
- `--spring-smooth` cubic-bezier(0.32, 0.72, 0, 1) — iMessage bubble pop
- `--spring-bouncy` cubic-bezier(0.2, 0.9, 0.3, 1.2) — hero/top-nav pop
- `--spring-precise` cubic-bezier(0.4, 0, 0.2, 1) — material-style linear

### Duration
- `--dur-instant` 80ms — press feedback
- `--dur-quick` 140ms — hover, color swap
- `--dur-base` 220ms — card mount
- `--dur-slow` 360ms — sheet-in, reveal
- `--dur-glacial` 600ms — hero pop

### Press interaction (iOS tap feedback)
- `--press-scale` 0.96 (default)
- `--press-scale-strong` 0.92 (hero CTA)

### iMessage bubbles
- `--bubble-radius` 18px, `--bubble-tail-radius` 6px (asymmetric)
- `--bubble-padding`, `--bubble-padding-compact`
- `--bubble-gap-same-sender` 4px (cluster), `--bubble-gap-new-sender` 14px (stack)

### Workspace accents (4-segment system)
- `--a-north` (orange #FF9F0A), `--a-clientb` (green #30D158), `--a-own` (purple
  #BF5AF2), `--a-private` (cyan #64D2FF)
- `--a-now` — dynamic via body.classList, depending on the active workspace

### Engine badges
- `--e-claude` (#D97757), `--e-codex` (#10A37F), `--e-local` (#8E8E93)

### Safe area / iOS chrome
- `--safe-top/-bottom/-left/-right` from env(safe-area-inset-*)
- `--composer-clearance` for iOS keyboard padding
- `--notch-height`

### Haptic (hook convention, not CSS)
- `--haptic-light` 8, `--haptic-medium` 14, `--haptic-heavy` 24
- Patterns for success/warning as strings

## 3. Component library (lib/ui/)

### Primitive building blocks (CSS-clean, BEM pattern)
- `lib/ui/cht/` — chat core: Chat, MsgUser, MsgAssistant, MsgCard, MsgSystem, StreamingBubble
- `lib/ui/pil/` — Pill (7 variants)
- `lib/ui/tst/` — Toast, ToastStack
- `lib/ui/dec/` — Decision (multi-option)
- `lib/ui/tck/` — Ticket
- `lib/ui/chr/` — Charts (LineChart, BarChart, Heatmap)
- `lib/ui/qck/` — QuickChoice
- `lib/ui/inv/` — Invoice
- `lib/ui/trm/` — Terminal
- `lib/ui/tbl/` — Tables
- `lib/ui/tmc/` — Teammate (agent card)
- `lib/ui/eng/` — Engine badge
- `lib/ui/doc/` — Document, Folder, CloudBrowser
- `lib/ui/cbd/`, `lib/ui/cmd/`, `lib/ui/hbt/`, `lib/ui/pip/` — more

**Convention:** all UI primitives use `className` composition (no inline style),
BEM-like class names, token binding.

## 4. Chat surfaces (lib/chat/)

**13 dedicated cards for workstream/loop phases:**

| Card | Surface kind(s) |
|---|---|
| MilestoneCard | synthesis |
| ConsensusActionCard | consensus-action |
| IteratePipelineCard | iterate-pipeline |
| LivePipeline | live-pipeline |
| SubWorkstreamsCard | sub-workstreams |
| BugFixSwarmCard | bug-fix-swarm |
| RateLimitRetryCard | rate-limit-retry |
| CredentialPromptCard | credential-prompt |
| FormPromptCard | form |
| LoopPhaseCard | auto-dispatch-stage/-retry/-overview/-pause, tier-output, sniper-pause-start |
| IterateRoastCard | iterate-roast |
| IterateVersionCard | iterate-version, iterate-resumed |
| UserCorrectionCard | user-correction |
| PlanOpenQuestionsCard | plan-open-questions |
| ReasoningTrailCard | reasoning-audit |

**SurfaceRenderer.tsx** maps surface tags `<surface:KIND>{json}</surface:KIND>`
to React components.

**event-to-surface.ts** maps raw events → surface tags.

**emit-or-update-card.ts + loop-card-coords.ts** — the persistence layer: per
coord (workspaceId, workstreamId, surfaceKind, optional discriminators like
stageIdx/versionN/tier+agentIdx/roasterIdx) exactly 1 events row, update-in-place.

## 5. iMessage bubble look

- **Asymmetric tail radii:** the sender (user) has `border-bottom-right-radius: 6px`,
  the assistant `border-bottom-left-radius: 6px`
- **Same-sender cluster:** automatic via CSS `.msg-u + .msg-u .bub` → reduced
  top-radius + smaller gap
- **No JS:** pure CSS only, no React state tracking
- **Streaming caret:** `var(--caret-color-active)` with `lazyos-cursor` keyframes

## 6. Animation stack

**Today:** pure-CSS cubic-bezier with 4 spring tokens. No JS lib (note: if JS,
then motion/react = the Framer successor).

**Showcase in /lab `?tab=spring`:** a side-by-side comparison of CSS vs. the
motion lib so the user can visually decide which iOS-pure feel is more convincing.

**@keyframes inventory (~30 in components.css + globals.css):**
- `srf-pop` (card mount, 8px translateY + scale 0.98→1.0)
- `lazyos-cursor` (streaming-caret blink)
- `lazyos-typing` (3-dot pulse)
- `lazyos-streaming-caret` (StreamingBubble inline)
- 24+ more (top-nav, workflow, composer, mic-pulse)

## 7. iOS-native features

- **Splash screens:** 3 PNGs in `public/apple-touch-startup-image-*.png` for
  iPhone 14/15/16 Pro/Max + 8 Plus
- **Press scale:** the `.press` utility class with `scale(var(--press-scale))` on :active
- **Haptic hook:** `useHaptic()` in `lib/hooks/useHaptic.ts` with 5 intensities +
  reduced-motion bail-out
- **Safe-area insets:** the composer respects `var(--composer-clearance)` for the
  iOS keyboard
- **overscroll-behavior-y: contain** on body — no pull-to-refresh bounce
- **viewport-fit: cover** + status-bar: black-translucent

## 8. Consistency SOPs

- **Inline styles forbidden** in `lib/chat/*Card.tsx` (the pre-push linter
  `pnpm lint:surfaces`)
- **Token-first:** border radius, padding, easing, duration, press scale always
  via a CSS var
- **BEM naming:** `.srf-{kind}` for the container, `.srf-{kind}__{element}` for children
- **Apple-pure checklist** in `docs/SURFACE-STYLE-GUIDE.md`
- **Audit linter** in `scripts/audit-inline-styles.ts` (threshold override via ENV)

## 9. Showcase in /lab

`/lab` (auth admin/founder) shows every surface kind in 6 tabs:
- **Live** — the current card with a mock payload
- **Refactored** — the token-bound version
- **Real-Use** — a real event from the DB (anonymized)
- **Diff** — the inline-style-hits finding
- **Tokens** — the CSS vars in use + a style-guide link
- **Spring-Compare** — CSS vs. the motion library, side by side

5 MVP kinds (auto-dispatch-stage, iterate-roast, sub-workstream, bug-fix-swarm,
synthesis) + 3 pattern archetypes on the landing page (coding/planning/bug-fix).

## 10. Privacy layer

- **High-sensitivity workspaces** are hard-filtered out in /lab + RAG + twin-inject
- **PII patterns:** email, phone, IBAN, VAT-ID via `lib/lab/_lib/redact.ts`
- **Twin cross-workspace filter:** sensitive topics + high-sensitivity projects are
  stripped for low-sensitivity workspaces
- **Reasoning audit:** a high-sensitivity workspace NEVER persists plaintext
  prompts (regardless of the ENV flag)

## 11. Extensions (open)

- **Pattern 4 UI** (`/workflows` page with an FSM graph) — foundation in code, UI
  pending
- Dynamic `themeColor` per segment cookie
- ConsensusActionCard logic splitting into 3 sub-components
- Pattern 4 — flesh out the 4 stub workflows (litigation, field-measurement,
  design-gate, legal-correspondence)

## References

- `docs/SURFACE-STYLE-GUIDE.md` — the SOP document for surface cards
- `docs/surface-overview.md` — the catalogue of chat surface kinds
