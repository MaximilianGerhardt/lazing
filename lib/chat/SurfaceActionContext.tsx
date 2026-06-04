'use client';

/**
 * SurfaceActionContext — bridge between surface cards and chat submit.
 *
 * Decision, QuickChoice, approval cards render buttons. When Max clicks
 * one, the button label should automatically go into the chat stream as the
 * next user message — the agent reacts as it would to real text input.
 *
 * Without context the renderer functions would be pure functions with no
 * access to submit(). With context: ChatShell mounts the provider with
 * `submit` as the handler, and every surface card can play back to the
 * chat via useSurfaceAction().
 */

import { createContext, useContext, type ReactNode } from 'react';

interface SurfaceAction {
  /**
   * Sends text as a user reply into the chat.
   * The trigger is typically a click on a decision option,
   * QuickChoice button or approval approve/reject.
   */
  reply: (text: string) => void;
  /**
   * Pushes an additional assistant message directly into the history without
   * an agent roundtrip. Used by TierChoiceCard after a click to show the
   * live-swarm heatmap immediately as a follow-up message.
   */
  pushAssistant: (content: string) => void;
}

const Ctx = createContext<SurfaceAction | null>(null);

export function SurfaceActionProvider({
  reply,
  pushAssistant,
  children,
}: {
  reply: (text: string) => void;
  pushAssistant: (content: string) => void;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ reply, pushAssistant }}>{children}</Ctx.Provider>;
}

/**
 * Hook for surface renderers. Returns no-op functions if no provider
 * is mounted (e.g. /design preview page) — cards render harmlessly there.
 */
export function useSurfaceAction(): SurfaceAction {
  const ctx = useContext(Ctx);
  return (
    ctx ?? {
      reply: () => undefined,
      pushAssistant: () => undefined,
    }
  );
}
