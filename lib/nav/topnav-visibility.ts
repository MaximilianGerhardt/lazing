/**
 * Single source of truth for "is the TopNav hidden on this route?".
 *
 * Shared by `TopNav` (which returns null when hidden) and `ScopeTabs`
 * (the global bottom bar), so the bottom bar can decide whether IT must
 * own the MobileDrawer mount on a route. Exactly one MobileDrawer is
 * mounted per route:
 *   - TopNav visible  → TopNav owns the drawer (hamburger trigger).
 *   - TopNav hidden   → ScopeTabs owns the drawer (More trigger), so the
 *     drawer still works on sub-chats and other chrome-less routes.
 *
 * Keeping the path list here (instead of duplicated inline in TopNav)
 * means SP-5's "the drawer works on every bar-visible route" cannot drift
 * out of sync with the TopNav hide rule.
 */

/**
 * Routes where the primary TopNav is intentionally not rendered:
 * library / marketing / onboarding / auth shells, plus the external
 * standalone sub-chat (`/c`). Matches a path exactly or as a prefix
 * segment (`p` or `p/...`).
 */
export const HIDE_TOPNAV_PATHS: readonly string[] = [
  '/design',
  '/how',
  '/innovate',
  '/oss-onboarding',
  '/onboarding',
  '/login',
  // External sub-chat page (gathering intelligence, 2026-06-02): customers
  // without an account must NOT see any app chrome (org/workspace switcher) —
  // standalone fullscreen chat.
  '/c',
];

/**
 * True when the TopNav should NOT render on `pathname`. The internal
 * sub-chat views (`/workspaces/[id]/subchats/...`) are matched via the
 * `/subchats` segment regex — there the TopNav must stay null (its
 * OrgSwitcher org-normalization would otherwise hard-redirect off the page).
 */
export function isTopNavHidden(pathname: string): boolean {
  return (
    HIDE_TOPNAV_PATHS.some(
      (p) => pathname === p || pathname.startsWith(p + '/'),
    ) || /\/subchats(?:\/|$)/.test(pathname)
  );
}

/**
 * True when `pathname` is an OPEN conversation (a live messaging surface where
 * the composer owns the bottom). IA realign 2026-06-06: the floating bottom
 * tab bar is hidden here so it never floats over the chat input — standard
 * messenger behaviour (no tab bar inside an open conversation).
 *
 * Two conversation surfaces:
 *   - the main chat at `/` (ChatShell — composer owns the bottom), and
 *   - an open internal sub-chat `/workspaces/<id>/subchats/<subchatId>`.
 *
 * The sub-chat LIST (`/workspaces/<id>/subchats`) is NOT a conversation — the
 * bar stays visible there. The match therefore requires a trailing
 * `/subchats/<segment>` (a subchat id), not the bare `/subchats` list.
 */
export function isConversation(pathname: string): boolean {
  if (pathname === '/') return true;
  return /\/subchats\/[^/]+$/.test(pathname);
}
