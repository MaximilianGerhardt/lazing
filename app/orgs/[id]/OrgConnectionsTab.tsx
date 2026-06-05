"use client";

/**
 * Org-level connections tab. Lists the connector catalog (API/OAuth connectors
 * and MCP-server connectors) and lets an org admin connect/disconnect each one
 * at the ORG scope — shared across the org's workspaces, isolated from other
 * orgs (N9). Secrets are write-only (never read back). Workspaces can still hold
 * their own per-workspace connection (e.g. a separate Higgsfield account) which
 * overrides the org one.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";

interface Connector {
  provider: string;
  displayName: string;
  description: string | null;
  authKind: string;
  connected: boolean;
}

export function OrgConnectionsTab({
  orgId,
  isAdmin,
}: {
  orgId: string;
  isAdmin: boolean;
}): React.JSX.Element {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/connections`, {
        credentials: "same-origin",
      });
      const j = (await res.json().catch(() => null)) as { connectors?: Connector[] } | null;
      setConnectors(j?.connectors ?? []);
    } catch {
      setConnectors([]);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(
    async (provider: string): Promise<void> => {
      if (secret.trim().length === 0) return;
      setBusy(provider);
      setError(null);
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/connections/${encodeURIComponent(provider)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ secret: secret.trim() }),
          },
        );
        if (!res.ok) {
          setError("Could not connect — check the key and your admin role.");
          return;
        }
        setOpenFor(null);
        setSecret("");
        await load();
      } finally {
        setBusy(null);
      }
    },
    [orgId, secret, load],
  );

  const disconnect = useCallback(
    async (provider: string): Promise<void> => {
      setBusy(provider);
      setError(null);
      try {
        await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/connections/${encodeURIComponent(provider)}`,
          { method: "DELETE", credentials: "same-origin" },
        );
        await load();
      } finally {
        setBusy(null);
      }
    },
    [orgId, load],
  );

  if (connectors === null) {
    return <p style={{ opacity: 0.7, fontSize: 14 }}>Loading connections…</p>;
  }

  return (
    <div data-test="org-connections">
      <p style={leadStyle}>
        Connect APIs and MCP servers for the whole organization. These are shared
        by the org&apos;s workspaces and isolated from other orgs. A workspace can
        override any of them with its own account.
      </p>
      {error ? (
        <p role="alert" style={{ color: "var(--a-danger, #ff6b6b)", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <ul style={listStyle} role="list">
        {connectors.map((c) => (
          <li key={c.provider} style={rowStyle} data-test={`org-connection-${c.provider}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: c.connected
                      ? "var(--a-now, #c9ff4d)"
                      : "color-mix(in oklab, var(--ink, #f5f5f5) 25%, transparent)",
                  }}
                />
                <strong style={{ fontSize: 14 }}>{c.displayName}</strong>
                <span style={badgeStyle}>{c.authKind}</span>
              </span>
              {c.description ? (
                <span style={{ fontSize: 12, opacity: 0.65 }}>{c.description}</span>
              ) : null}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {c.connected ? "Connected" : "Not connected"}
              </span>
              {isAdmin ? (
                c.connected ? (
                  <button
                    type="button"
                    onClick={() => void disconnect(c.provider)}
                    disabled={busy === c.provider}
                    style={ghostBtnStyle}
                  >
                    Disconnect
                  </button>
                ) : openFor === c.provider ? (
                  <span style={{ display: "flex", gap: 6 }}>
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="API key / token"
                      autoComplete="off"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => void connect(c.provider)}
                      disabled={busy === c.provider || secret.trim().length === 0}
                      style={primaryBtnStyle}
                    >
                      {busy === c.provider ? "Saving…" : "Save"}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenFor(c.provider);
                      setSecret("");
                      setError(null);
                    }}
                    style={primaryBtnStyle}
                  >
                    Connect
                  </button>
                )
              ) : null}
            </div>
          </li>
        ))}
        {connectors.length === 0 ? (
          <li style={{ opacity: 0.6, fontSize: 13, padding: "10px 0" }}>
            No connectors in the catalog yet.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

const leadStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  opacity: 0.8,
  margin: "0 0 16px",
  maxWidth: 600,
};
const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 0,
  borderRadius: 12,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 10%, transparent)",
  overflow: "hidden",
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 14px",
  borderBottom: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 7%, transparent)",
};
const badgeStyle: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  opacity: 0.5,
  fontFamily: "var(--font-mono, ui-monospace)",
};
const inputStyle: CSSProperties = {
  padding: "7px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 18%, transparent)",
  background: "color-mix(in oklab, #ffffff 3%, transparent)",
  color: "var(--ink, #f5f5f5)",
  width: 180,
};
const primaryBtnStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
  color: "#070707",
  background: "var(--a-now, #c9ff4d)",
};
const ghostBtnStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  borderRadius: 8,
  border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 18%, transparent)",
  background: "transparent",
  color: "var(--ink, #f5f5f5)",
  cursor: "pointer",
};
