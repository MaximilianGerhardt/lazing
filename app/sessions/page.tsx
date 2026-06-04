import type { Metadata } from 'next';
import { SessionsList } from './SessionsList';

export const metadata: Metadata = {
  title: 'Sessions · lazyOS',
};

export const dynamic = 'force-dynamic';

export default function SessionsPage(): React.JSX.Element {
  return (
    <main className="sheet">
      <header
        style={{
          maxWidth: 1100,
          marginTop: 'clamp(24px, 4vw, 56px)',
          marginBottom: 32,
        }}
      >
        <div
          className="t-kicker"
          style={{ color: 'var(--a-now)', marginBottom: 16 }}
        >
          Claude Sessions · alle Kontexte
        </div>
        <h1
          className="t-h2"
          style={{ fontSize: 'clamp(24px, 3vw, 36px)', letterSpacing: '-0.02em' }}
        >
          Weitermachen wo du warst.
        </h1>
        <p
          style={{
            marginTop: 12,
            maxWidth: 680,
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--ink-2)',
          }}
        >
          Jede Claude-Code-Session — egal ob im Terminal oder in lazyOS gestartet —
          erscheint hier. Klick &bdquo;Fortsetzen&ldquo; und du redest weiter mit dem
          gleichen Context.
        </p>
      </header>

      <SessionsList />
    </main>
  );
}
