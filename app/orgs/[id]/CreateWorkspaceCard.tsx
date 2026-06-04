'use client';

/**
 * CreateWorkspaceCard — Apple-pure inline card for /orgs/[id].
 *
 * 2026-05-03: the user can create a new workspace directly on the org
 * detail page. The toggle button opens the NewWorkspaceForm as an
 * inline section below the org header (no modal — see the
 * memory pin "NO overlays").
 *
 * Reuse: the same NewWorkspaceForm as in the WorkspaceSwitcher, here with
 * variant="card" for the more generous page context.
 *
 * 2026-05-26: onSuccess now calls setWorkspace + setOrg so the UI
 * switches into the new workspace immediately (badge/segment/history).
 *
 * 2026-05-28 (owner fix live test): before the fix, the user stayed on
 * /orgs/[id] after the create — the workspace switch was written to
 * localStorage, but visually "did not happen". Now we navigate hard
 * to `/?ws=<newId>` (the canonical landing path for chat-per-workspace,
 * see app/page.tsx + WorkspaceBootstrap), so the owner lands directly in
 * the chat of the freshly created workspace — identical to clicking a
 * workspace row in the WorkspaceSwitcher followed by "back to chat".
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { NewWorkspaceForm } from '@/lib/nav/NewWorkspaceForm';
import { setWorkspaceId } from '@/lib/nav/hooks';

interface Props {
  orgId: string;
  orgName: string;
  /** If false → the card only shows a hint line, no open button. */
  canCreate: boolean;
  /** Optional: prefilled context-group value (e.g. when the org is named "CRM"). */
  defaultContextGroup?: string;
}

export function CreateWorkspaceCard({
  orgId,
  orgName,
  canCreate,
  defaultContextGroup,
}: Props): React.JSX.Element | null {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  if (!canCreate) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={triggerStyle}
        aria-label={`Neuen Workspace in „${orgName}" anlegen`}
      >
        <span style={plusStyle} aria-hidden="true">
          +
        </span>
        Neuer Workspace
      </button>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <strong style={{ color: 'var(--ink)' }}>
          Neuer Workspace in „{orgName}"
        </strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={closeStyle}
          aria-label="Abbrechen"
        >
          ×
        </button>
      </div>
      <NewWorkspaceForm
        defaultOrgId={orgId}
        defaultContextGroup={defaultContextGroup}
        variant="card"
        onCancel={() => setOpen(false)}
        onSuccess={(ws) => {
          setOpen(false);
          // 1) Set localStorage + workspace-change event IMMEDIATELY, so that
          //    listeners on the landing page (sidebar / TopNav) read the right
          //    workspace before the new tree mounts.
          // Fix #2 (2026-06-02): also set the org of the new workspace, so the
          // auto-switch also takes effect when the workspace is in a DIFFERENT org
          // than the active one (otherwise org normalization → reset to org-root).
          setWorkspaceId(ws.id, ws.organizationId ?? undefined);
          // 2) Owner fix 2026-05-28 — auto-switch to the chat of the new workspace.
          //    `/?ws=<id>` is the canonical landing path (see app/page.tsx +
          //    WorkspaceBootstrap). router.push triggers the server component
          //    of the HomePage; WorkspaceBootstrap seeds localStorage SYNCHRONOUSLY
          //    in useLayoutEffect (before hydration), so that no state flicker
          //    to the old workspace happens.
          startTransition(() => {
            router.push(`/?ws=${encodeURIComponent(ws.id)}`);
          });
        }}
      />
    </div>
  );
}

const triggerStyle: CSSProperties = {
  alignSelf: 'flex-start',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  borderRadius: 999,
  border: '0.5px solid color-mix(in oklab, var(--a-now) 35%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-now) 10%, transparent)',
  color: 'var(--a-now)',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 140ms ease',
};

const plusStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
  fontWeight: 600,
};

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 520,
  marginTop: 16,
  padding: '20px 24px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const closeStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-3)',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
};
