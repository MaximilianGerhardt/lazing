/**
 * /settings — Settings-Hub (user directive 2026-05-23).
 *
 * Replaces the gear-icon → /design redirect.
 *
 * Sections (in order):
 *   1. Account               — email, sign-out
 *   2. Engines               — claude-cli / codex / ollama availability + default
 *   3. GitHub                — connection state + Connect-CTA + linked repos count
 *   4. Push Notifications    — subscription state + Subscribe-CTA + test send
 *   5. Email                 — provider (console / Resend) + ENV state
 *   6. Workspace             — current workspace + link to Workspace-Switcher
 *   7. Advanced              — DB path, version, debug info
 *   8. Design Library        — Footer-link to /design (old gear-destination)
 *
 * Design: Apple-minimal Jobs/Rams. Pitch-Black, subtle `--card` panels,
 * one primary CTA per section. Status-Badge per section
 * ( ready /  setup-needed /  disabled — but rendered as text "Bereit"
 * etc., never emoji, per brand rule "no emoji unless asked").
 *
 * The page itself is a Server-Component that pre-computes server-side
 * knowable state (currentUser, github-credential, engine-availability,
 * email-provider, workspace-id). Client-side state (push-subscription
 * which is browser-only) lives in <SettingsHubClient/>.
 *
 * Auth: redirects to /login if no userId. Consistent with /settings/github.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findCredentialForUser } from "@/lib/github/repo";
import { isOAuthConfigured } from "@/lib/github/oauth";
import { detectEngines } from "@/lib/llm/engines";

import SettingsHubClient from "./SettingsHubClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Einstellungen — laz.ing",
};

export default async function SettingsHubPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=settings-needs-login");
  }

  // ─── Server-knowable pre-state ─────────────────────────────────────
  const githubCred = findCredentialForUser(userId);
  const oauthAvailable = isOAuthConfigured();

  // Engine matrix — uses the same /api/system/engines source-of-truth.
  // We pass the cached snapshot to the client so the page renders
  // instantly; a "Aktualisieren"-button on the Engines section forces
  // a fresh probe via ?fresh=1.
  let engineSnapshot: Awaited<ReturnType<typeof detectEngines>> | null = null;
  try {
    engineSnapshot = await detectEngines({ forceProbe: false });
  } catch {
    // engines unavailable — surfaces as "engine-detect-failed" in the UI
    engineSnapshot = null;
  }

  // Email provider — env-only, no DB. Match lib/email/send.ts vocab.
  const emailProviderRaw = (process.env.LAZYOS_EMAIL_PROVIDER ?? "console").toLowerCase();
  const resendKeyPresent = !!(
    process.env.RESEND_API_KEY ?? process.env.LAZYOS_RESEND_API_KEY
  );

  // Push — VAPID public key is the gate. If unset, push is hard-off.
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  // Advanced — version + db path (best-effort; ENV-only).
  const advanced = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    dbPath: process.env.LAZYOS_DB_PATH ?? "(default db/lazyos.sqlite)",
    pushSecretSet: !!process.env.LAZYOS_PUSH_SECRET,
    brandName: process.env.LAZYOS_BRAND_NAME ?? "laz.ing",
  };

  return (
    <main className="settings-hub" data-testid="settings-hub">
      <header className="settings-hub-head">
        <p className="settings-hub-eyebrow">Einstellungen</p>
        <h1 className="settings-hub-title">laz.ing Konfiguration</h1>
        <p className="settings-hub-lede">
          Alles an einem Ort. Jede Sektion zeigt, was bereits läuft —
          und genau einen primären Schritt, falls noch etwas zu tun ist.
        </p>
      </header>

      <SettingsHubClient
        userId={userId}
        github={{
          connected: !!githubCred,
          login: githubCred?.github_login ?? null,
          authKind: (githubCred?.auth_kind as "pat" | "oauth" | undefined) ?? null,
          oauthAvailable,
        }}
        engines={engineSnapshot}
        email={{
          provider: emailProviderRaw,
          resendKeyPresent,
        }}
        push={{
          vapidPublicKey,
        }}
        advanced={advanced}
      />

      <footer className="settings-hub-foot">
        <Link
          href="/design"
          className="settings-hub-foot-link"
          data-testid="settings-design-library-link"
        >
          Design-Bibliothek →
        </Link>
        <span className="settings-hub-foot-meta">
          Komponenten · Tokens · Visual-Manifest
        </span>
      </footer>
    </main>
  );
}
