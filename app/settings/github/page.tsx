/**
 * /settings/github — GitHub-Integration deep-page (Apple-minimal redesign).
 *
 * Visual contract aligns with the Settings-Hub:
 *   - .settings-hub container vocabulary (Pitch-Black, hairlines, SF-Pro)
 *   - Status pill top-right (connected vs not)
 *   - Primary CTA = OAuth (if configured), secondary = PAT-form (collapsible)
 *   - 240ms cubic-bezier transitions inherited from .settings-hub-*
 *
 * Server-side: resolves user → credential → OAuth-availability. The actual
 * connect/list/link interactions stay client-side (GithubSettingsClient).
 */

import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { isOAuthConfigured } from "@/lib/github/oauth";
import { findCredentialForUser } from "@/lib/github/repo";

import GithubSettingsClient from "./GithubSettingsClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "GitHub — laz.ing Settings",
};

interface SearchParams {
  connected?: string;
  error?: string;
  message?: string;
  login?: string;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=github-settings-needs-login");
  }

  const cred = findCredentialForUser(userId);
  const oauthAvailable = isOAuthConfigured();
  const sp = await searchParams;
  const connected = !!cred;

  return (
    <main className="settings-hub" data-testid="settings-github-page">
      <header className="settings-hub-head">
        <p className="settings-hub-eyebrow">
          <Link href="/settings" className="settings-hub-foot-link">
            Einstellungen
          </Link>{" "}
          / GitHub
        </p>
        <h1 className="settings-hub-title">GitHub</h1>
        <p className="settings-hub-lede">
          Link repositories to workspaces. Tokens werden mit AES-256-GCM
          verschlüsselt (Key aus{" "}
          <code className="settings-hub-code">LAZYOS_CREDENTIAL_KEY</code>).
        </p>
      </header>

      {sp.connected === "1" && (
        <div
          data-testid="github-connected-toast"
          className="settings-hub-card"
          style={{
            borderColor: "rgba(74, 222, 128, 0.4)",
            background:
              "linear-gradient(135deg, rgba(74, 222, 128, 0.08), var(--card))",
            marginBottom: "16px",
          }}
        >
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>
            GitHub verbunden{sp.login ? ` als @${sp.login}` : ""}.
          </p>
        </div>
      )}
      {sp.error && (
        <div
          data-testid="github-error-toast"
          className="settings-hub-card"
          style={{
            borderColor: "rgba(248, 113, 113, 0.4)",
            background:
              "linear-gradient(135deg, rgba(248, 113, 113, 0.08), var(--card))",
            marginBottom: "16px",
          }}
        >
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>
            Fehler: {sp.error}
            {sp.message ? ` — ${sp.message}` : ""}
          </p>
        </div>
      )}

      <Suspense
        fallback={
          <p className="settings-hub-muted">Lade Status…</p>
        }
      >
        <GithubSettingsClient
          initialConnected={connected}
          initialLogin={cred?.github_login ?? null}
          initialAvatarUrl={cred?.avatar_url ?? null}
          initialAuthKind={(cred?.auth_kind as "pat" | "oauth") ?? null}
          oauthAvailable={oauthAvailable}
        />
      </Suspense>

      <footer className="settings-hub-foot">
        <Link href="/settings" className="settings-hub-foot-link">
          ← Zurück zu Einstellungen
        </Link>
        <span className="settings-hub-foot-meta">
          AES-256-GCM · Session-isolated
        </span>
      </footer>
    </main>
  );
}
