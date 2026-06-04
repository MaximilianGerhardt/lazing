'use client';

/**
 * lib/subchats/ui/useSubchatQuestions.ts — Question-Spinning Slice 1 (Client-Hook).
 *
 * Loads the spun-up questions of a sub-chat, keeps them current (poll + external
 * via realtime refetch by the caller) and exposes spin/answer. The DB is
 * authoritative; the hook only mirrors.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SubchatQuestionOption {
  id: string;
  label: string;
  seq: number;
}
export interface SubchatQuestionAnswer {
  id: string;
  answererKind: string;
  answererId: string | null;
  answererName: string | null;
  optionId: string | null;
  freeText: string | null;
  createdAt: number;
}
export interface SubchatQuestion {
  id: string;
  text: string;
  authorKind: string;
  authorName: string | null;
  seq: number;
  status: 'open' | 'resolved';
  createdAt: number;
  options: SubchatQuestionOption[];
  answers: SubchatQuestionAnswer[];
}

export interface SuggestedQuestion {
  text: string;
  options: string[];
}

export interface UseSubchatQuestionsResult {
  questions: SubchatQuestion[];
  /** Offene Fragen, die DER VIEWER noch NICHT beantwortet hat (seq-sortiert). */
  openForViewer: SubchatQuestion[];
  viewerId: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
  spin: (text: string, options?: string[], aiAuthored?: boolean) => Promise<boolean>;
  answer: (questionId: string, payload: { optionId?: string; freeText?: string }) => Promise<boolean>;
  /** AI auto-spin: fetches 1–2 AI follow-up suggestions (NOT spun). */
  suggestAi: () => Promise<SuggestedQuestion[]>;
}

const POLL_MS = 20_000;

export function useSubchatQuestions(subchatId: string): UseSubchatQuestionsResult {
  const [questions, setQuestions] = useState<SubchatQuestion[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const base = `/api/subchats/${encodeURIComponent(subchatId)}/questions`;
  const inflight = useRef(false);

  const refetch = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(base, { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const d = (await res.json()) as { questions?: SubchatQuestion[]; viewerId?: string };
      setQuestions(Array.isArray(d.questions) ? d.questions : []);
      setViewerId(d.viewerId ?? null);
    } catch {
      /* non-fatal — next poll retries */
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [base]);

  const spin = useCallback(
    async (text: string, options?: string[], aiAuthored?: boolean): Promise<boolean> => {
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, options: options ?? [], ...(aiAuthored ? { aiAuthored: true } : {}) }),
        });
        await refetch();
        return res.ok;
      } catch {
        return false;
      }
    },
    [base, refetch],
  );

  const suggestAi = useCallback(async (): Promise<SuggestedQuestion[]> => {
    try {
      const res = await fetch(`${base}/suggest-ai`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return [];
      const d = (await res.json()) as { suggestions?: SuggestedQuestion[] };
      return Array.isArray(d.suggestions) ? d.suggestions : [];
    } catch {
      return [];
    }
  }, [base]);

  const answer = useCallback(
    async (questionId: string, payload: { optionId?: string; freeText?: string }): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(questionId)}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await refetch();
        return res.ok;
      } catch {
        return false;
      }
    },
    [base, refetch],
  );

  useEffect(() => {
    void refetch();
    const t = window.setInterval(() => void refetch(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refetch]);

  const openForViewer = questions
    .filter((q) => q.status === 'open')
    .filter((q) => !q.answers.some((a) => a.answererId && a.answererId === viewerId))
    .sort((a, b) => a.seq - b.seq);

  return { questions, openForViewer, viewerId, loading, refetch, spin, answer, suggestAi };
}
