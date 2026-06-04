'use client';

/**
 * SubagentFleetCard — laz.ing chat-card variant of the V2 SubagentFleet
 * surface (BACKPORT-02, 2026-05-23).
 *
 * Ported from
 * `packages/manifestation/src/surfaces/SubagentFleet/SubagentFleet.tsx`.
 * The V2 surface is wrapped in a <ManifestationFrame>; lazyos chat-cards
 * are flat (see LiveSwarm.tsx for the pattern), so the Frame is dropped
 * and the existing chat-card border surface carries the chrome.
 *
 * Renders up to 5 parallel subagent panes as a coordinated fleet:
 *   - Fleet header  ("Fleet · N Subagents · M/N done")
 *   - Per-pane row: role glyph, title, status pill, file count
 *   - Secondary affordance: Abort (while live) / Diff (post-success)
 *   - Global "Abort fleet" while any pane is running; "Dismiss" otherwise
 *
 * INV-13 — `tailLine` is hard-capped at 12 chars (the reducer SHOULD
 * already cap; this is a belt-and-suspenders guard).
 * N11 — Max 5 panes (defensive `.slice(0, 5)`).
 *
 * Pure presentation — the parent owns pane state. The SSE wiring lands
 * in a follow-up; for now the card is driven by props so the smoke-test
 * + API endpoint can render the fleet directly.
 */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';

import {
  SUBAGENT_FLEET_MAX_PANES,
  SUBAGENT_FLEET_TAIL_MAX_CHARS,
  type SubagentFleetResolutionEvent,
  type SubagentPane,
  type SubagentPaneRole,
  type SubagentPaneStatus,
} from './SubagentFleetCard.types';

const ROLE_GLYPH: Record<SubagentPaneRole, string> = {
  architect: '▣',
  coder: '▷',
  tester: '◇',
  reviewer: '◐',
  security: '▦',
  perf: '↯',
  generic: '•',
};

const ROLE_LABEL: Record<SubagentPaneRole, string> = {
  architect: 'Architect',
  coder: 'Coder',
  tester: 'Tester',
  reviewer: 'Reviewer',
  security: 'Security',
  perf: 'Perf',
  generic: 'Step',
};

const STATUS_LABEL: Record<SubagentPaneStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  aborted: 'Aborted',
};

interface SubagentFleetCardProps {
  readonly fleetTitle: string;
  readonly panes: ReadonlyArray<SubagentPane>;
  readonly activePaneId?: string;
  readonly onResolve?: (event: SubagentFleetResolutionEvent) => void;
}

function SubagentFleetCardImpl({
  fleetTitle,
  panes,
  activePaneId,
  onResolve,
}: SubagentFleetCardProps) {
  // N11 defensive cap.
  const cappedPanes = useMemo<ReadonlyArray<SubagentPane>>(
    () => panes.slice(0, SUBAGENT_FLEET_MAX_PANES),
    [panes],
  );

  const doneCount = useMemo(
    () => cappedPanes.filter((p) => p.status === 'done').length,
    [cappedPanes],
  );

  const anyRunning = useMemo(
    () => cappedPanes.some((p) => p.status === 'running' || p.status === 'queued'),
    [cappedPanes],
  );

  const emit = useCallback(
    (event: SubagentFleetResolutionEvent): void => {
      onResolve?.(event);
    },
    [onResolve],
  );

  if (cappedPanes.length === 0) return null;

  const headerLabel = `Fleet · ${cappedPanes.length} Subagents · ${doneCount}/${cappedPanes.length} done`;

  return (
    <div
      data-testid="subagent-fleet-card"
      data-pane-count={cappedPanes.length}
      data-done-count={doneCount}
      style={cardStyle}
    >
      <div style={eyebrowStyle}>SUBAGENT FLEET</div>
      <div style={titleStyle}>{fleetTitle}</div>

      <div style={headerRowStyle}>
        <span data-testid="subagent-fleet-head-label" style={headerLabelStyle}>
          {headerLabel}
        </span>
        {anyRunning ? (
          <button
            type="button"
            onClick={() => emit({ kind: 'abort-fleet' })}
            data-testid="subagent-fleet-abort"
            aria-label="Abort all subagents in this fleet"
            style={secondaryBtnStyle}
          >
            Abort fleet
          </button>
        ) : (
          <button
            type="button"
            onClick={() => emit({ kind: 'dismiss' })}
            data-testid="subagent-fleet-dismiss"
            aria-label="Dismiss fleet summary"
            style={secondaryBtnStyle}
          >
            Dismiss
          </button>
        )}
      </div>

      <ul role="list" data-testid="subagent-fleet-list" style={listStyle}>
        {cappedPanes.map((pane) => (
          <SubagentPaneRow
            key={pane.subagentId}
            pane={pane}
            isActive={pane.subagentId === activePaneId}
            onExpand={() => emit({ kind: 'expand-pane', subagentId: pane.subagentId })}
            onAbort={() => emit({ kind: 'abort-pane', subagentId: pane.subagentId })}
            onOpenDiff={() => emit({ kind: 'open-diff', subagentId: pane.subagentId })}
          />
        ))}
      </ul>
    </div>
  );
}

export const SubagentFleetCard = memo(SubagentFleetCardImpl);

// ─── Pane row ────────────────────────────────────────────────────────────────

interface PaneRowProps {
  readonly pane: SubagentPane;
  readonly isActive: boolean;
  readonly onExpand: () => void;
  readonly onAbort: () => void;
  readonly onOpenDiff: () => void;
}

function SubagentPaneRow({
  pane,
  isActive,
  onExpand,
  onAbort,
  onOpenDiff,
}: PaneRowProps) {
  // INV-13 defensive truncate — reducer SHOULD cap at 12 chars.
  const tail =
    typeof pane.tailLine === 'string' && pane.tailLine.length > 0
      ? pane.tailLine.slice(0, SUBAGENT_FLEET_TAIL_MAX_CHARS)
      : null;

  const fileCount = pane.filesTouched?.length ?? 0;

  const pillTone: 'idle' | 'running' | 'done' | 'issue' =
    pane.status === 'failed'
      ? 'issue'
      : pane.status === 'done'
        ? 'done'
        : pane.status === 'running'
          ? 'running'
          : 'idle';

  return (
    <li
      data-testid={`subagent-fleet-pane-${pane.subagentId}`}
      data-subagent-id={pane.subagentId}
      data-status={pane.status}
      data-role={pane.role}
      data-active={isActive ? 'true' : 'false'}
      style={paneItemStyle}
    >
      <button
        type="button"
        data-testid={`subagent-fleet-pane-button-${pane.subagentId}`}
        onClick={onExpand}
        aria-current={isActive ? 'true' : undefined}
        aria-label={`Expand ${ROLE_LABEL[pane.role]} pane — ${pane.title}`}
        style={{
          ...paneButtonStyle,
          ...(isActive ? activeMarkerStyle : {}),
        }}
      >
        <span aria-hidden="true" style={glyphStyle}>
          {ROLE_GLYPH[pane.role]}
        </span>
        <span style={paneBodyStyle}>
          <span style={paneTitleRowStyle}>
            <span data-testid={`subagent-fleet-pane-title-${pane.subagentId}`} style={paneTitleStyle}>
              {pane.title}
            </span>
            <span
              data-testid={`subagent-fleet-pane-role-${pane.subagentId}`}
              style={paneRoleStyle}
            >
              {ROLE_LABEL[pane.role]}
            </span>
          </span>
          {tail || fileCount > 0 ? (
            <span style={paneMetaStyle} aria-hidden="true">
              {tail ? (
                <span data-testid={`subagent-fleet-pane-tail-${pane.subagentId}`} style={tailStyle}>
                  {tail}
                </span>
              ) : null}
              {fileCount > 0 ? (
                <span data-testid={`subagent-fleet-pane-files-${pane.subagentId}`} style={filesStyle}>
                  {fileCount} file{fileCount === 1 ? '' : 's'}
                </span>
              ) : null}
            </span>
          ) : null}
          {pane.status === 'failed' && pane.errorMessage ? (
            <span
              data-testid={`subagent-fleet-pane-error-${pane.subagentId}`}
              role="alert"
              style={errorStyle}
            >
              {pane.errorMessage}
            </span>
          ) : null}
        </span>
        <span
          data-testid={`subagent-fleet-pane-pill-${pane.subagentId}`}
          data-tone={pillTone}
          style={{ ...pillStyle, ...pillToneStyle(pillTone) }}
        >
          {STATUS_LABEL[pane.status]}
        </span>
      </button>

      {pane.status === 'running' || pane.status === 'queued' ? (
        <button
          type="button"
          data-testid={`subagent-fleet-pane-abort-${pane.subagentId}`}
          aria-label={`Abort ${ROLE_LABEL[pane.role]} pane`}
          onClick={onAbort}
          style={secondaryPaneBtnStyle}
        >
          Abort
        </button>
      ) : pane.status === 'done' ? (
        <button
          type="button"
          data-testid={`subagent-fleet-pane-diff-${pane.subagentId}`}
          aria-label={`Open diff for ${ROLE_LABEL[pane.role]} pane`}
          onClick={onOpenDiff}
          style={secondaryPaneBtnStyle}
        >
          Diff
        </button>
      ) : null}
    </li>
  );
}

// ─── Styles (inline — laz.ing convention prefers tokens, but BACKPORT
//    ships flat to avoid coupling to design-token churn while landing) ───

const cardStyle: CSSProperties = {
  padding: '16px 18px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.02)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.5)',
};
const titleStyle: CSSProperties = { fontSize: 15, fontWeight: 600 };
const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};
const headerLabelStyle: CSSProperties = { fontSize: 13, color: 'rgba(255,255,255,0.75)' };
const secondaryBtnStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.12)',
  color: 'rgba(255,255,255,0.75)',
  cursor: 'pointer',
};
const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  listStyle: 'none',
  padding: 0,
  margin: 0,
};
const paneItemStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'stretch',
  gap: 6,
};
const paneButtonStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.06)',
  background: 'rgba(255,255,255,0.02)',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  minHeight: 56,
};
const activeMarkerStyle: CSSProperties = {
  boxShadow: 'inset 2px 0 0 0 #b079ff',
};
const glyphStyle: CSSProperties = {
  fontSize: 18,
  width: 22,
  display: 'inline-flex',
  justifyContent: 'center',
};
const paneBodyStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};
const paneTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  justifyContent: 'space-between',
};
const paneTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
};
const paneRoleStyle: CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.55)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};
const paneMetaStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  fontSize: 11,
  color: 'rgba(255,255,255,0.5)',
};
const tailStyle: CSSProperties = { fontFamily: 'SF Mono, ui-monospace, monospace', fontSize: 11 };
const filesStyle: CSSProperties = {};
const errorStyle: CSSProperties = { fontSize: 12, color: '#ff7a7a' };
const pillStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.12)',
};
function pillToneStyle(tone: 'idle' | 'running' | 'done' | 'issue'): CSSProperties {
  switch (tone) {
    case 'running':
      return { background: 'rgba(255,200,80,0.08)', borderColor: 'rgba(255,200,80,0.4)', color: '#ffcb55' };
    case 'done':
      return { background: 'rgba(80,255,160,0.08)', borderColor: 'rgba(80,255,160,0.4)', color: '#7eebab' };
    case 'issue':
      return { background: 'rgba(255,90,90,0.08)', borderColor: 'rgba(255,90,90,0.4)', color: '#ff7a7a' };
    default:
      return { background: 'transparent', color: 'rgba(255,255,255,0.6)' };
  }
}
const secondaryPaneBtnStyle: CSSProperties = {
  fontSize: 11,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'transparent',
  color: 'rgba(255,255,255,0.75)',
  cursor: 'pointer',
};
