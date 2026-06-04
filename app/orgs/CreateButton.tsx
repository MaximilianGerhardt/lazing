'use client';

/**
 * Create-Org-Button + Dialog (Phase ORG+UI-Fix · 2026-04-28).
 * Triggert POST /api/orgs.
 */

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

const TYPE_OPTIONS = ["client", "company", "product", "tool", "private"] as const;

export function OrgsCreateButton(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] =
    useState<typeof TYPE_OPTIONS[number]>("client");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (name.trim().length < 2) {
      setError("Name muss mindestens 2 Zeichen haben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((j.message as string) ?? (j.error as string) ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { org: { id: string } };
      setOpen(false);
      setName("");
      setDescription("");
      router.push(`/orgs/${encodeURIComponent(j.org.id)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unbekannt");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={triggerStyle}>
        + Neue Org
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => !busy && setOpen(false)}
          style={overlayStyle}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={modalStyle}
          >
            <h2 style={modalTitleStyle}>Neue Organisation</h2>

            <label style={fieldStyle}>
              <span style={labelStyle}>Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="z.B. Example Company"
                disabled={busy}
                autoFocus
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Typ</span>
              <select
                value={type}
                onChange={(e) =>
                  setType(e.target.value as typeof TYPE_OPTIONS[number])
                }
                disabled={busy}
                style={inputStyle}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Kurzbeschreibung (optional)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Was macht diese Org?"
                disabled={busy}
                style={inputStyle}
              />
            </label>

            {error ? (
              <div style={errorStyle}>{error}</div>
            ) : null}

            <div style={actionsStyle}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                style={cancelStyle}
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || name.trim().length < 2}
                style={submitStyle}
              >
                {busy ? "Lege an …" : "Anlegen"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const triggerStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 10,
  border: "0.5px solid var(--line-2)",
  background: "var(--a-now)",
  color: "var(--sheet)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  flexShrink: 0,
};
const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.7)",
  backdropFilter: "blur(6px)",
  zIndex: 90,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};
const modalStyle: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--sheet-1)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 14,
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const modalTitleStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: "-0.015em",
  margin: "0 0 4px",
  color: "var(--ink)",
};
const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const labelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
const inputStyle: CSSProperties = {
  padding: "10px 12px",
  fontSize: 14,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-2)",
  color: "var(--ink)",
};
const errorStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "color-mix(in oklab, #ff5252 14%, transparent)",
  color: "#ffcccc",
  fontSize: 12,
};
const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  marginTop: 8,
};
const cancelStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: 13,
  cursor: "pointer",
};
const submitStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: 8,
  border: "none",
  background: "var(--a-now)",
  color: "var(--sheet)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};
