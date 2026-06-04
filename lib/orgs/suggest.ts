/**
 * Phase OS.4 / AU.0 — workspace→org auto-suggest.
 *
 * Returns an org suggestion plus rationale for a workspace ID. The
 * suggestion is NOT authoritative — it is shown in the WorkspaceEditor as a gentle
 * hint and confirmed (or ignored) by the user.
 *
 * Source of the mappings:
 *   - The default set is empty (open-source default).
 *   - Optional: `data/org-suggestions.json` (gitignored). Loaded + cached on the
 *     first call. Format:
 *       {
 *         "exact": { "demo-client": { "orgId": "demo-pv", "reason": "..." } },
 *         "prefixes": [{ "prefix": "example-app-", "orgId": "example-app-org",
 *                        "reason": "..." }]
 *       }
 *
 * Later we filter client-side to orgs the user is a member of —
 * suggestions the user may not assign are hidden.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface OrgSuggestion {
  orgId: string;
  reason: string;
}

interface PrefixRule {
  prefix: string;
  orgId: string;
  reason: string;
}

interface SuggestionsConfig {
  exact: Record<string, OrgSuggestion>;
  prefixes: PrefixRule[];
}

const EMPTY: SuggestionsConfig = { exact: {}, prefixes: [] };

let cached: SuggestionsConfig | null = null;

function loadConfig(): SuggestionsConfig {
  if (cached) return cached;
  const configPath = path.join(
    process.cwd(),
    'data',
    'org-suggestions.json',
  );
  if (!existsSync(configPath)) {
    cached = EMPTY;
    return cached;
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SuggestionsConfig>;
    cached = {
      exact:
        parsed.exact && typeof parsed.exact === 'object'
          ? (parsed.exact as Record<string, OrgSuggestion>)
          : {},
      prefixes: Array.isArray(parsed.prefixes) ? parsed.prefixes : [],
    };
    return cached;
  } catch {
    cached = EMPTY;
    return cached;
  }
}

export function suggestOrgForWorkspace(
  workspaceId: string,
): OrgSuggestion | null {
  const cfg = loadConfig();
  const exact = cfg.exact[workspaceId];
  if (exact) return exact;
  for (const rule of cfg.prefixes) {
    if (workspaceId.startsWith(rule.prefix)) {
      return { orgId: rule.orgId, reason: rule.reason };
    }
  }
  return null;
}

/** Test helper: clear the cache so tests can load new configs. */
export function _resetSuggestCache(): void {
  cached = null;
}
