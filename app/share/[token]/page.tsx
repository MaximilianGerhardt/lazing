/**
 * /share/[token] — Public-Stakeholder-View für Cloud-Artifacts.
 *
 * Kein Auth. Token in URL ist die ganze Authentifizierung.
 * Server-Rendered: zeigt eine Card mit Filename + Open + Download.
 * Bei Password-Required: Form fürs Password.
 */

import type { CSSProperties } from "react";

import { resolveAndConsumeShare, ShareError } from "@/lib/cloud/share";

export const dynamic = "force-dynamic";

export default async function PublicSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ password?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const password = sp.password ?? null;

  let state:
    | { kind: "ok"; filename: string; mime: string; bytes: number }
    | { kind: "password" }
    | { kind: "error"; reason: string };

  try {
    // NOTE: resolveAndConsumeShare INKREMENTIERT views — auf der Page
    // sollten wir das vermeiden bei initial render. Day-1 akzeptieren wir
    // den Tick (Counter ist eh approximate). Phase-N: separate
    // `peekShareToken` ohne consume.
    const r = await resolveAndConsumeShare(token, { password });
    state = {
      kind: "ok",
      filename: r.artifact.filename,
      mime: r.artifact.mime,
      bytes: r.artifact.bytes,
    };
  } catch (err) {
    if (err instanceof ShareError) {
      if (err.code === "password-required" || err.code === "wrong-password") {
        state = { kind: "password" };
      } else {
        state = { kind: "error", reason: err.code };
      }
    } else {
      state = { kind: "error", reason: "internal" };
    }
  }

  return (
    <main style={containerStyle}>
      <div style={panelStyle}>
        <div style={brandStyle}>lazyOS · Geteilt</div>

        {state.kind === "ok" ? (
          <>
            <h1 style={titleStyle}>{state.filename}</h1>
            <div style={metaStyle}>
              {state.mime} · {formatBytes(state.bytes)}
            </div>
            <div style={actionsStyle}>
              <a
                href={`/api/share/${encodeURIComponent(token)}/preview${password ? `?password=${encodeURIComponent(password)}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
                style={primaryBtnStyle}
              >
                Öffnen
              </a>
              <a
                href={`/api/share/${encodeURIComponent(token)}${password ? `?password=${encodeURIComponent(password)}` : ""}`}
                style={secondaryBtnStyle}
              >
                Download
              </a>
            </div>
          </>
        ) : null}

        {state.kind === "password" ? (
          <>
            <h1 style={titleStyle}>Passwort erforderlich</h1>
            <p style={metaStyle}>Dieser Link ist passwort-geschützt.</p>
            <form method="GET" action="" style={formStyle}>
              <input
                type="password"
                name="password"
                placeholder="Passwort"
                required
                autoFocus
                style={inputStyle}
              />
              <button type="submit" style={primaryBtnStyle}>
                Öffnen
              </button>
            </form>
          </>
        ) : null}

        {state.kind === "error" ? (
          <>
            <h1 style={titleStyle}>Link nicht verfügbar</h1>
            <p style={metaStyle}>
              {errorReason(state.reason)}
            </p>
          </>
        ) : null}
      </div>
    </main>
  );
}

function errorReason(code: string): string {
  switch (code) {
    case "expired":
      return "Der Link ist abgelaufen.";
    case "revoked":
      return "Der Link wurde widerrufen.";
    case "view-cap-reached":
      return "Der Link wurde bereits zu oft geöffnet.";
    case "artifact-missing":
      return "Die Datei existiert nicht mehr.";
    default:
      return "Der Link ist ungültig oder existiert nicht.";
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const containerStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "#070707",
};
const panelStyle: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  padding: "32px 28px",
  borderRadius: 16,
  border: "0.5px solid #1f1f1f",
  background: "#0c0c0c",
  textAlign: "center",
  color: "#e6e6e6",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
};
const brandStyle: CSSProperties = {
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#7a7a7a",
  marginBottom: 28,
};
const titleStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 500,
  letterSpacing: "-0.02em",
  margin: "0 0 12px",
};
const metaStyle: CSSProperties = {
  fontSize: 13,
  color: "#888",
  margin: "0 0 28px",
  lineHeight: 1.5,
};
const actionsStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  justifyContent: "center",
};
const primaryBtnStyle: CSSProperties = {
  padding: "12px 24px",
  borderRadius: 10,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: 14,
  fontWeight: 500,
  textDecoration: "none",
  cursor: "pointer",
};
const secondaryBtnStyle: CSSProperties = {
  padding: "12px 24px",
  borderRadius: 10,
  border: "0.5px solid #2a2a2a",
  background: "transparent",
  color: "#e6e6e6",
  fontSize: 14,
  textDecoration: "none",
};
const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: 280,
  margin: "0 auto",
};
const inputStyle: CSSProperties = {
  padding: "12px 14px",
  fontSize: 16,
  borderRadius: 10,
  border: "0.5px solid #2a2a2a",
  background: "#141414",
  color: "#e6e6e6",
  textAlign: "center",
};
