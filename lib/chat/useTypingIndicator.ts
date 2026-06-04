/**
 * useTypingIndicator — Single-Source-of-Truth fuer den "Agent arbeitet"-Status.
 *
 * Welle 1 · 2026-05-03 · Sub-Plan dazzling-quilt.
 * --------------------------------------------------------------------------
 * Konsolidiert die DREI bisher unabhaengigen Phase-Label-Funktionen:
 *
 *   1. `StreamingAssistant.describePhase`         (lib/chat/ChatShell.tsx)
 *   2. stream-footer Inline-Logik                 (lib/chat/ChatShell.tsx)
 *   3. `InlineWorkerStatus.describePhase`         (lib/chat/InlineWorkerStatus.tsx)
 *
 * User-Frust 2026-05-03: "auf app.laz.ing ist immer noch redundant" — der
 * stream-footer dupliziert die Phase-Information die schon in der
 * StreamingAssistant-Bubble steht. Caret + Dots + drei verschiedene
 * "Schreibt …"-Strings nebeneinander.
 *
 * **Pure-Funktion, kein Polling, kein State, kein Effect.** Alle Inputs
 * fliessen rein, ein deterministischer State raus. Damit ist Testen
 * trivial und es gibt nur EINEN Entscheidungs-Pfad fuer das Label.
 *
 * Konsumenten:
 *   - `StreamingAssistant` (Bubble-Phase-Label)
 *   - jede zukuenftige Anzeige die "Agent arbeitet?" wissen muss
 *
 * **Nicht Aufgabe** dieses Hooks: Cross-Workstream-Status. Dafuer ist
 * der Activity-Endpoint + `InlineWorkerStatus` zustaendig.
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
  /** Diskriminator fuer die Anzeige-Variante. */
  readonly kind: TypingKind;
  /** Nur gesetzt wenn kind='streaming'. */
  readonly phase?: TypingPhase;
  /** Tool-Name in der tool-Phase (fuer Debug + lab-Mocks). */
  readonly toolName?: string;
  /**
   * User-faces Label, z.B. "Liest deine Frage …" oder "Schreibt …".
   * Bei kind='none' leerer String.
   */
  readonly label: string;
  /** Wird durchgereicht damit Konsumenten filtern koennen. */
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
 * Mapping Tool-Name → User-Sprache. Robust gegen Claude-Code-CLI-Naming.
 * Identisch zur `toolPhaseLabel`-Funktion in ChatShell.tsx — die wird in
 * Welle 1.5 dort entfernt und durch `import { toolPhaseLabel }` ersetzt.
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
 * Pure-Funktion. Gleiche Inputs → gleicher Output. Tests muessen das
 * direkt aufrufen koennen ohne React zu mounten.
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

  // Streaming hat Vorrang vor allem anderen.
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

  // Mock- oder Server-Pending OHNE aktiven Stream → leichter Pending-State.
  if (isMockPending || serverStreamPending) {
    return {
      kind: 'pending',
      label: 'Liest deine Frage …',
      workstreamId,
    };
  }

  // Nichts laeuft im aktuellen Turn.
  return { kind: 'none', label: '', workstreamId };
}

/**
 * React-Hook-Wrapper um `computeTypingIndicator`. Memoized den State auf
 * stabilen Inputs damit Konsumenten ohne zusaetzliche `useMemo` rendern
 * koennen.
 */
export function useTypingIndicator(
  args: UseTypingIndicatorArgs,
): TypingIndicatorState {
  return useMemo(
    () => computeTypingIndicator(args),
    // Wir wollen referenzielle Stabilitaet ueber die Werte, nicht
    // Identitaet von `args` — agentTurn-Objekte werden bei jedem
    // Token-Tick neu erzeugt, aber ihre relevanten Felder aendern sich
    // nicht zwingend.
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
