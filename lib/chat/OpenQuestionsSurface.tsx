'use client';

/**
 * OpenQuestionsSurface — Sub-Plan 02 (2026-04-29) + Sub-Plan D (2026-04-30).
 *
 * Two render modes (backwards-compat obligation):
 *
 *   1) Workspace mode (old path, Sub-Plan 02):
 *      <OpenQuestionsSurface workspaceId="..." />
 *      Component finds the active workstream itself + polls
 *      /api/workstreams/[id]/questions every 5 s.
 *
 *   2) Surface mode (new, Sub-Plan D):
 *      <OpenQuestionsSurface workstreamId="..." questions={[...]} />
 *      Stateless — questions come from the `<surface:open-questions>` tag.
 *      If `options[]` is set → QuickChoice buttons; otherwise free text.
 *
 * Both modes use the same inject path
 *   POST /api/workstreams/[id]/inject  { message, questionId? }
 * and the same answer status (tracked locally).
 *
 * Position: between WorkflowProgressPanel and the chat stream.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconCheck, IconClose } from '../nav/icons';

interface QuestionsResponse {
  workstreamId: string;
  fromVersion: number;
  questions: Array<{ id: string; text: string; options?: string[] }>;
  answers: Array<{ text: string; ts: number }>;
}

interface ActiveWs {
  id: string;
  status: 'active' | 'paused' | 'done' | 'archived' | 'stuck';
}

/**
 * Sub-Plan D schema — one question in the surface tag.
 * `options` optional → free-text fallback if not set or empty.
 */
export interface QuestionItem {
  id: string;
  q: string;
  options?: string[];
}

interface WorkspaceProps {
  workspaceId: string;
  workstreamId?: never;
  questions?: never;
}

interface SurfaceProps {
  workspaceId?: never;
  workstreamId: string;
  questions: QuestionItem[];
}

type Props = WorkspaceProps | SurfaceProps;

const POLL_MS = 5000;

export function OpenQuestionsSurface(
  props: Props,
): React.JSX.Element | null {
  // Mode discriminator: surfaceMode = direct question list from the surface tag.
  const surfaceMode = 'workstreamId' in props && typeof props.workstreamId === 'string';

  if (surfaceMode) {
    return (
      <OpenQuestionsCore
        workstreamId={props.workstreamId}
        questions={props.questions}
        fromVersion={undefined}
        showCollapseToggle={true}
      />
    );
  }

  return <WorkspaceModeWrapper workspaceId={props.workspaceId} />;
}

// ---------------------------------------------------------------------------
// Workspace-Mode-Wrapper — alter Pfad. Findet aktiven Workstream + pollt API.
// ---------------------------------------------------------------------------

function WorkspaceModeWrapper({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const [ws, setWs] = useState<ActiveWs | null>(null);
  const [data, setData] = useState<QuestionsResponse | null>(null);

  // Active-WS finden
  useEffect(() => {
    let cancelled = false;
    const find = async (): Promise<void> => {
      try {
        const [activeR, stuckR, pausedR] = await Promise.all([
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=active&limit=5`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=stuck&limit=5`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=paused&limit=5`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
        ]);
        if (cancelled) return;
        const all: ActiveWs[] = [
          ...((activeR as { workstreams?: ActiveWs[] }).workstreams ?? []),
          ...((stuckR as { workstreams?: ActiveWs[] }).workstreams ?? []),
          ...((pausedR as { workstreams?: ActiveWs[] }).workstreams ?? []),
        ];
        const first = all[0] ?? null;
        setWs(first);
      } catch {
        if (!cancelled) setWs(null);
      }
    };
    void find();
    const t = setInterval(find, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspaceId]);

  // Poll questions when the WS is known
  useEffect(() => {
    if (!ws) {
      setData(null);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const r = await fetch(
          `/api/workstreams/${encodeURIComponent(ws.id)}/questions`,
          { cache: 'no-store' },
        );
        if (!r.ok) throw new Error(`status ${r.status}`);
        const body = (await r.json()) as QuestionsResponse;
        if (cancelled) return;
        setData(body);
      } catch {
        /* ignore */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [ws]);

  if (!ws || !data || data.questions.length === 0) return null;

  const questions: QuestionItem[] = data.questions.map((q) => ({
    id: q.id,
    q: q.text,
    options: q.options,
  }));

  return (
    <OpenQuestionsCore
      workstreamId={ws.id}
      questions={questions}
      fromVersion={data.fromVersion}
      showCollapseToggle={true}
    />
  );
}

// ---------------------------------------------------------------------------
// Core — shared render+submit logic for both modes.
// ---------------------------------------------------------------------------

interface CoreProps {
  workstreamId: string;
  questions: QuestionItem[];
  fromVersion: number | undefined;
  showCollapseToggle: boolean;
}

function OpenQuestionsCore({
  workstreamId,
  questions,
  fromVersion,
  showCollapseToggle,
}: CoreProps): React.JSX.Element | null {
  const [activeIdx, setActiveIdx] = useState(0);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [answeredLocal, setAnsweredLocal] = useState<Record<string, true>>({});
  /**
   * Per-question toggle: on a QuickChoice question the user can open "Eigene
   * Antwort" → shows the textarea despite existing options.
   */
  const [showFreeText, setShowFreeText] = useState<Record<string, boolean>>({});

  const total = questions.length;

  // Active-Index clamp
  useEffect(() => {
    if (activeIdx >= total) setActiveIdx(Math.max(0, total - 1));
  }, [activeIdx, total]);

  const cur = questions[activeIdx];
  const isAnswered = cur ? answeredLocal[cur.id] === true : false;
  const hasOptions =
    cur !== undefined &&
    Array.isArray(cur.options) &&
    cur.options.length > 0;
  const freeTextOpen = cur ? showFreeText[cur.id] === true : false;

  // ----- Submit -----------------------------------------------------------
  const sendAnswer = useCallback(
    async (answerText: string): Promise<void> => {
      if (!cur) return;
      if (busy) return;
      const trimmed = answerText.trim();
      if (trimmed.length === 0) return;
      setBusy(true);
      setError(null);
      setSuccess(null);
      const message = `Antwort zu "${cur.q}":\n${trimmed}`;
      try {
        const r = await fetch(
          `/api/workstreams/${encodeURIComponent(workstreamId)}/inject`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message, questionId: cur.id }),
          },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as {
            hint?: string;
            error?: string;
          };
          setError(body.hint ?? body.error ?? `HTTP ${r.status}`);
        } else {
          setSuccess('Antwort gesendet — wird bei nächster Welle integriert.');
          setAnsweredLocal((m) => ({ ...m, [cur.id]: true }));
          setDraft('');
          // Auto-move to the next unanswered question
          const nextIdx = questions.findIndex(
            (q, i) => i > activeIdx && !answeredLocal[q.id],
          );
          if (nextIdx >= 0) setActiveIdx(nextIdx);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [cur, busy, workstreamId, questions, activeIdx, answeredLocal],
  );

  const submitFreeText = useCallback(() => {
    void sendAnswer(draft);
  }, [draft, sendAnswer]);

  const submitChoice = useCallback(
    (option: string) => {
      void sendAnswer(option);
    },
    [sendAnswer],
  );

  // ----- Memoize options array for stable key ----------------------------
  const optionList = useMemo(
    () => (cur && Array.isArray(cur.options) ? cur.options : []),
    [cur],
  );

  if (total === 0) return null;
  if (collapsed && showCollapseToggle) {
    return (
      <div className="open-q-collapsed">
        <button
          type="button"
          className="open-q-collapsed-btn"
          onClick={() => setCollapsed(false)}
        >
          {total} {total === 1 ? 'offene Frage' : 'offene Fragen'} · einblenden
        </button>
      </div>
    );
  }

  return (
    <div className="open-q">
      <div className="open-q-header">
        <span className="open-q-label">
          Offene Frage {activeIdx + 1}/{total}
          {fromVersion !== undefined ? ` · V${fromVersion}` : ''}
        </span>
        {showCollapseToggle ? (
          <button
            type="button"
            className="open-q-collapse-btn"
            onClick={() => setCollapsed(true)}
            aria-label="Einklappen"
          >
            <IconClose size={14} />
          </button>
        ) : null}
      </div>
      <div className="open-q-body">
        <button
          type="button"
          className="open-q-chev open-q-chev-left"
          onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
          disabled={activeIdx === 0}
          aria-label="Vorherige Frage"
        >
          ‹
        </button>
        <div className="open-q-text">
          {cur?.q ?? '(keine Frage gefunden)'}
          {isAnswered ? (
            <span className="open-q-answered"><IconCheck size={12} /> beantwortet</span>
          ) : null}
        </div>
        <button
          type="button"
          className="open-q-chev open-q-chev-right"
          onClick={() => setActiveIdx((i) => Math.min(total - 1, i + 1))}
          disabled={activeIdx >= total - 1}
          aria-label="Nächste Frage"
        >
          ›
        </button>
      </div>
      {hasOptions && !freeTextOpen ? (
        <div className="open-q-choice-row" role="group" aria-label="Antwort-Optionen">
          {optionList.map((opt, i) => (
            <button
              key={`${cur?.id ?? 'q'}-opt-${i}`}
              type="button"
              className="open-q-choice-btn"
              onClick={() => submitChoice(opt)}
              disabled={busy || isAnswered}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className="open-q-choice-fallback-btn"
            onClick={() => {
              if (!cur) return;
              setShowFreeText((m) => ({ ...m, [cur.id]: true }));
            }}
            disabled={busy || isAnswered}
            aria-label="Eigene Antwort eingeben"
          >
            Eigene Antwort
          </button>
        </div>
      ) : (
        <div className="open-q-input-row">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Antwort eintippen — wird in V_(n+1) wörtlich integriert."
            className="open-q-textarea"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitFreeText();
              }
            }}
          />
          <button
            type="button"
            className="open-q-submit"
            onClick={submitFreeText}
            disabled={busy || !draft.trim()}
          >
            {busy ? '…' : 'Senden'}
          </button>
          {hasOptions ? (
            <button
              type="button"
              className="open-q-choice-back-btn"
              onClick={() => {
                if (!cur) return;
                setShowFreeText((m) => ({ ...m, [cur.id]: false }));
              }}
              disabled={busy}
              aria-label="Zurück zu Optionen"
            >
              ← Optionen
            </button>
          ) : null}
        </div>
      )}
      {error ? <div className="open-q-error">{error}</div> : null}
      {success ? <div className="open-q-success">{success}</div> : null}
    </div>
  );
}
