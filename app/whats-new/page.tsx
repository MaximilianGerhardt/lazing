/**
 * /whats-new — public release-notes page
 * --------------------------------------
 * Publicly accessible (no auth gate). Shows what is new since the 2026-05-01
 * cutover. User-facing, concise, with direct links to /lab + /workflows.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { WhatsNewClient } from "./WhatsNewClient";

export const metadata: Metadata = {
  title: "What's new — laz.ing 2026-05-02",
  description: "Release notes since the 2026-04-30 cutover",
};

export default function WhatsNewPage() {
  return (
    <main className="whatsnew">
      <header className="whatsnew__head">
        <span className="whatsnew__pill">Release · 2026-05-02</span>
        <h1>What&apos;s new</h1>
        <WhatsNewClient />
        <p className="whatsnew__lead">
          62 commits since the cutover. 6 new patterns + the laz.ing brand
          migration + a surface refactor + iOS-native polish + a new{" "}
          <Link href="/lab">/lab</Link> showcase + the Pattern 4{" "}
          <Link href="/workflows">/workflows</Link> DSL.
        </p>
      </header>

      <section className="whatsnew__grid">
        <article className="whatsnew__card">
          <h2>Surface refactor (waves 1–7)</h2>
          <p>
            All chat surface cards moved consistently onto the token system.
            233 → 0 inline-style hits. Asymmetric iMessage bubble tail +
            same-sender clustering without JS. 5 new cards for the
            fitness-loop kinds (auto-dispatch-stage, iterate-roast/-version,
            user-correction, plan-open-questions). Persistence via
            emit-or-update-card → no double rendering on re-mount.
          </p>
          <Link href="/lab" className="whatsnew__cta">
            → Compare in /lab (Live | Refactored | Spring-Compare)
          </Link>
        </article>

        <article className="whatsnew__card">
          <h2>laz.ing brand migration</h2>
          <p>
            The user-facing wordmark moved to <strong>laz.ing</strong>
            (top nav, mobile drawer, onboarding, login, e-mail templates,
            TOTP issuer, PDF metadata, system prompts). Code identifiers
            (LAZYOS_* env vars, DB IDs, systemd units) stay as the legacy
            schema — env rollback via <code>LAZYOS_BRAND_NAME=lazyOS</code>{" "}
            is possible.
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>iOS-native features (waves 5 + 5b)</h2>
          <p>
            3 PWA splash screens for iPhone 14/15/16 Pro/Max + 8 Plus.{" "}
            <code>overscroll-behavior-y: contain</code> prevents the
            pull-to-refresh bounce. A <code>useHaptic</code> hook with 5
            intensities + reduced-motion bail-out. Press-scale on
            interactive elements. The iOS status bar tints itself to the
            workspace accent on org switch.
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>/lab showcase + spring-stack toggle</h2>
          <p>
            <Link href="/lab">/lab</Link> is the new URL for the design
            showcase, using real data from your workspaces. 5 MVP kinds × 6
            tabs (Live | Refactored | Real-Use | Diff | Tokens |
            Spring-Compare). In the Spring tab you compare a pure-CSS
            cubic-bezier against a motion library side by side.
          </p>
          <p className="whatsnew__hint">
            <strong>Login required</strong> with an admin/founder membership.
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>Pattern 4 workflow DSL</h2>
          <p>
            <Link href="/workflows">/workflows</Link> offers codified
            methodology as TypeScript state machines. Fully implemented:
            dev-sprint with 7 states (plan → critic → consolidate →
            impl-spawn → review → deploy-gate → closeout). 4 stubs for
            litigation-brief, field-measurement, design-gate-flow and
            legal-correspondence. The FSM graph renders as an SVG. Run detail
            with history + manual override.
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>Reasoning patterns (P1–P16)</h2>
          <p>
            Reasoning audit (Stanford 1/6 hallucination detection) + a drift
            cron with 4 API routes. Deterministic consensus detection via a{" "}
            <code>consensus_meta</code> YAML block + server recompute.
            Digital twin (~80% token saving in sub-spawns). RAG source router.
            Devil&apos;s-advocate confirmation-bias counter. Real unlearn
            (retry-sniper + reflection push). Constraint-as-enabler reframing.
            Per-workspace sandbox mode (4 wire points active). Source-chips UI
            in sniper-inject. Daily indexer coverage audit.
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>GDPR privacy sprint</h2>
          <p>
            5 vetoes from the critic sweep fixed: a twin cross-workspace leak
            (sensitive topics leaked into client spawns), audit-full-prompts
            persistence blocked in high-sensitivity workspaces, an auth gate
            on /reasoning-audit, robots.txt + noindex, sandbox-mode wiring
            (auto-approve only when sensitivity=low), and 6 systemd-timer
            install scripts prepared (user decision).
          </p>
        </article>

        <article className="whatsnew__card">
          <h2>Operational improvements</h2>
          <p>
            DB separation live ↔ staging via <code>LAZYOS_DB_PATH</code>.
            Magic-link origin via X-Forwarded-Host (tunnel fix).
            Single-user allow-list via <code>LAZYOS_ALLOWED_EMAILS</code>.
            DB token redaction. Workspace-switch bug in /lab + an
            org-switcher hierarchy bug (sub-orgs) fixed.
          </p>
        </article>
      </section>

      <section className="whatsnew__footer">
        <h2>How to try it</h2>
        <ol>
          <li>
            Log in at <Link href="/login">/login</Link> (magic link — check
            your spam folder)
          </li>
          <li>
            Open <Link href="/lab">/lab</Link> — the sidebar shows 5 surface
            kinds
          </li>
          <li>
            Click <code>auto-dispatch-stage</code> → 6 tabs
            (Live/Refactored/Real-Use/Diff/Tokens/Spring-Compare)
          </li>
          <li>
            <strong>Spring-Compare</strong> tab: press the replay button →
            both cards re-animate, pure CSS on the left, motion library on the
            right
          </li>
          <li>
            Open <Link href="/workflows">/workflows</Link> → look at the 5
            workflow cards (dev-sprint is clickable with an FSM graph)
          </li>
          <li>
            Switch to any workspace (top-nav org switcher) → the iOS status
            bar tints to the workspace accent
          </li>
          <li>Install the PWA on an iPhone → the splash screen appears</li>
        </ol>

        <h2>Docs</h2>
        <ul>
          <li>
            <a
              href="https://github.com/MaximilianGerhardt/lazing/blob/main/docs/design-system-overview.md"
              target="_blank"
              rel="noopener"
            >
              Design-system overview
            </a>{" "}
            — tokens, cards, conventions
          </li>
          <li>
            <a
              href="https://github.com/MaximilianGerhardt/lazing/blob/main/docs/SURFACE-STYLE-GUIDE.md"
              target="_blank"
              rel="noopener"
            >
              Surface style guide
            </a>{" "}
            — SOPs for the card refactor
          </li>
          <li>
            <a
              href="https://github.com/MaximilianGerhardt/lazing/blob/main/docs/surface-overview.md"
              target="_blank"
              rel="noopener"
            >
              Surface overview
            </a>{" "}
            — the catalogue of chat surface kinds
          </li>
        </ul>

        <p className="whatsnew__small">
          Branch: <code>main</code> · 62 commits since the cutover
        </p>
      </section>
    </main>
  );
}
