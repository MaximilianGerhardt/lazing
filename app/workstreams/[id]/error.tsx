'use client';

/**
 * Error-Boundary für /workstreams/[id]. Zeigt statt einer leeren Seite
 * eine Diagnose-Karte mit Stack + Retry-Button. Für lazyOS einzeln-User
 * wichtig — wir wollen wissen was schief geht, nicht raten.
 */

import type { CSSProperties } from 'react';
import Link from 'next/link';

export default function WorkstreamDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={wrapStyle}>
        <div style={kickerStyle}>FEHLER · WORKSTREAM-DETAIL</div>
        <h1
          style={{
            marginTop: 14,
            fontSize: 'clamp(24px, 3.4vw, 34px)',
            fontWeight: 500,
            letterSpacing: '-0.02em',
            color: 'var(--ink)',
          }}
        >
          Konnte den Workstream nicht laden.
        </h1>
        <p style={leadStyle}>
          Vermutlich ein DB-Read-Fehler oder ein kaputtes Event in der
          Projektion. Stack steht unten — Reset versucht die Page neu zu
          rendern, ohne neue Daten zu holen.
        </p>

        <pre style={errorBoxStyle}>
          {error.name}: {error.message}
          {error.digest ? `\n\nDigest: ${error.digest}` : ''}
          {error.stack ? `\n\nStack:\n${error.stack}` : ''}
        </pre>

        <div style={actionRowStyle}>
          <button type="button" onClick={() => reset()} style={primaryBtnStyle}>
            Erneut versuchen
          </button>
          <Link href="/workstreams" style={linkBtnStyle}>
            Zurück zur Liste
          </Link>
        </div>
      </section>
    </main>
  );
}

const wrapStyle: CSSProperties = {
  maxWidth: 900,
  marginTop: 'clamp(40px, 6vw, 80px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const kickerStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.16em',
  color: 'var(--a-danger)',
  textTransform: 'uppercase',
};

const leadStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
  maxWidth: 640,
};

const errorBoxStyle: CSSProperties = {
  marginTop: 18,
  padding: 16,
  borderRadius: 12,
  background: 'var(--sheet-3)',
  border: '0.5px solid color-mix(in srgb, var(--a-danger) 40%, var(--line-2))',
  color: 'var(--ink)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  marginTop: 8,
};

const primaryBtnStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
  border: '0.5px solid var(--ink)',
  background: 'var(--ink)',
  color: 'var(--sheet)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const linkBtnStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 13,
  textDecoration: 'none',
};
