"use client";

/**
 * RoutinesHeader — Client-Wrapper fuer Seiten-Header + Liste.
 *
 * Warum ein eigener Header statt Inline in der Page? Der Header enthaelt den
 * "+ Neue Routine"-Button, der den Wizard oeffnet. Der Wizard-Zustand sitzt
 * in RoutinesList — wir kommunizieren ueber ein Custom-Event auf `window`,
 * damit wir Header und Liste sauber trennen koennen ohne eine unnoetig
 * grosse Client-Hierarchie zu bauen.
 */

import { useCallback } from "react";

import { RoutinesList } from "./RoutinesList";
import type { RoutineSummary } from "./types";

export const OPEN_WIZARD_EVENT = "routines:open-wizard";

interface Props {
  initial: RoutineSummary[];
}

export function RoutinesHeader({ initial }: Props) {
  const openWizard = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_WIZARD_EVENT));
  }, []);

  return (
    <div style={{ marginTop: 28 }}>
      <div
        className="t-kicker"
        style={{
          color: "var(--a-now)",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ width: 32, height: 1, background: "var(--a-now)" }} />
        Routines · Proaktiv
      </div>

      <div style={headerRowStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1
            className="t-h1"
            style={{
              fontSize: "clamp(30px, 4.5vw, 44px)",
              letterSpacing: "-0.02em",
              maxWidth: 800,
              margin: 0,
            }}
          >
            Routinen
          </h1>
          <p style={subtitleStyle}>
            Zeitgesteuerte oder Event-getriggerte Auto-Runs. Planen deinen
            Tag oder reagieren auf Events im System.
          </p>
        </div>

        <button
          type="button"
          onClick={openWizard}
          style={createBtnStyle}
        >
          + Neue Routine
        </button>
      </div>

      <RoutinesList initial={initial} />
    </div>
  );
}

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "flex-end",
  justifyContent: "space-between",
  flexWrap: "wrap",
};

const subtitleStyle: React.CSSProperties = {
  marginTop: 12,
  maxWidth: 640,
  fontSize: 15,
  lineHeight: 1.55,
  color: "var(--ink-2)",
};

const createBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid var(--primary)",
  background: "var(--primary)",
  color: "var(--sheet)",
  cursor: "pointer",
  flexShrink: 0,
  alignSelf: "flex-end",
};
