import { SubscribeButton } from "@/lib/pwa/SubscribeButton";

export default function WelcomePage() {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  return (
    <main className="sheet">
      <div className="hero" style={{ marginTop: "clamp(40px, 8vw, 120px)" }}>
        <div
          className="t-kicker"
          style={{
            color: "var(--a-now)",
            marginBottom: "28px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
          }}
        >
          <span
            style={{
              width: "40px",
              height: "1px",
              background: "var(--a-now)",
            }}
          />
          laz.ing · v0.1 · Phase 3 · 2026-04-24
        </div>

        <h1 className="t-display" style={{ maxWidth: "1100px" }}>
          Ein <span className="gradient-text">Betriebssystem</span>,
          <br />
          <em style={{ fontStyle: "italic", fontWeight: 300, color: "var(--ink-2)" }}>das dich in Ruhe lässt.</em>
        </h1>

        <p
          style={{
            marginTop: "32px",
            maxWidth: "680px",
            fontSize: "19px",
            lineHeight: 1.55,
            color: "var(--ink-2)",
            letterSpacing: "-0.015em",
          }}
        >
          Surface-First statt Chat-Chaos. Event-Sourced statt Zettelwirtschaft. Multi-Plan statt
          Schwarm-Theater. Pure <b style={{ color: "var(--ink)", fontWeight: 500 }}>Apple-Ästhetik</b> statt generisches
          Dashboard. Phase 3 ist live: Chat-Shell, Decision-Log, Stream-Lanes, Kalender.
          Aktivier Push — jede Release-Welle kommt als stille Notifikation.
        </p>

        <div
          style={{
            marginTop: "56px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "1px",
            background: "var(--line)",
            border: "1px solid var(--line)",
            borderRadius: "16px",
            overflow: "hidden",
            maxWidth: "1100px",
          }}
        >
          <div className="p-cell" style={pCellBase}>
            <div className="t-meta" style={{ marginBottom: "14px", color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              PHASE 3 · LIVE
            </div>
            <div className="t-h3" style={{ fontSize: "22px", marginBottom: "10px" }}>
              Chat · <em style={{ fontStyle: "italic", fontWeight: 400, color: "var(--a-now)" }}>Decisions</em>
            </div>
            <p style={{ fontSize: "14px", lineHeight: 1.55, color: "var(--ink-2)" }}>
              Interaktive Chat-Shell mit Mock-Agent, Decision-Log cross-segment, Stream-Lanes je
              Segment, Kalender mit Heute-Block.
            </p>
          </div>
          <div className="p-cell" style={pCellBase}>
            <div className="t-meta" style={{ marginBottom: "14px", color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              PHASE 1 · GRUNDLAGE
            </div>
            <div className="t-h3" style={{ fontSize: "22px", marginBottom: "10px" }}>
              <em style={{ fontStyle: "italic", fontWeight: 400, color: "var(--a-clientb)" }}>16</em> Komponenten
            </div>
            <p style={{ fontSize: "14px", lineHeight: 1.55, color: "var(--ink-2)" }}>
              CMD · CHT · DEC · CHR · TCK · INV · PIL · TMC · PIP · TRM · ENG · HBT · QCK · TST ·
              CBD · BG. Alle live unter /design.
            </p>
          </div>
          <div className="p-cell" style={pCellBase}>
            <div className="t-meta" style={{ marginBottom: "14px", color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              PHASE 4 · UX-KERN
            </div>
            <div className="t-h3" style={{ fontSize: "22px", marginBottom: "10px" }}>
              Ticket-<em style={{ fontStyle: "italic", fontWeight: 400, color: "var(--a-own)" }}>Feedback</em>
            </div>
            <p style={{ fontSize: "14px", lineHeight: 1.55, color: "var(--ink-2)" }}>
              Ein Klick → Testlink → Feedback → Event → Fix-Agent. Pro Phase ein Ticket, pro
              Feature ein Ticket.
            </p>
          </div>
        </div>

        <section
          aria-labelledby="push-heading"
          style={{
            marginTop: "96px",
            paddingTop: "56px",
            borderTop: "0.5px solid var(--line-2)",
            maxWidth: "860px",
          }}
        >
          <div
            className="t-kicker"
            style={{
              color: "var(--a-clientb)",
              marginBottom: "18px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
            }}
          >
            <span style={{ width: "40px", height: "1px", background: "var(--a-clientb)" }} />
            Push · iOS 16.4+ · Desktop
          </div>
          <h2
            id="push-heading"
            className="t-h2"
            style={{ fontSize: "28px", marginBottom: "14px", maxWidth: "640px" }}
          >
            Push aktivieren, <em style={{ fontStyle: "italic", fontWeight: 300, color: "var(--ink-2)" }}>um Phase-Drops zu erhalten</em>.
          </h2>
          <p
            style={{
              fontSize: "15px",
              lineHeight: 1.55,
              color: "var(--ink-2)",
              maxWidth: "600px",
              marginBottom: "28px",
              letterSpacing: "-0.01em",
            }}
          >
            Wenn eine Phase fertig ist oder eine Frage auf dich wartet, kommt eine stille
            Notifikation. Kein Newsletter, kein Marketing — nur Release-Drops und
            Decision-Requests.
          </p>
          <SubscribeButton vapidPublicKey={vapidPublicKey} />
          <p
            style={{
              marginTop: "20px",
              fontSize: "11px",
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.02em",
              maxWidth: "560px",
              lineHeight: 1.6,
            }}
          >
            iOS: zuerst &ldquo;Zum Home-Bildschirm&rdquo; via Safari-Share &rarr; PWA vom
            Home-Screen &ouml;ffnen &rarr; hier &ldquo;Push aktivieren&rdquo;. Desktop:
            direkt klicken, Browser fragt nach Berechtigung.
          </p>
        </section>
      </div>
    </main>
  );
}

const pCellBase: React.CSSProperties = {
  background: "var(--sheet-2)",
  padding: "32px 28px",
  position: "relative",
  overflow: "hidden",
};
