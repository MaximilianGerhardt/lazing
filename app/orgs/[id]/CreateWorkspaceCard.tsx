'use client';

/**
 * CreateWorkspaceCard — Apple-Pure Inline-Card für /orgs/[id].
 *
 * 2026-05-03: User kann direkt auf der Org-Detail-Page einen neuen
 * Workspace anlegen. Toggle-Button öffnet die NewWorkspaceForm als
 * Inline-Section unterhalb des Org-Headers (kein Modal — siehe
 * Memory-Pin „ KEINE Overlays").
 *
 * Reuse: dieselbe NewWorkspaceForm wie im WorkspaceSwitcher, hier mit
 * variant="card" für den großzügigeren Page-Kontext.
 *
 * 2026-05-26: onSuccess ruft jetzt setWorkspace + setOrg damit der UI
 * sofort in den neuen Workspace wechselt (Badge/Segment/History).
 *
 * 2026-05-28 (Owner-Fix Live-Test): Vor dem Fix blieb der User nach dem
 * Create auf /orgs/[id] stehen — der Workspace-Wechsel war zwar in
 * localStorage geschrieben, aber visuell „nicht passiert". Jetzt navigieren
 * wir hart nach `/?ws=<newId>` (kanonischer Lande-Pfad für Chat-pro-Workspace,
 * siehe app/page.tsx + WorkspaceBootstrap), damit der Owner direkt im
 * Chat des frisch angelegten Workspaces landet — identisch zum Klick auf
 * eine Workspace-Row im WorkspaceSwitcher gefolgt von „zurück zum Chat".
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { NewWorkspaceForm } from '@/lib/nav/NewWorkspaceForm';
import { setWorkspaceId } from '@/lib/nav/hooks';

interface Props {
  orgId: string;
  orgName: string;
  /** Wenn false → Card zeigt nur eine Hint-Zeile, kein Open-Button. */
  canCreate: boolean;
  /** Optional: vorbelegter Context-Group-Wert (z.B. wenn Org „CRM" heißt). */
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
          // 1) localStorage + Workspace-Change-Event SOFORT setzen, damit
          //    Listener auf der Landing-Page (Sidebar / TopNav) den richtigen
          //    Workspace lesen, bevor der neue Tree mountet.
          // Fix #2 (2026-06-02): Org des neuen Workspace mit-setzen, damit der
          // Auto-Switch auch greift, wenn der Workspace in einer ANDEREN Org als
          // der aktiven liegt (sonst Org-Normalisierung → Reset auf org-root).
          setWorkspaceId(ws.id, ws.organizationId ?? undefined);
          // 2) Owner-Fix 2026-05-28 — Auto-Switch zum Chat des neuen Workspaces.
          //    `/?ws=<id>` ist der kanonische Lande-Pfad (siehe app/page.tsx +
          //    WorkspaceBootstrap). router.push triggert die Server-Component
          //    der HomePage; WorkspaceBootstrap seedet localStorage SYNCHRON
          //    in useLayoutEffect (vor Hydration), sodass kein State-Flicker
          //    auf den alten Workspace passiert.
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
