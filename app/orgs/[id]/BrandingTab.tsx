'use client';

/**
 * Org Branding Tab — logo, colors, address, imprint, VAT ID.
 * Read by the SP-7 PDF pipeline for branded reports.
 */

import { useState, type CSSProperties } from "react";

import type { OrgFull } from "@/lib/orgs/repo";
import { isValidHex } from "@/lib/util/color";

import { BrandPreview } from "./BrandPreview";
import { ColorPickerField } from "./ColorPickerField";

const MAX_COLORS = 6;
const DEFAULT_NEW_COLOR = "#070707";

interface BrandingTabProps {
  org: OrgFull;
  canEdit: boolean;
}

export function OrgBrandingTab({
  org,
  canEdit,
}: BrandingTabProps): React.JSX.Element {
  const [logoUrl, setLogoUrl] = useState(org.logoUrl ?? "");
  const [wordmarkUrl, setWordmarkUrl] = useState(org.wordmarkUrl ?? "");
  const [brandColors, setBrandColors] = useState<string[]>(
    () => (org.brandColors ?? []).filter(isValidHex).slice(0, MAX_COLORS),
  );
  const [legalName, setLegalName] = useState(org.legalName ?? "");
  const [registrationNo, setRegistrationNo] = useState(
    org.registrationNo ?? "",
  );
  const [responsibleLabel, setResponsibleLabel] = useState(
    org.responsibleLabel ?? "",
  );
  const [addressLines, setAddressLines] = useState(
    (org.addressLines ?? []).join("\n"),
  );
  const [phone, setPhone] = useState(org.phone ?? "");
  const [vatId, setVatId] = useState(org.vatId ?? "");
  const [imprintMd, setImprintMd] = useState(org.imprintMd ?? "");
  const [canonicalDomain, setCanonicalDomain] = useState(
    org.canonicalDomain ?? "",
  );
  const [emailFrom, setEmailFrom] = useState(org.emailFrom ?? "");
  const [bankIban, setBankIban] = useState(org.bankIban ?? "");
  const [bankBic, setBankBic] = useState(org.bankBic ?? "");
  const [bankName, setBankName] = useState(org.bankName ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const colors = brandColors
        .map((c) => c.trim().toLowerCase())
        .filter(isValidHex)
        .slice(0, MAX_COLORS);
      const lines = addressLines
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const res = await fetch(`/api/orgs/${encodeURIComponent(org.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logoUrl: logoUrl.trim() || null,
          wordmarkUrl: wordmarkUrl.trim() || null,
          brandColors: colors.length > 0 ? colors : null,
          addressLines: lines.length > 0 ? lines : null,
          vatId: vatId.trim() || null,
          imprintMd: imprintMd.trim() || null,
          canonicalDomain: canonicalDomain.trim() || null,
          emailFrom: emailFrom.trim() || null,
          legalName: legalName.trim() || null,
          registrationNo: registrationNo.trim() || null,
          phone: phone.trim() || null,
          bankIban: bankIban.replace(/\s+/g, "") || null,
          bankBic: bankBic.replace(/\s+/g, "").toUpperCase() || null,
          bankName: bankName.trim() || null,
          responsibleLabel: responsibleLabel.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((j.message as string) ?? `HTTP ${res.status}`);
      }
      setMsg("Gespeichert.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unbekannt");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 800,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <div>
        <h3 style={hStyle}>Logo & Wordmark</h3>
        <Field
          label="Logo-URL (PNG/JPG, quadratisch empfohlen)"
          value={logoUrl}
          onChange={setLogoUrl}
          disabled={!canEdit}
          placeholder="https://example.com/logo.png"
        />
        <Field
          label="Wordmark-URL"
          value={wordmarkUrl}
          onChange={setWordmarkUrl}
          disabled={!canEdit}
          placeholder="https://example.com/wordmark.svg"
        />
        {logoUrl ? (
          <div style={{ marginTop: 12 }}>
            <img
              src={logoUrl}
              alt=""
              style={{
                maxWidth: 80,
                maxHeight: 80,
                borderRadius: 8,
                border: "0.5px solid var(--line-2)",
              }}
            />
          </div>
        ) : null}
      </div>

      <div>
        <h3 style={hStyle}>Brand-Farben</h3>
        <p style={hintStyle}>
          Bis zu {MAX_COLORS} Farben — die ersten beiden bestimmen TopBar &amp;
          Akzent in Surfaces. Tippe auf ein Farbfeld, um den Picker zu öffnen.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {brandColors.map((c, i) => (
            <ColorPickerField
              key={`${i}-${c}`}
              value={c}
              disabled={!canEdit}
              onChange={(hex) =>
                setBrandColors((prev) =>
                  prev.map((p, idx) => (idx === i ? hex : p)),
                )
              }
              onRemove={
                canEdit
                  ? () =>
                      setBrandColors((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      )
                  : undefined
              }
            />
          ))}
        </div>
        {canEdit && brandColors.length < MAX_COLORS ? (
          <button
            type="button"
            onClick={() =>
              setBrandColors((prev) => [...prev, DEFAULT_NEW_COLOR])
            }
            style={addBtnStyle}
          >
            + Farbe hinzufügen
          </button>
        ) : null}
        <BrandPreview colors={brandColors} />
      </div>

      <div>
        <h3 style={hStyle}>Rechtliche Identität</h3>
        <Field
          label="Rechtsname (auf Verträgen/Rechnungen)"
          value={legalName}
          onChange={setLegalName}
          disabled={!canEdit}
          placeholder="Example Company"
        />
        <Field
          label="Handelsregister / Registrierung"
          value={registrationNo}
          onChange={setRegistrationNo}
          disabled={!canEdit}
          placeholder="HRB 12345 / Amtsgericht Berlin"
        />
        <Field
          label="Vertretungsberechtigt (Name + Titel)"
          value={responsibleLabel}
          onChange={setResponsibleLabel}
          disabled={!canEdit}
          placeholder="Max Mustermann, Geschäftsführer"
        />
        <Field
          label="USt-IdNr."
          value={vatId}
          onChange={setVatId}
          disabled={!canEdit}
          placeholder="DE123456789"
        />
      </div>

      <div>
        <h3 style={hStyle}>Anschrift & Kontakt</h3>
        <FieldArea
          label="Adress-Zeilen (eine pro Zeile)"
          value={addressLines}
          onChange={setAddressLines}
          disabled={!canEdit}
          rows={4}
          placeholder={"Example Company\nMusterstraße 1\n12345 Berlin\nDeutschland"}
        />
        <Field
          label="Telefon"
          value={phone}
          onChange={setPhone}
          disabled={!canEdit}
          placeholder="+49 30 12345678"
        />
        <Field
          label="Email-From (für Org-spezifische Mails)"
          value={emailFrom}
          onChange={setEmailFrom}
          disabled={!canEdit}
          placeholder="hallo@examplecompany.example"
        />
        <Field
          label="Canonical Domain"
          value={canonicalDomain}
          onChange={setCanonicalDomain}
          disabled={!canEdit}
          placeholder="examplecompany.example"
        />
      </div>

      <div>
        <h3 style={hStyle}>Bankverbindung</h3>
        <Field
          label="IBAN"
          value={bankIban}
          onChange={setBankIban}
          disabled={!canEdit}
          placeholder="DE12 3456 7890 1234 5678 90"
        />
        <Field
          label="BIC"
          value={bankBic}
          onChange={setBankBic}
          disabled={!canEdit}
          placeholder="BANKDEFFXXX"
        />
        <Field
          label="Bank-Name"
          value={bankName}
          onChange={setBankName}
          disabled={!canEdit}
          placeholder="Deutsche Bank Berlin"
        />
      </div>

      <div>
        <h3 style={hStyle}>Impressum & Footer</h3>
        <FieldArea
          label="Impressum (Markdown, wird in PDF-Footer rendered wenn Empfänger extern)"
          value={imprintMd}
          onChange={setImprintMd}
          disabled={!canEdit}
          rows={6}
          placeholder={"Verantwortlich i.S.d. § 18 MStV: ..."}
        />
      </div>

      {canEdit ? (
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button type="button" onClick={save} disabled={busy} style={btnPrimary}>
            {busy ? "Speichere …" : "Speichern"}
          </button>
          {msg ? <span style={{ color: "#9ee49e", fontSize: 12 }}>{msg}</span> : null}
          {err ? <span style={{ color: "#ff8080", fontSize: 12 }}>{err}</span> : null}
        </div>
      ) : (
        <p style={{ color: "var(--ink-3)", fontSize: 12 }}>
          Nur Admins/Founder können das Branding bearbeiten.
        </p>
      )}
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled}
        placeholder={props.placeholder}
        style={inputStyle}
      />
    </label>
  );
}

function FieldArea(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
}): React.JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{props.label}</span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled}
        placeholder={props.placeholder}
        rows={props.rows ?? 3}
        style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
      />
    </label>
  );
}

const hStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: "0 0 12px",
};
const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 12,
};
const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--ink-2)",
};
const inputStyle: CSSProperties = {
  padding: "10px 12px",
  fontSize: 14,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-1)",
  color: "var(--ink)",
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  fontFamily: "inherit",
};
const hintStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--ink-3)",
  margin: "0 0 12px",
  lineHeight: 1.5,
};
const addBtnStyle: CSSProperties = {
  marginTop: 8,
  padding: "10px 14px",
  borderRadius: 8,
  border: "0.5px dashed var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: 13,
  cursor: "pointer",
  minHeight: 44,
};
const btnPrimary: CSSProperties = {
  padding: "10px 20px",
  borderRadius: 8,
  border: "none",
  background: "var(--a-now)",
  color: "var(--sheet)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};
