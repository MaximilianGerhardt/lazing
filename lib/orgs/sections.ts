/**
 * Phase IA — shared section definitions for the org-segmented
 * workspace list. Used by /orgs/[id] (default tab) and /orgs/manage
 * as well as the historical /orgs (now a redirect).
 *
 * Ordering: own projects (holding & own products) → clients →
 * internal tools → private → other.
 */

export interface SectionDef {
  key: string;
  title: string;
  hint: string;
  match: (type: string) => boolean;
}

export const SECTION_DEFS: ReadonlyArray<SectionDef> = [
  {
    key: 'own',
    title: 'Eigenprojekte',
    hint: 'Die Holding und ihre Produkte — eigene Marken.',
    match: (t) => t === 'company' || t === 'product',
  },
  {
    key: 'clients',
    title: 'Kunden',
    hint: 'Externe Auftraggeber, jeweils ein eigener Container.',
    match: (t) => t === 'client',
  },
  {
    key: 'tools',
    title: 'Tools',
    hint: 'Interne Werkzeuge ohne eigene Markenidentität.',
    match: (t) => t === 'tool',
  },
  {
    key: 'private',
    title: 'Privat',
    hint: 'Persönliche Workspaces ohne Geschäftsbezug.',
    match: (t) => t === 'private',
  },
];

/**
 * Picks the section key for a workspace type. `null` if no
 * SECTION_DEF matched (= "other").
 */
export function pickSectionKey(type: string): string | null {
  const def = SECTION_DEFS.find((d) => d.match(type));
  return def ? def.key : null;
}

/**
 * Groups a list into `{section: items}`. Items without a section land
 * under `__other__`. Preserves input order within each section.
 */
export function groupBySectionByType<T extends { type: string }>(
  items: ReadonlyArray<T>,
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const def of SECTION_DEFS) out[def.key] = [];
  out.__other__ = [];
  for (const item of items) {
    const key = pickSectionKey(item.type) ?? '__other__';
    out[key]!.push(item);
  }
  return out;
}
