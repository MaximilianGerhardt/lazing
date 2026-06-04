import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { sql, eq } from 'drizzle-orm';

import { ChatShell } from '@/lib/chat/ChatShell';
import {
  safeProjectDecisions,
  safeProjectTickets,
} from '@/lib/events/safe-projection';
import { SetupHero } from '@/lib/home/SetupHero';
import { WorkspaceBootstrap } from '@/lib/nav/WorkspaceBootstrap';
import { OrgBootstrap } from '@/lib/nav/OrgBootstrap';
import {
  orgBootstrapEnabled,
  resolveWorkspaceOrgId,
} from '@/lib/nav/org-bootstrap.server';
import { getDb } from '@/db/client';
import { users } from '@/db/schema/users';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { isOssMode } from '@/lib/onboarding/oss-mode';

export const dynamic = 'force-dynamic';

/**
 * Authoritative DB backstop for the OSS first-run gate (B0). The Edge
 * middleware does the cheap cookie redirect, but a cleared cookie / new browser
 * would slip past it — so here we re-check `oss_onboarding_completed_at` against
 * the DB and redirect to the wizard if it has never completed. Cheap single-row
 * read; only runs when LAZYOS_OSS_MODE is enabled.
 */
async function ossFirstRunBackstop(): Promise<void> {
  if (!isOssMode()) return;
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) return; // unauthenticated — middleware handles login redirect
  const db = getDb();
  const row = db
    .select({ done: sql<number | null>`oss_onboarding_completed_at` })
    .from(users)
    .where(eq(users.id, userId))
    .all()[0];
  if (!row?.done) {
    redirect('/oss-onboarding');
  }
}

/**
 * Home — interactive Chat shell.
 *
 * The Server Component prepares the data that the chat needs to
 * render surface cards (tickets / decisions / status). The Client
 * Component (`ChatShell`) then owns the conversation state,
 * LocalStorage history, and Mock-Agent routing.
 *
 * The old hero + push-subscribe flow was moved to `/welcome` so
 * onboarding still works but does not hijack the root route.
 *
 * SAR-5: `searchParams.ws` carries an org-root workspace hint from the
 * `/orgs/[id]/chat` redirect so that Direct-URL access (Bookmarks) lands
 * on the correct workspace without requiring a prior localStorage write.
 * `WorkspaceBootstrap` consumes the hint and seeds localStorage.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  await ossFirstRunBackstop();

  const sp = await searchParams;
  const wsHint = typeof sp.ws === 'string' ? sp.ws : null;

  // Nav-Fix D (2026-06-02): wenn der Hauptchat in einen ECHTEN Kunden-Workspace
  // scoped wird (/?ws=<realId>), den Org-Kontext synchron mit-seeden — sonst
  // normalisiert der OrgSwitcher die Org zurück auf org-root und redirected weg.
  // Virtuelle Hints (__org_root__:*, __all__) liefern null → kein OrgBootstrap.
  const scopedOrgId =
    wsHint && orgBootstrapEnabled() ? resolveWorkspaceOrgId(wsHint) : null;

  const [tickets, decisions] = await Promise.all([
    safeProjectTickets(),
    safeProjectDecisions(undefined, 12),
  ]);

  return (
    <>
      {/* Seed localStorage workspace context before ChatShell hydrates. */}
      {wsHint && <WorkspaceBootstrap workspaceId={wsHint} />}
      {scopedOrgId && <OrgBootstrap organizationId={scopedOrgId} />}
      <SetupHero />
      <ChatShell
        tickets={tickets}
        decisions={decisions}
      />
    </>
  );
}
