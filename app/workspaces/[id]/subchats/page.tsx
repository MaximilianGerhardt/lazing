/**
 * /workspaces/[id]/subchats — Sub-Chat-Liste eines Workspace (interne Sicht).
 * Auth: Workspace-Member (middleware + API-Handler). Gathering-Intelligence-Goal.
 */

import { SubchatsClient } from './SubchatsClient';
import { OrgBootstrap } from '@/lib/nav/OrgBootstrap';
import {
  orgBootstrapEnabled,
  resolveWorkspaceOrgId,
} from '@/lib/nav/org-bootstrap.server';

export const dynamic = 'force-dynamic';

export default async function SubchatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  // Nav-Fix D: Org-Kontext an den Kunden-Workspace angleichen (kein Redirect).
  const orgId = orgBootstrapEnabled() ? resolveWorkspaceOrgId(id) : null;
  return (
    <>
      {orgId ? <OrgBootstrap organizationId={orgId} /> : null}
      <SubchatsClient workspaceId={id} />
    </>
  );
}
