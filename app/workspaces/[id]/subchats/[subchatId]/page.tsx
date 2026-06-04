/**
 * /workspaces/[id]/subchats/[subchatId] — interne Team-Sicht eines Sub-Chats.
 * Auth: Workspace-Member (middleware-gated + Route-Handler prüft Membership).
 * Gathering-Intelligence-Goal (2026-06-02).
 */

import { InternalSubchat } from './InternalSubchat';
import { OrgBootstrap } from '@/lib/nav/OrgBootstrap';
import {
  orgBootstrapEnabled,
  resolveWorkspaceOrgId,
} from '@/lib/nav/org-bootstrap.server';

export const dynamic = 'force-dynamic';

export default async function InternalSubchatPage({
  params,
}: {
  params: Promise<{ id: string; subchatId: string }>;
}): Promise<React.ReactElement> {
  const { id, subchatId } = await params;
  // Nav-Fix D: Org-Kontext an den Kunden-Workspace angleichen (kein Redirect).
  const orgId = orgBootstrapEnabled() ? resolveWorkspaceOrgId(id) : null;
  return (
    <>
      {orgId ? <OrgBootstrap organizationId={orgId} /> : null}
      <InternalSubchat subchatId={subchatId} workspaceId={id} />
    </>
  );
}
