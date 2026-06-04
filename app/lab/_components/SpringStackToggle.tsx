"use client";

/**
 * /lab Spring-Stack-Toggle — Decision-Feature (Welle 8, 2026-05-01).
 *
 * Rendert dieselbe Card-Komponente zweimal nebeneinander, einmal mit
 * pure-CSS-cubic-bezier (srf-pop, var(--spring-bouncy)) und einmal mit
 * motion/react als Mount-Spring. Replay-Button triggert Re-Mount via
 * Key-Bump beider Spalten gleichzeitig.
 *
 * Ziel: User entscheidet visuell, welcher iOS-Pure-Look überzeugender
 * ist. Gewählter Stack wird für Production used.
 *
 * Tokens-only — keine Inline-Styles. CSS in app/components.css unter
 * Block B'' · SRF-LAB.
 */

import { motion } from "motion/react";
import { useState, type ReactNode } from "react";

export interface SpringStackToggleProps {
  /**
   * Children werden in BEIDEN Spalten identisch gerendert. Re-Mount
   * passiert über `key` auf dem Wrapper, daher müssen die Children
   * idempotent renderbar sein.
   */
  cardChildren: ReactNode;
}

export function SpringStackToggle({
  cardChildren,
}: SpringStackToggleProps): React.JSX.Element {
  const [replayKey, setReplayKey] = useState(0);

  const replay = (): void => {
    setReplayKey((k) => k + 1);
  };

  return (
    <div className="srf-spring-compare">
      <div className="srf-spring-compare__intro">
        <h3 className="srf-spring-compare__intro-title">
          Spring-Stack-Vergleich
        </h3>
        <p className="srf-spring-compare__intro-body">
          Identische Card, zwei Animations-Backends. Klick „Replay" um
          beide Mount-Animationen synchron neu zu starten.
        </p>
      </div>
      <button
        type="button"
        onClick={replay}
        className="srf-spring-compare__replay"
        aria-label="Mount-Animation neu starten"
      >
        ↻ Replay Animation
      </button>
      <div className="srf-spring-compare__grid">
        <div className="srf-spring-compare__col">
          <header className="srf-spring-compare__col-header">
            <h4 className="srf-spring-compare__col-title">Pure-CSS</h4>
            <small className="srf-spring-compare__col-meta">
              cubic-bezier · var(--spring-bouncy)
            </small>
          </header>
          <div
            key={`css-${replayKey}`}
            className="srf-spring-compare__css-card"
          >
            {cardChildren}
          </div>
        </div>
        <div className="srf-spring-compare__col">
          <header className="srf-spring-compare__col-header">
            <h4 className="srf-spring-compare__col-title">Motion-Library</h4>
            <small className="srf-spring-compare__col-meta">
              spring · stiffness 380 · damping 30 · mass 1
            </small>
          </header>
          <motion.div
            key={`motion-${replayKey}`}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 380,
              damping: 30,
              mass: 1,
            }}
            className="srf-spring-compare__motion-card"
          >
            {cardChildren}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
