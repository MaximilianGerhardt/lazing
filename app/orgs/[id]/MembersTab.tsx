'use client';

/**
 * Org Members Tab — list + invite dialog.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useToast } from "@/lib/ui/tst/useToast";

interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  role: string;
  joinedAt: string;
}

const ROLE_OPTIONS = ["admin", "member", "viewer", "guest"] as const;

export function OrgMembersTab({
  orgId,
  canInvite,
}: {
  orgId: string;
  canInvite: boolean;
}): React.JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<typeof ROLE_OPTIONS[number]>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  // Inline confirm state for member removal (replaces window.confirm).
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { members: Member[] };
      setMembers(j.members);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannt");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitInvite = async (): Promise<void> => {
    if (!inviteEmail.includes("@")) return;
    setInviteBusy(true);
    setInviteSuccess(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((j.message as string) ?? `HTTP ${res.status}`);
      }
      const j = (await res.json().catch(() => ({}))) as {
        deliveredVia?: string;
      };
      const via = j.deliveredVia === "email"
        ? "Mail unterwegs zu"
        : "Magic-Link generiert für";
      setInviteSuccess(`${via} ${inviteEmail}.`);
      toast.ok("Einladung gesendet", inviteEmail);
      setInviteEmail("");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unbekannt";
      setError(msg);
      toast.err("Einladung fehlgeschlagen", msg);
    } finally {
      setInviteBusy(false);
    }
  };

  const changeRole = async (
    memberId: string,
    role: typeof ROLE_OPTIONS[number],
  ): Promise<void> => {
    if (!confirm(`Rolle auf '${role}' ändern?`)) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      },
    );
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = (j.message as string) ?? `HTTP ${res.status}`;
      setError(msg);
      toast.err("Rolle ändern fehlgeschlagen", msg);
      return;
    }
    await refresh();
  };

  /** Shows the inline confirm row for memberId. */
  const requestRemove = (memberId: string): void => {
    setRemoveConfirmId(memberId);
  };

  const cancelRemove = (): void => {
    setRemoveConfirmId(null);
  };

  const confirmRemove = async (
    memberId: string,
    email: string,
  ): Promise<void> => {
    setRemoveConfirmId(null);
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = (j.message as string) ?? `HTTP ${res.status}`;
      setError(msg);
      toast.err("Entfernen fehlgeschlagen", msg);
      return;
    }
    toast.ok("Mitglied entfernt", email);
    await refresh();
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
        }}
      >
        <h2 style={h2Style}>{loading ? "lade …" : `${members.length} Mitglieder`}</h2>
        {canInvite ? (
          <button
            type="button"
            onClick={() => setShowInvite((v) => !v)}
            style={ctaStyle}
          >
            {showInvite ? "Schließen" : "Einladen"}
          </button>
        ) : null}
      </div>

      {showInvite && canInvite ? (
        <div style={panelStyle}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@adresse.tld"
              style={inputStyle}
              disabled={inviteBusy}
            />
            <select
              value={inviteRole}
              onChange={(e) =>
                setInviteRole(e.target.value as typeof ROLE_OPTIONS[number])
              }
              style={selectStyle}
              disabled={inviteBusy}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={submitInvite}
              disabled={inviteBusy || !inviteEmail.includes("@")}
              style={primaryBtnStyle}
            >
              Einladung senden
            </button>
          </div>
          {inviteSuccess ? (
            <div style={{ marginTop: 10, color: "var(--term-ok)", fontSize: "var(--fs-body)" }}>
              {inviteSuccess}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div style={errStyle}>Fehler: {error}</div>
      ) : null}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Mitglied</th>
            <th style={thStyle}>Rolle</th>
            <th style={thStyle}>Beigetreten</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td style={tdStyle}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      background: "var(--sheet-2)",
                      border: "0.5px solid var(--line-2)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      color: "var(--ink-3)",
                    }}
                  >
                    {m.displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "var(--ink)" }}>
                      {m.displayName}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {m.email}
                    </div>
                  </div>
                </div>
              </td>
              <td style={tdStyle}>
                {canInvite && m.role !== "founder" ? (
                  <select
                    value={m.role}
                    onChange={(e) =>
                      changeRole(
                        m.id,
                        e.target.value as typeof ROLE_OPTIONS[number],
                      )
                    }
                    style={selectInlineStyle}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={pillStyle(m.role)}>{m.role}</span>
                )}
              </td>
              <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
                {new Date(m.joinedAt).toLocaleDateString("de-DE")}
              </td>
              <td style={tdStyle}>
                {canInvite && m.role !== "founder" ? (
                  removeConfirmId === m.id ? (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => void confirmRemove(m.id, m.email)}
                        style={removeDangerBtnStyle}
                        aria-label={`${m.email} wirklich entfernen`}
                      >
                        Entfernen
                      </button>
                      <button
                        type="button"
                        onClick={cancelRemove}
                        style={removeCancelBtnStyle}
                      >
                        Abbrechen
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => requestRemove(m.id)}
                      style={removeBtnStyle}
                      aria-label={`${m.email} entfernen`}
                    >
                      <svg
                        width={14}
                        height={14}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.6}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        focusable={false}
                        style={{ display: "block" }}
                      >
                        <path d="M6 6l12 12" />
                        <path d="M18 6L6 18" />
                      </svg>
                    </button>
                  )
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const h2Style: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};
const ctaStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-2)",
  color: "var(--ink)",
  fontSize: 12,
  cursor: "pointer",
};
const primaryBtnStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--a-now)",
  color: "var(--sheet)",
  fontSize: 12,
  cursor: "pointer",
};
const panelStyle: CSSProperties = {
  padding: 16,
  borderRadius: 12,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  marginBottom: 18,
};
const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 220,
  padding: "8px 12px",
  fontSize: 14,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-1)",
  color: "var(--ink)",
};
const selectStyle: CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-1)",
  color: "var(--ink)",
};
const selectInlineStyle: CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  borderRadius: 6,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-1)",
  color: "var(--ink)",
};
const errStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  background: "color-mix(in oklab, var(--a-danger) 12%, transparent)",
  color: "var(--ink)",
  fontSize: "var(--fs-body)",
  marginBottom: 18,
};
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse" as const,
};
const thStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  textAlign: "left" as const,
  padding: "10px 12px",
  borderBottom: "0.5px solid var(--line-2)",
};
const tdStyle: CSSProperties = {
  padding: "12px",
  borderBottom: "0.5px solid var(--line-2)",
  fontSize: 13,
};
function pillStyle(role: string): CSSProperties {
  const colors: Record<string, string> = {
    founder: "#fbbf24",
    admin: "#a78bfa",
    member: "#7dd3fc",
    viewer: "#9ca3af",
    guest: "#6b7280",
  };
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    background: "color-mix(in oklab, " + (colors[role] ?? "#888") + " 20%, transparent)",
    color: colors[role] ?? "#888",
  };
}
const removeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ink-3)",
  fontSize: 14,
  cursor: "pointer",
  padding: 4,
};
const removeDangerBtnStyle: CSSProperties = {
  background: "color-mix(in oklab, var(--a-danger) 12%, transparent)",
  border: "0.5px solid var(--a-danger)",
  color: "var(--a-danger)",
  fontSize: 11,
  cursor: "pointer",
  padding: "3px 8px",
  borderRadius: 6,
  fontFamily: "var(--font-sans)",
};
const removeCancelBtnStyle: CSSProperties = {
  background: "transparent",
  border: "0.5px solid var(--line-2)",
  color: "var(--ink-2)",
  fontSize: 11,
  cursor: "pointer",
  padding: "3px 8px",
  borderRadius: 6,
  fontFamily: "var(--font-sans)",
};
