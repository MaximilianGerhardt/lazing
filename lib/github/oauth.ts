/**
 * GitHub OAuth flow — secondary path (PAT is primary).
 *
 * Activation requires:
 *   - LAZYOS_GITHUB_CLIENT_ID
 *   - LAZYOS_GITHUB_CLIENT_SECRET
 *   - LAZYOS_GITHUB_OAUTH_CALLBACK (e.g. http://127.0.0.1:4200/api/auth/github/callback)
 *
 * If any is missing, `isOAuthConfigured()` returns false and the UI
 * only shows the PAT-flow. This is intentional — laz.ing's primary
 * user (Max) already has `gh` CLI authenticated; PAT-paste is a 10s
 * UX vs. OAuth-app-registration which is a 5min-setup-per-deploy.
 *
 * State-token protection: we mint a random `state` per OAuth init,
 * stash it in an httpOnly session cookie, and require it back from
 * the callback. Without that, a malicious referer could trick the
 * callback into binding their token to our user.
 */

const SCOPES = ["repo", "read:user", "user:email"] as const;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export function readOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.LAZYOS_GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.LAZYOS_GITHUB_CLIENT_SECRET?.trim();
  const callbackUrl = process.env.LAZYOS_GITHUB_OAUTH_CALLBACK?.trim();
  if (!clientId || !clientSecret || !callbackUrl) return null;
  return { clientId, clientSecret, callbackUrl };
}

export function isOAuthConfigured(): boolean {
  return readOAuthConfig() !== null;
}

/**
 * Build the GitHub OAuth-init URL. The `state` is the random token we
 * mint server-side and store in the session cookie.
 */
export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: SCOPES.join(" "),
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface ExchangeResult {
  accessToken: string;
  scope: string;
  tokenType: string;
  /** Some GH installations return refresh tokens; classic OAuth apps don't. */
  refreshToken: string | null;
  /** epoch-ms when the access token expires; null if non-expiring. */
  expiresAt: number | null;
}

/**
 * Exchange the `code` query param for an access token. GitHub's
 * /login/oauth/access_token returns either JSON (when we send
 * Accept: application/json) or form-encoded otherwise.
 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<ExchangeResult> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "lazyos/0.1 (+https://laz.ing)",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`OAuth-Exchange fehlgeschlagen (HTTP ${res.status})`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    throw new Error(
      `GitHub OAuth: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`,
    );
  }
  if (!data.access_token) {
    throw new Error("OAuth-Exchange: kein access_token zurückgegeben");
  }
  const expiresAt =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? Date.now() + data.expires_in * 1000
      : null;
  return {
    accessToken: data.access_token,
    scope: data.scope ?? "",
    tokenType: data.token_type ?? "bearer",
    refreshToken: data.refresh_token ?? null,
    expiresAt,
  };
}
