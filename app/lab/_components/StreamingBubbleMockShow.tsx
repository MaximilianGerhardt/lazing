'use client';

/**
 * StreamingBubbleMockShow — Lab-Showcase fuer die Live-Streaming-Bubble
 * (Welle 1 · 2026-05-03 · Sub-Plan dazzling-quilt).
 *
 * Skripted-Mock: Phase wechselt connecting → reading → tool → writing
 * in 1s-Intervallen. Wiederholt sich alle 5s. Dient als Decision-Feature
 * im /lab/streaming-bubble fuer das "Agent arbeitet"-Indikator-Design.
 *
 * Sub-Plan B-konform: keine Modals/Overlays. Reines Render der
 * .bub-live-CSS-Klassen aus app/components.css.
 *
 * Wir mocken hier visuell die exakte Struktur die `StreamingAssistant`
 * in lib/chat/ChatShell.tsx rendert — da die Komponente nicht exportiert
 * ist, replizieren wir nur das DOM. Single-Source-of-Truth bleibt
 * useTypingIndicator (das wir hier auch verwenden).
 */

import { useEffect, useState } from 'react';

import {
  computeTypingIndicator,
  type TypingPhase,
  type UseTypingIndicatorArgs,
} from '../../../lib/chat/useTypingIndicator';

interface ScriptStep {
  readonly label: string;
  readonly args: UseTypingIndicatorArgs;
}

const SCRIPT: ReadonlyArray<ScriptStep> = [
  {
    label: 'connecting',
    args: {
      isStreaming: true,
      isMockPending: false,
      serverStreamPending: false,
      agentTurn: { text: '', tools: [] },
      agentStatus: 'connecting',
    },
  },
  {
    label: 'reading',
    args: {
      isStreaming: true,
      isMockPending: false,
      serverStreamPending: false,
      agentTurn: { text: '', tools: [] },
      agentStatus: 'streaming',
    },
  },
  {
    label: 'tool',
    args: {
      isStreaming: true,
      isMockPending: false,
      serverStreamPending: false,
      agentTurn: {
        text: '',
        tools: [
          {
            name: 'Bash',
            status: 'running',
            inputPreview: 'pnpm exec vitest run lib/chat',
          },
        ],
      },
      agentStatus: 'streaming',
    },
  },
  {
    label: 'writing',
    args: {
      isStreaming: true,
      isMockPending: false,
      serverStreamPending: false,
      agentTurn: {
        text:
          'Ich habe die Tests grün bekommen. ' +
          'Single-Source-of-Truth-Hook ist live, ' +
          'stream-footer ist Geschichte.',
        tools: [{ name: 'Bash', status: 'done' }],
      },
      agentStatus: 'streaming',
    },
  },
];

const STEP_MS = 1500;

export function StreamingBubbleMockShow(): React.JSX.Element {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setStepIdx((i) => (i + 1) % SCRIPT.length);
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, []);

  const step = SCRIPT[stepIdx]!;
  const indicator = computeTypingIndicator(step.args);
  const phase: TypingPhase = indicator.phase ?? 'reading';
  const text = step.args.agentTurn?.text ?? '';
  const showText = text.trim().length > 0;

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 720,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--ink-3, #888)',
          fontFamily: 'var(--font-mono, monospace)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        Schritt {stepIdx + 1} / {SCRIPT.length} · {step.label}
      </div>
      <div
        className="bub-live msg-a"
        data-phase={phase}
        role="status"
        aria-live="polite"
        aria-label="Assistant schreibt (Mock)"
      >
        <button
          type="button"
          onClick={() => {
            // Mock-Stop: einfach zu Schritt 0 zurueck.
            setStepIdx(0);
          }}
          className="bub-live__stop"
          aria-label="Stream abbrechen (Mock)"
          title="Stream abbrechen (Mock)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </button>
        <div className="txt">
          {showText ? (
            <>
              {text}
              <span aria-hidden="true" className="bub-caret" />
            </>
          ) : null}
        </div>
        <div
          className="bub-live__phase"
          data-tone={phase === 'connecting' ? 'idle' : 'active'}
        >
          {phase === 'writing' ? null : (
            <span className="typing-dots" aria-hidden="true">
              <span className="typing-dots__dot" />
              <span className="typing-dots__dot" />
              <span className="typing-dots__dot" />
            </span>
          )}
          <span>{indicator.label}</span>
        </div>
      </div>
    </div>
  );
}

export default StreamingBubbleMockShow;
