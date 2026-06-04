'use client';

/**
 * lib/subchats/ui/SubchatQuestionsPill.tsx — Question-Spinning Slice 1.
 *
 * Sequentiell-prominente Fragen-Pille über dem Sub-Chat-Composer — eine Frage
 * nach der anderen (wie die Hauptchat-`ChatOpenQuestionsPill`), damit Fragen im
 * Gruppenchat „nicht untergehen". Antworten per Option-Klick ODER Freitext.
 * Plus „Frage anspinnen" für jeden Teilnehmer. Nur Design-Manifest-Tokens, keine
 * Emojis.
 */

import { useState, type CSSProperties } from 'react';

import type { SubchatQuestion, SuggestedQuestion } from './useSubchatQuestions';

export interface SubchatQuestionsPillProps {
  /** Offene, vom Viewer noch unbeantwortete Fragen (seq-sortiert). */
  open: SubchatQuestion[];
  onAnswerOption: (questionId: string, optionId: string) => void;
  onAnswerFreeText: (questionId: string, text: string) => void;
  onSpin: (text: string, options: string[]) => void;
  /** KI-auto-anspinnen: holt KI-Rückfrage-Vorschläge. */
  onSuggestAi?: () => Promise<SuggestedQuestion[]>;
  /** Einen KI-Vorschlag anspinnen (author_kind:'ai'). */
  onSpinAi?: (text: string, options: string[]) => void;
}

export function SubchatQuestionsPill(props: SubchatQuestionsPillProps): React.JSX.Element | null {
  const { open } = props;
  const [expanded, setExpanded] = useState(true);
  const [idx, setIdx] = useState(0);
  const [draft, setDraft] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [spinText, setSpinText] = useState('');
  const [spinOptions, setSpinOptions] = useState('');
  const [aiSugs, setAiSugs] = useState<SuggestedQuestion[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  const askAi = async (): Promise<void> => {
    if (!props.onSuggestAi || aiLoading) return;
    setAiLoading(true);
    try {
      setAiSugs(await props.onSuggestAi());
    } finally {
      setAiLoading(false);
    }
  };

  // KI-Vorschlags-Block (nur wenn onSuggestAi vorhanden). Holt 1–2 Rückfragen,
  // zeigt sie als „anspinnen"-Chips (Owner approved → author_kind:'ai').
  const suggestBlock = props.onSuggestAi ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
      <button type="button" style={spinTrigger} onClick={() => void askAi()} disabled={aiLoading}>
        {aiLoading ? 'KI denkt …' : 'KI Rückfragen vorschlagen lassen'}
      </button>
      {aiSugs.map((s, i) => (
        <div key={i} style={aiSuggestChip}>
          <span style={{ flex: 1 }}>{s.text}</span>
          <button
            type="button"
            style={aiSpinBtn}
            onClick={() => {
              props.onSpinAi?.(s.text, s.options);
              setAiSugs((prev) => prev.filter((_, j) => j !== i));
            }}
          >
            anspinnen
          </button>
        </div>
      ))}
    </div>
  ) : null;

  const total = open.length;
  const safeIdx = total > 0 ? Math.min(idx, total - 1) : 0;
  const current = total > 0 ? open[safeIdx] : null;

  const submitFreeText = (): void => {
    const t = draft.trim();
    if (!current || t.length === 0) return;
    props.onAnswerFreeText(current.id, t);
    setDraft('');
  };

  const submitSpin = (): void => {
    const t = spinText.trim();
    if (t.length === 0) return;
    const opts = spinOptions
      .split(/[|\n]/)
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    props.onSpin(t, opts);
    setSpinText('');
    setSpinOptions('');
    setSpinning(false);
  };

  // Spin-Formular hat Vorrang (auch wenn keine offenen Fragen existieren).
  if (spinning) {
    return (
      <div style={wrap}>
        <div style={spinHeader}>Frage anspinnen</div>
        <textarea
          value={spinText}
          onChange={(e) => setSpinText(e.target.value)}
          placeholder="Deine Frage an die Gruppe…"
          rows={2}
          style={textareaStyle}
          autoFocus
        />
        <input
          value={spinOptions}
          onChange={(e) => setSpinOptions(e.target.value)}
          placeholder="Optionen (mit | getrennt, optional)"
          style={inputStyle}
        />
        <div style={rowEnd}>
          <button type="button" style={ghostBtn} onClick={() => setSpinning(false)}>
            Abbrechen
          </button>
          <button type="button" style={primaryBtn} onClick={submitSpin} disabled={spinText.trim().length === 0}>
            Anspinnen
          </button>
        </div>
      </div>
    );
  }

  // Keine offenen Fragen → der dezente „Frage anspinnen"-Auslöser + KI-Vorschläge.
  if (total === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" style={spinTrigger} onClick={() => setSpinning(true)}>
          + Frage anspinnen
        </button>
        {suggestBlock}
      </div>
    );
  }

  // Eingeklappt → Chip mit Anzahl.
  if (!expanded) {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={chip} onClick={() => setExpanded(true)}>
          <span style={dot} aria-hidden />
          {total} offene {total === 1 ? 'Frage' : 'Fragen'}
        </button>
        <button type="button" style={spinTrigger} onClick={() => setSpinning(true)}>
          + Frage
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={topRow}>
        <span style={counter}>
          {safeIdx + 1} / {total}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {total > 1 ? (
            <>
              <button type="button" style={navBtn} aria-label="Zurück" onClick={() => setIdx((i) => (i - 1 + total) % total)}>
                ‹
              </button>
              <button type="button" style={navBtn} aria-label="Weiter" onClick={() => setIdx((i) => (i + 1) % total)}>
                ›
              </button>
            </>
          ) : null}
          <button type="button" style={navBtn} aria-label="Einklappen" onClick={() => setExpanded(false)}>
            ⌄
          </button>
        </div>
      </div>

      {current ? (
        <>
          <div style={questionText}>{current.text}</div>
          {current.options.length > 0 ? (
            <div style={optionsRow}>
              {current.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  style={optionBtn}
                  onClick={() => props.onAnswerOption(current.id, o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
          <div style={freetextRow}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitFreeText();
                }
              }}
              placeholder="… oder per Freitext antworten"
              style={inputStyle}
            />
            <button type="button" style={primaryBtn} onClick={submitFreeText} disabled={draft.trim().length === 0}>
              Senden
            </button>
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 2 }}>
        <button type="button" style={spinTrigger} onClick={() => setSpinning(true)}>
          + Frage anspinnen
        </button>
      </div>
      {suggestBlock}
    </div>
  );
}

// ---- Styles (Design-Manifest-Tokens, keine Roh-Hex außer Fallbacks) ----------

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  padding: '12px 14px',
  borderRadius: 16,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  marginBottom: 8,
};
const topRow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const counter: CSSProperties = { fontSize: 11.5, color: 'var(--ink-3, rgba(245,245,247,0.45))', fontVariantNumeric: 'tabular-nums' };
const navBtn: CSSProperties = {
  minWidth: 30,
  minHeight: 30,
  borderRadius: 999,
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  background: 'transparent',
  color: 'var(--ink-2, rgba(245,245,247,0.62))',
  font: 'inherit',
  fontSize: 15,
  cursor: 'pointer',
};
const questionText: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink, #F5F5F7)',
  lineHeight: 1.35,
};
const optionsRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 7 };
const optionBtn: CSSProperties = {
  minHeight: 36,
  padding: '7px 14px',
  borderRadius: 999,
  background: 'var(--sheet-3, #161617)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  color: 'var(--ink, #F5F5F7)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
const freetextRow: CSSProperties = { display: 'flex', gap: 7, alignItems: 'center' };
const inputStyle: CSSProperties = {
  flex: 1,
  minHeight: 36,
  padding: '8px 12px',
  borderRadius: 10,
  background: 'var(--sheet-1, #0A0A0B)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  color: 'var(--ink, #F5F5F7)',
  font: 'inherit',
  fontSize: 13,
};
const textareaStyle: CSSProperties = { ...inputStyle, resize: 'vertical', lineHeight: 1.4 };
const primaryBtn: CSSProperties = {
  minHeight: 36,
  padding: '8px 16px',
  borderRadius: 999,
  background: 'var(--ink, #F5F5F7)',
  color: 'var(--bg, #070707)',
  border: 'none',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const ghostBtn: CSSProperties = {
  minHeight: 36,
  padding: '8px 14px',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--ink-2, rgba(245,245,247,0.62))',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
};
const rowEnd: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };
const spinHeader: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--ink, #F5F5F7)' };
const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 38,
  padding: '8px 15px',
  borderRadius: 999,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  color: 'var(--ink, #F5F5F7)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const dot: CSSProperties = { width: 7, height: 7, borderRadius: 999, background: 'var(--a-now, #5E9EFF)' };
const spinTrigger: CSSProperties = {
  minHeight: 32,
  padding: '6px 12px',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--ink-3, rgba(245,245,247,0.45))',
  border: '0.5px dashed var(--line-2, rgba(255,255,255,0.16))',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};
const aiSuggestChip: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 12,
  background: 'rgba(94,158,255,0.10)',
  border: '0.5px solid rgba(94,158,255,0.28)',
  fontSize: 12.5,
  color: 'var(--ink, #F5F5F7)',
};
const aiSpinBtn: CSSProperties = {
  minHeight: 30,
  padding: '5px 12px',
  borderRadius: 999,
  background: 'var(--a-now, #5E9EFF)',
  color: 'var(--bg, #070707)',
  border: 'none',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
};
