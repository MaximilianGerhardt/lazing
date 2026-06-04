/**
 * useTypingIndicator — single source of truth for the "agent is working" status.
 *
 * Wave 1 · 2026-05-03 · Sub-Plan dazzling-quilt.
 * --------------------------------------------------------------------------
 * Consolidates the THREE previously independent phase-label functions:
 *
 *   1. `StreamingAssistant.describePhase`         (lib/chat/ChatShell.tsx)
 *   2. stream-footer inline logic                 (lib/chat/ChatShell.tsx)
 *   3. `InlineWorkerStatus.describePhase`         (lib/chat/InlineWorkerStatus.tsx)
 *
 * User frustration 2026-05-03: "auf app.laz.ing ist immer noch redundant" — the
 * stream footer duplicates the phase information that is already in the
 * StreamingAssistant bubble. Caret + dots + three different
 * "Schreibt …" strings side by side.
 *
 * **Pure function, no polling, no state, no effect.** All inputs
 * flow in, a deterministic state comes out. This makes testing
 * trivial and there is only ONE decision path for the label.
 *
 * Consumers:
 *   - `StreamingAssistant` (bubble phase label)
 *   - every future display that needs to know "is the agent working?"
 *
 * **Not the job** of this hook: cross-workstream status. The
 * activity endpoint + `InlineWorkerStatus` is responsible for that.
 */

import { useMemo } from 'react';

export type TypingKind = 'streaming' | 'pending' | 'background' | 'none';

export type TypingPhase = 'connecting' | 'reading' | 'tool' | 'writing';

export interface TypingIndicatorTool {
  readonly name: string;
  readonly status: string;
  readonly inputPreview?: string;
}

export interface TypingIndicatorState {
  /** Discriminator for the display variant. */
  readonly kind: TypingKind;
  /** Only set when kind='streaming'. */
  readonly phase?: TypingPhase;
  /** Tool name in the tool phase (for debug + lab mocks). */
  readonly toolName?: string;
  /**
   * User-facing label, e.g. "Liest deine Frage …" or "Schreibt …".
   * Empty string when kind='none'.
   */
  readonly label: string;
  /** Passed through so consumers can filter. */
  readonly workstreamId?: string;
}

export interface UseTypingIndicatorArgs {
  readonly workstreamId?: string;
  readonly isStreaming: boolean;
  readonly isMockPending: boolean;
  readonly serverStreamPending: boolean;
  readonly agentTurn: {
    readonly text: string;
    readonly tools: ReadonlyArray<TypingIndicatorTool>;
  } | null;
  readonly agentStatus:
    | 'idle'
    | 'connecting'
    | 'streaming'
    | 'error'
    | 'not_configured';
}

/**
 * Maps a tool name → user language. Robust against Claude-Code-CLI naming.
 * Identical to the `toolPhaseLabel` function in ChatShell.tsx — that one is
 * removed there in Wave 1.5 and replaced by `import { toolPhaseLabel }`.
 */
export function toolPhaseLabel(name: string, inputPreview: string): string {
  const n = name.toLowerCase();
  const preview =
    inputPreview.length > 48 ? inputPreview.slice(0, 45) + '…' : inputPreview;
  if (n === 'read') return preview ? `Liest ${preview} …` : 'Liest Datei …';
  if (n === 'write') return preview ? `Schreibt ${preview} …` : 'Schreibt Datei …';
  if (n === 'edit') return preview ? `Editiert ${preview} …` : 'Editiert Datei …';
  if (n === 'bash') return preview ? `Führt aus: ${preview} …` : 'Führt Befehl aus …';
  if (n === 'grep') return preview ? `Sucht: ${preview} …` : 'Sucht in Workspace-Daten …';
  if (n === 'glob') return 'Listet Dateien …';
  if (n === 'websearch' || n === 'webfetch') return 'Recherchiert im Web …';
  if (n === 'task' || n === 'agent') return 'Spawnt Sub-Agent …';
  if (n === 'todowrite') return 'Aktualisiert Plan …';
  return `${name} …`;
}

/**
 * Pure function. Same inputs → same output. Tests must be able to call this
 * directly without mounting React.
 */
export function computeTypingIndicator(
  args: UseTypingIndicatorArgs,
): TypingIndicatorState {
  const {
    workstreamId,
    isStreaming,
    isMockPending,
    serverStreamPending,
    agentTurn,
    agentStatus,
  } = args;

  // Streaming takes precedence over everything else.
  if (isStreaming) {
    const text = agentTurn?.text ?? '';
    const tools = agentTurn?.tools ?? [];
    const hasText = text.trim().length > 0;
    const lastTool = tools.length > 0 ? tools[tools.length - 1] : null;
    const lastIsRunning = lastTool !== null && lastTool.status === 'running';

    let phase: TypingPhase;
    let label: string;
    let toolName: string | undefined;

    if (!hasText && agentStatus === 'connecting') {
      phase = 'connecting';
      label = 'Verbindet …';
    } else if (!hasText && lastIsRunning && lastTool) {
      phase = 'tool';
      toolName = lastTool.name;
      label = toolPhaseLabel(lastTool.name, lastTool.inputPreview ?? '');
    } else if (!hasText) {
      phase = 'reading';
      label = 'Liest deine Frage …';
    } else {
      phase = 'writing';
      label = 'Schreibt …';
    }

    return {
      kind: 'streaming',
      phase,
      toolName,
      label,
      workstreamId,
    };
  }

  // Mock or server pending WITHOUT an active stream → light pending state.
  if (isMockPending || serverStreamPending) {
    return {
      kind: 'pending',
      label: 'Liest deine Frage …',
      workstreamId,
    };
  }

  // Nothing is running in the current turn.
  return { kind: 'none', label: '', workstreamId };
}

/**
 * React hook wrapper around `computeTypingIndicator`. Memoizes the state on
 * stable inputs so consumers can render without an additional `useMemo`.
 */
export function useTypingIndicator(
  args: UseTypingIndicatorArgs,
): TypingIndicatorState {
  return useMemo(
    () => computeTypingIndicator(args),
    // We want referential stability over the values, not the
    // identity of `args` — agentTurn objects are recreated on every
    // token tick, but their relevant fields do not necessarily
    // change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      args.workstreamId,
      args.isStreaming,
      args.isMockPending,
      args.serverStreamPending,
      args.agentTurn?.text ?? '',
      args.agentTurn?.tools.length ?? 0,
      args.agentTurn?.tools[args.agentTurn.tools.length - 1]?.name ?? '',
      args.agentTurn?.tools[args.agentTurn.tools.length - 1]?.status ?? '',
      args.agentTurn?.tools[args.agentTurn.tools.length - 1]?.inputPreview ?? '',
      args.agentStatus,
    ],
  );
}
