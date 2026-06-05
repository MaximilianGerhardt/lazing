/**
 * Primary-nav links. Single source of truth — reused by TopNav and the
 * MobileDrawer so they can never drift out of sync.
 *
 * Phase Nav-C (2026-04-28): TopNav zeigt nur eine kleine Liste der
 * tagesaktiven Items (Chat, Inbox). Alles andere lebt im Sandwich-Drawer
 * mit segmentierten Sections (Arbeiten / Organisation / System).
 *
 * 2026-04-30 fix: Unicode glyphs out, SF-Symbol-style SVG icons in
 * (lib/nav/icons.tsx). Apple-pure design instead of an emoji fallback.
 */

import type { ReactNode } from 'react';

import {
  IconCalendar,
  IconChat,
  IconCheck,
  IconHow,
  IconInbox,
  IconObservatory,
  IconOrgActive,
  IconRoutines,
  IconSessions,
  IconSkills,
  IconTickets,
  IconWorkstreams,
} from './icons';

export interface NavLink {
  href: string;
  label: string;
  /**
   * Phase OSS.3 — i18n key (e.g. 'nav.chat'). Server components
   * read the translation via getServerT(), client components via
   * useI18n(). If the key stays empty, `label` is rendered as a
   * fallback (for raw strings without a locale requirement).
   */
  i18nKey?: string;
  /** Short label used when horizontal space is tight (e.g. 768-900px). */
  shortLabel?: string;
  /** SF-Symbol-Style SVG-Icon (currentColor, 1.6 stroke). */
  icon: ReactNode;
}

export interface NavSection {
  id: string;
  label: string;
  /** Phase OSS.3 — i18n key of the section header. */
  i18nKey?: string;
  links: readonly NavLink[];
}

/**
 * Top-level pills — deliberately kept small. Daily anchors.
 */
export const TOP_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Chat', i18nKey: 'nav.chat', icon: <IconChat size={18} /> },
  { href: '/inbox', label: 'Inbox', i18nKey: 'nav.inbox', icon: <IconInbox size={18} /> },
] as const;

/**
 * Sandwich drawer — two calm groups instead of three crowded ones:
 *   Work  = the five daily destinations (what you open every day).
 *   More  = everything occasional/admin, clearly secondary.
 * (2026-06-05 declutter: merged the two Organization entries into one, dropped
 *  the marketing "Features catalog" from the daily menu, English-first labels.)
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'work',
    label: 'Work',
    i18nKey: 'nav.section.work',
    links: [
      { href: '/', label: 'Chat', i18nKey: 'nav.chat', icon: <IconChat size={18} /> },
      { href: '/inbox', label: 'Inbox', i18nKey: 'nav.inbox', icon: <IconInbox size={18} /> },
      { href: '/workstreams', label: 'Workstreams', i18nKey: 'nav.workstreams', icon: <IconWorkstreams size={18} /> },
      { href: '/decisions', label: 'Decisions', i18nKey: 'nav.decisions', icon: <IconCheck size={18} /> },
      { href: '/calendar', label: 'Calendar', i18nKey: 'nav.calendar', icon: <IconCalendar size={18} /> },
    ],
  },
  {
    id: 'more',
    label: 'More',
    i18nKey: 'nav.section.more',
    links: [
      { href: '/tickets', label: 'Tickets', i18nKey: 'nav.tickets', icon: <IconTickets size={18} /> },
      { href: '/routines', label: 'Routines', i18nKey: 'nav.routines', icon: <IconRoutines size={18} /> },
      { href: '/skills', label: 'Skills', i18nKey: 'nav.skills', icon: <IconSkills size={18} /> },
      { href: '/agents', label: 'Agents', i18nKey: 'nav.agents', icon: <IconSkills size={18} /> },
      { href: '/orgs', label: 'Organization', i18nKey: 'nav.orgs', icon: <IconOrgActive size={18} /> },
      { href: '/sessions', label: 'Sessions', i18nKey: 'nav.sessions', icon: <IconSessions size={18} /> },
      { href: '/observatory', label: 'Observatory', i18nKey: 'nav.observatory', icon: <IconObservatory size={18} /> },
      { href: '/how', label: 'Guide', i18nKey: 'nav.how', icon: <IconHow size={18} /> },
    ],
  },
] as const;

/**
 * Backwards-compat: NAV_LINKS stays as a flat aggregation, in case
 * someone still accesses it somewhere (e.g. a coverage audit).
 */
export const NAV_LINKS: readonly NavLink[] = NAV_SECTIONS.flatMap(
  (s) => s.links,
);
