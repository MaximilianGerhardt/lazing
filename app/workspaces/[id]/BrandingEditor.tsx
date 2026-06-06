'use client';

/**
 * BrandingEditor — business brand of the customer/project in this workspace.
 *
 * NOT the token stack of the lazyOS app (that was an earlier misunderstanding).
 * This is where logo, brand colors, brand voice, email signature land — things
 * that show up in outbound communication, PDFs, Stripe receipts.
 *
 * Not shown by the page wrap when sensitivity='high' or the workspace
 * is a private workspace (brand is not relevant there).
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { BRAND_NAME } from '@/lib/brand';

interface Props {
  workspaceId: string;
  initial: {
    logoUrl: string | null;
    wordmarkUrl: string | null;
    brandColors: string[];
    brandVoice: string | null;
    emailSignature: string | null;
    canonicalDomain: string | null;
  };
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function BrandingEditor({ workspaceId, initial }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? '');
  const [wordmarkUrl, setWordmarkUrl] = useState(initial.wordmarkUrl ?? '');
  const [colors, setColors] = useState<string[]>(
    initial.brandColors.length > 0
      ? [...initial.brandColors, '', ''].slice(0, 3)
      : ['', '', ''],
  );
  const [voice, setVoice] = useState(initial.brandVoice ?? '');
  const [signature, setSignature] = useState(initial.emailSignature ?? '');
  const [domain, setDomain] = useState(initial.canonicalDomain ?? '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setErrorMsg(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setStatus('saved');
      startTransition(() => router.refresh());
      window.setTimeout(() => setStatus('idle'), 1400);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const validColors = colors
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));

  return (
    <div style={wrapStyle}>
      <header style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Brand-Identität</h3>
          <p style={leadStyle}>
            Logo, Markenfarben und Tonalität dieses Kunden/Projekts. Wird in
            Outbound-Mails, PDFs und Stripe-Receipts genutzt — nicht im
            {' '}{BRAND_NAME}-UI selbst.
          </p>
        </div>
      </header>

      <Section
        kicker="01 · Visuell"
        title="Logo + Wordmark"
        sub="URLs zu öffentlich erreichbaren PNG/SVG. Upload kommt später."
      >
        <Field label="Logo-URL" hint="Quadrat-Logo (Icon)">
          <input
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            onBlur={() => {
              if (logoUrl !== (initial.logoUrl ?? '')) {
                void save({ logoUrl: logoUrl || null });
              }
            }}
            placeholder="https://kunde.com/logo.svg"
            style={inputStyle}
            maxLength={500}
          />
          {logoUrl && /^https?:\/\//.test(logoUrl) ? (
            <div style={previewWrapStyle}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="Logo-Preview" style={logoImgStyle} />
            </div>
          ) : null}
        </Field>

        <Field label="Wordmark-URL" hint="Horizontales Schriftlogo (optional)">
          <input
            type="url"
            value={wordmarkUrl}
            onChange={(e) => setWordmarkUrl(e.target.value)}
            onBlur={() => {
              if (wordmarkUrl !== (initial.wordmarkUrl ?? '')) {
                void save({ wordmarkUrl: wordmarkUrl || null });
              }
            }}
            placeholder="https://kunde.com/wordmark.svg"
            style={inputStyle}
            maxLength={500}
          />
        </Field>
      </Section>

      <Section
        kicker="02 · Farben"
        title="Markenpalette"
        sub="Bis zu 3 Hex-Farben. Erste = Primärfarbe (CTAs, Akzente), Zweite = Sekundär, Dritte = Neutral/Beige."
      >
        <div style={colorRowStyle}>
          {colors.map((c, i) => (
            <div key={i} style={colorFieldStyle}>
              <input
                type="text"
                value={c}
                onChange={(e) => {
                  const next = [...colors];
                  next[i] = e.target.value.startsWith('#')
                    ? e.target.value
                    : '#' + e.target.value.replace(/^#/, '');
                  setColors(next);
                }}
                onBlur={() => {
                  void save({ brandColors: colors.filter((x) => /^#[0-9a-fA-F]{6}$/.test(x)) });
                }}
                placeholder={['#0A2540', '#FF6B35', '#F5F5F7'][i]}
                style={colorInputStyle}
                maxLength={7}
              />
              {/^#[0-9a-fA-F]{6}$/.test(c) ? (
                <div style={{ ...colorChipStyle, background: c }} />
              ) : (
                <div style={{ ...colorChipStyle, background: 'var(--sheet-3)' }} />
              )}
            </div>
          ))}
        </div>
        {validColors.length > 0 ? (
          <div style={paletteRowStyle}>
            {validColors.map((c, i) => (
              <div
                key={i}
                style={{
                  ...paletteSwatchStyle,
                  background: c,
                  flex: i === 0 ? 2 : 1,
                }}
                title={c}
              >
                <span style={paletteLabelStyle}>{c}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        kicker="03 · Sprache"
        title="Brand-Voice"
        sub="Tonalität, Dos/Donts, Beispiel-Phrasen. Die KI nutzt das wenn sie Texte fürs Projekt schreibt."
      >
        <textarea
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          onBlur={() => {
            if (voice !== (initial.brandVoice ?? '')) {
              void save({ brandVoice: voice || null });
            }
          }}
          rows={8}
          maxLength={20_000}
          placeholder={`# Tonalität\nKlar, sachlich, ohne Marketing-Fluff. Du-Form außer in Stripe-Receipts.\n\n## Dos\n- Konkrete Zahlen statt Adjektive\n- Direkte Anrede\n\n## Donts\n- Keine Superlative\n- Keine Emojis in Outbound`}
          style={textareaMonoStyle}
        />
      </Section>

      <Section
        kicker="04 · Outbound"
        title="Email-Signatur"
        sub="Wird unter ausgehende Mails der KI angehängt. Markdown."
      >
        <textarea
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          onBlur={() => {
            if (signature !== (initial.emailSignature ?? '')) {
              void save({ emailSignature: signature || null });
            }
          }}
          rows={5}
          maxLength={5000}
          placeholder={`---\n**Max Mustermann**\nKunde GmbH · kunde.com\nm.mustermann@kunde.com`}
          style={textareaMonoStyle}
        />
      </Section>

      <Section
        kicker="05 · Domain"
        title="Kanonische Domain"
        sub="Hauptdomain des Kunden. Wird für mailto-Targets, Schema.org und Receipt-URLs genutzt."
      >
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onBlur={() => {
            if (domain !== (initial.canonicalDomain ?? '')) {
              void save({ canonicalDomain: domain || null });
            }
          }}
          placeholder="kunde.com"
          style={inputStyle}
          maxLength={200}
        />
      </Section>

      <div style={statusBarStyle}>
        <span style={statusPillStyle(status)}>
          {status === 'idle' && 'bereit'}
          {status === 'saving' && 'speichert …'}
          {status === 'saved' && 'gespeichert'}
          {status === 'error' && (errorMsg ?? 'Fehler')}
        </span>
        <span style={hintStyle}>Auto-Save beim Verlassen jedes Felds.</span>
      </div>
    </div>
  );
}

function Section({
  kicker,
  title,
  sub,
  children,
}: {
  kicker: string;
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <div className="t-kicker" style={kickerStyle}>
          <span style={{ width: 30, height: 1, background: 'var(--a-now)' }} />
          {kicker}
        </div>
        <h4 style={sectionTitleStyle}>{title}</h4>
        {sub ? <p style={sectionSubStyle}>{sub}</p> : null}
      </div>
      <div style={sectionBodyStyle}>{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={fieldStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      {hint ? <p style={fieldHintStyle}>{hint}</p> : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 32,
  padding: 'clamp(20px, 3vw, 36px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(20px, 2.6vw, 28px)',
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
};

const leadStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
  maxWidth: 640,
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const kickerStyle: CSSProperties = {
  color: 'var(--a-now)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: '-0.015em',
  color: 'var(--ink)',
};

const sectionSubStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--ink-3)',
  lineHeight: 1.55,
  maxWidth: 640,
};

const sectionBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const fieldLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
};

const fieldHintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--ink-3)',
};

const inputStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
  outline: 'none',
};

const textareaMonoStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  lineHeight: 1.6,
  resize: 'vertical',
  minHeight: 140,
};

const colorRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

const colorFieldStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const colorInputStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  flex: 1,
  minWidth: 0,
};

const colorChipStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '0.5px solid var(--line-2)',
  flexShrink: 0,
};

const paletteRowStyle: CSSProperties = {
  display: 'flex',
  height: 64,
  borderRadius: 12,
  overflow: 'hidden',
  border: '0.5px solid var(--line-2)',
  marginTop: 4,
};

const paletteSwatchStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'flex-end',
  padding: 8,
  minWidth: 0,
};

const paletteLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'rgba(255,255,255,0.85)',
  background: 'rgba(0,0,0,0.4)',
  padding: '2px 6px',
  borderRadius: 4,
};

const previewWrapStyle: CSSProperties = {
  marginTop: 8,
  padding: 14,
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const logoImgStyle: CSSProperties = {
  maxHeight: 80,
  maxWidth: '100%',
  objectFit: 'contain',
};

const statusBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  paddingTop: 12,
  borderTop: '0.5px dashed var(--line-2)',
};

function statusPillStyle(status: SaveStatus): CSSProperties {
  const color =
    status === 'saved'
      ? 'var(--a-clientb)'
      : status === 'error'
        ? 'var(--a-danger)'
        : status === 'saving'
          ? 'var(--a-now)'
          : 'var(--ink-3)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '4px 10px',
    borderRadius: 999,
    border: `0.5px solid ${color}`,
    color,
  };
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-3)',
};
