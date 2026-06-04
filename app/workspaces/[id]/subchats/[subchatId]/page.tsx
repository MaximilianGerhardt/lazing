/**
 * /workspaces/[id]/subchats/[subchatId] — internal team view of a sub-chat.
 * Auth: workspace member (middleware-gated + route handler checks membership).
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
  // Nav-Fix D: align org context to the customer workspace (no redirect).
  const orgId = orgBootstrapEnabled() ? resolveWorkspaceOrgId(id) : null;
  return (
    <>
      {orgId ? <OrgBootstrap organizationId={orgId} /> : null}
      <InternalSubchat subchatId={subchatId} workspaceId={id} />
    </>
  );
}
