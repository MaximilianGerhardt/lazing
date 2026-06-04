/**
 * Phase OS.4 / AU.0 — Workspace→Org Auto-Suggest.
 *
 * Liefert für eine Workspace-ID einen Org-Vorschlag plus Begründung. Der
 * Vorschlag ist NICHT autoritativ — er wird im WorkspaceEditor als sanfter
 * Hint angezeigt und vom User bestätigt (oder ignoriert).
 *
 * Quelle der Mappings:
 *   - Default-Set ist leer (Open-Source-default).
 *   - Optional: `data/org-suggestions.json` (gitignored). Wird beim ersten
 *     Aufruf geladen + gecacht. Format:
 *       {
 *         "exact": { "demo-client": { "orgId": "demo-pv", "reason": "..." } },
 *         "prefixes": [{ "prefix": "example-app-", "orgId": "example-app-org",
 *                        "reason": "..." }]
 *       }
 *
 * Wir filtern später clientseitig auf Orgs in denen der User Mitglied ist —
 * Vorschläge die der User nicht zuordnen darf werden ausgeblendet.
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

/** Test-Helper: leere den Cache, damit Tests neue Configs laden können. */
export function _resetSuggestCache(): void {
  cached = null;
}
