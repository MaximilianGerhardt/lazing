/**
 * GitHub REST client for laz.ing.
 *
 * Two modes:
 *   - PAT (Personal Access Token) — primary path. User pastes the token
 *     once, we store it AES-256-GCM-encrypted (re-use of
 *     `lib/security/credentials.ts:encryptCredential`).
 *   - OAuth — secondary. Only when `LAZYOS_GITHUB_CLIENT_ID` +
 *     `LAZYOS_GITHUB_CLIENT_SECRET` are set. See `oauth.ts`.
 *
 * Backport from Lazing-V2 `packages/adapters/src/github/transports/`
 * — we extract only the functions we need here (validate,
 * list-repos). The issue/PR/comment surface is Agent 4-7 (Realtime).
 *
 * Design decision: no Octokit dep. Plain `fetch` suffices for the
 * 3 endpoints we hit here (GET /user, GET /user/repos,
 * GET /repos/:owner/:repo). Saves 1.8MB bundle + transitive deps.
 *
 * Rate limit: GitHub allows 5000 calls/h for authenticated requests.
 * We do NOT cache — every list fetches live (for the UI "Sync" button).
 */

import { decryptCredential } from "@/lib/security/credentials";

const GITHUB_API = "https://api.github.com";
const UA = "lazyos/0.1 (+https://laz.ing)";

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly githubMessage: string,
  ) {
    super(`GitHub API ${status} on ${endpoint}: ${githubMessage}`);
    this.name = "GitHubApiError";
  }
}

export interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  type: "User" | "Organization" | string;
}

export interface GitHubRepoInfo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  updatedAt: string;
  pushedAt: string | null;
}

/**
 * Decrypts the stored token. Throws if the credential key is missing
 * (so the caller can return a 503 with a clear error).
 */
export function decryptGithubToken(encrypted: string): string {
  return decryptCredential(encrypted);
}

/** Common header builder. */
function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
}

async function parseError(res: Response, endpoint: string): Promise<GitHubApiError> {
  let msg = res.statusText;
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body?.message === "string") msg = body.message;
  } catch {
    // body not JSON — keep statusText.
  }
  return new GitHubApiError(res.status, endpoint, msg);
}

/**
 * GET /user — validates the token and returns user info.
 *
 * Use this:
 *   1. On Connect (after the user pastes a PAT, before saving).
 *   2. On Reveal (to show "still valid" badge in UI).
 *   3. As a smoke-test endpoint.
 */
export async function validateToken(token: string): Promise<GitHubUserInfo> {
  const endpoint = "/user";
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    method: "GET",
    headers: authHeaders(token),
    // Hard timeout — GitHub usually responds in <500ms.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await parseError(res, endpoint);
  const data = (await res.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    type: string;
  };
  return {
    id: data.id,
    login: data.login,
    name: data.name ?? null,
    avatarUrl: data.avatar_url ?? null,
    type: data.type as GitHubUserInfo["type"],
  };
}

/**
 * GET /user/repos — lists repos the user has access to.
 *
 * Pagination: GitHub returns max 100 per page. For the laz.ing UI we
 * fetch the first 100 sorted by updated_at desc — that covers 99% of
 * actively-used repos. If the user has more, they can paste the
 * `owner/repo` directly into the Link-Repo form.
 */
export async function listUserRepos(
  token: string,
  options: { perPage?: number; affiliation?: string } = {},
): Promise<GitHubRepoInfo[]> {
  const perPage = Math.min(Math.max(options.perPage ?? 100, 1), 100);
  const affiliation = options.affiliation ?? "owner,collaborator,organization_member";
  const params = new URLSearchParams({
    sort: "updated",
    direction: "desc",
    per_page: String(perPage),
    affiliation,
  });
  const endpoint = `/user/repos?${params.toString()}`;
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    method: "GET",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await parseError(res, endpoint);
  const data = (await res.json()) as Array<{
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
    html_url: string;
    description: string | null;
    default_branch: string;
    private: boolean;
    fork: boolean;
    archived: boolean;
    updated_at: string;
    pushed_at: string | null;
  }>;
  return data.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    htmlUrl: r.html_url,
    description: r.description,
    defaultBranch: r.default_branch ?? "main",
    isPrivate: !!r.private,
    isFork: !!r.fork,
    isArchived: !!r.archived,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at,
  }));
}

/**
 * GET /repos/:owner/:repo — verifies a single repo exists + user has
 * read-access. Used by the Link-Repo endpoint to enrich the picked
 * `owner/repo` with default_branch + private flag before insert.
 */
export async function fetchRepo(
  token: string,
  fullName: string,
): Promise<GitHubRepoInfo> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`fetchRepo: invalid full_name "${fullName}", expected "owner/repo"`);
  }
  const endpoint = `/repos/${owner}/${repo}`;
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    method: "GET",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await parseError(res, endpoint);
  const r = (await res.json()) as {
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
    html_url: string;
    description: string | null;
    default_branch: string;
    private: boolean;
    fork: boolean;
    archived: boolean;
    updated_at: string;
    pushed_at: string | null;
  };
  return {
    id: r.id,
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    htmlUrl: r.html_url,
    description: r.description,
    defaultBranch: r.default_branch ?? "main",
    isPrivate: !!r.private,
    isFork: !!r.fork,
    isArchived: !!r.archived,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at,
  };
}

/** Validate a `owner/repo` string client + server side. */
export function isValidRepoFullName(fullName: string): boolean {
  // GitHub allows alphanumerics, hyphens, underscores, dots. Owner ≤ 39,
  // repo ≤ 100. We're lenient (the API will reject anything we miss).
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(fullName);
}

/** Mask a PAT for UI display ("ghp_••••••AbCd"). */
export function maskToken(token: string): string {
  if (!token) return "";
  const head = token.slice(0, 4);
  const tail = token.slice(-4);
  return `${head}${"•".repeat(8)}${tail}`;
}
