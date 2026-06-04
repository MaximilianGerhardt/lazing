'use client';

/**
 * FsmGraph — SVG visualization of the workflow FSM.
 *
 * Pattern 4 Wave 2.3 (2026-05-01).
 *
 * Layout: layer-based via topological depth (BFS from the initial state).
 * States are rounded rects with `--radius-md`, colored by llmSlot:
 *   - 'none'           : neutral (--ink-2 stroke, no fill)
 *   - 'fixed-prompt'   : dashed (stroke-dasharray)
 *   - 'free-inference' : solid with an AI prefix in the header
 *
 * The active state (ctx.activeStateId, optional) is highlighted with --a-now.
 *
 * Wave 2.3 deliberately keeps the SVG logic minimal: greedy layer layout, manual
 * arrow path, no Dagre/Elk dep. For the 7-state sprint that's enough. When workflows
 * with > 12 states arrive, swap to elkjs (Wave 4+).
 */

import type { CSSProperties } from 'react';

interface GraphState {
  id: string;
  label: string;
  llmSlot: 'none' | 'fixed-prompt' | 'free-inference';
  manualOverride: 'allow' | 'forbid';
  transitions: ReadonlyArray<{
    to: string;
    label: string;
  }>;
}

interface FsmGraphProps {
  states: ReadonlyArray<GraphState>;
  initialState: string;
  activeStateId?: string;
}

const NODE_W = 180;
const NODE_H = 76;
const GAP_X = 110;
const GAP_Y = 28;
const PAD = 24;

interface PositionedNode {
  state: GraphState;
  x: number;
  y: number;
  layer: number;
}

interface PositionedTerminal {
  id: '__terminal__';
  x: number;
  y: number;
  layer: number;
}

function buildLayout(
  states: ReadonlyArray<GraphState>,
  initial: string,
): {
  nodes: ReadonlyArray<PositionedNode>;
  terminals: ReadonlyArray<PositionedTerminal>;
  width: number;
  height: number;
  byId: Map<string, PositionedNode | PositionedTerminal>;
} {
  // BFS for layer assignment. Unreachable states go into a
  // separate bucket at the end.
  const layerById = new Map<string, number>();
  const stateById = new Map<string, GraphState>();
  for (const s of states) stateById.set(s.id, s);

  const queue: Array<{ id: string; depth: number }> = [];
  if (stateById.has(initial)) {
    queue.push({ id: initial, depth: 0 });
    layerById.set(initial, 0);
  }
  let hasTerminal = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = stateById.get(cur.id);
    if (!node) continue;
    for (const tr of node.transitions) {
      if (tr.to === '__terminal__') {
        hasTerminal = true;
        continue;
      }
      const existing = layerById.get(tr.to);
      const next = cur.depth + 1;
      if (existing === undefined || existing > next) {
        layerById.set(tr.to, next);
        queue.push({ id: tr.to, depth: next });
      }
    }
  }

  const maxLayer = Math.max(0, ...Array.from(layerById.values()));
  const orphans = states.filter((s) => !layerById.has(s.id));
  for (const o of orphans) {
    layerById.set(o.id, maxLayer + 1);
  }

  const layers = new Map<number, GraphState[]>();
  for (const s of states) {
    const l = layerById.get(s.id) ?? 0;
    const list = layers.get(l) ?? [];
    list.push(s);
    layers.set(l, list);
  }

  // Terminal in its own column on the right.
  const terminalLayer = hasTerminal ? Math.max(maxLayer + 1, layerById.size === 0 ? 1 : maxLayer + 1) : -1;

  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  const positioned: PositionedNode[] = [];
  for (const l of sortedLayers) {
    const stack = layers.get(l) ?? [];
    stack.forEach((s, idx) => {
      positioned.push({
        state: s,
        x: PAD + l * (NODE_W + GAP_X),
        y: PAD + idx * (NODE_H + GAP_Y),
        layer: l,
      });
    });
  }

  const terminals: PositionedTerminal[] = [];
  if (hasTerminal) {
    terminals.push({
      id: '__terminal__',
      x: PAD + terminalLayer * (NODE_W + GAP_X),
      y: PAD,
      layer: terminalLayer,
    });
  }

  const maxCol = Math.max(
    ...positioned.map((n) => n.layer),
    terminalLayer,
    0,
  );
  const maxRow = Math.max(
    ...sortedLayers.map((l) => layers.get(l)?.length ?? 0),
    1,
  );
  const width = PAD * 2 + (maxCol + 1) * NODE_W + maxCol * GAP_X;
  const height = PAD * 2 + maxRow * NODE_H + (maxRow - 1) * GAP_Y;

  const byId = new Map<string, PositionedNode | PositionedTerminal>();
  for (const n of positioned) byId.set(n.state.id, n);
  for (const t of terminals) byId.set(t.id, t);

  return { nodes: positioned, terminals, width, height, byId };
}

function nodeCenter(n: PositionedNode | PositionedTerminal): { cx: number; cy: number } {
  return { cx: n.x + NODE_W / 2, cy: n.y + NODE_H / 2 };
}

function edgePath(
  from: PositionedNode | PositionedTerminal,
  to: PositionedNode | PositionedTerminal,
): string {
  const a = nodeCenter(from);
  const b = nodeCenter(to);
  // Right-edge → left-edge when going to the right
  const fromX = b.cx > a.cx ? from.x + NODE_W : b.cx < a.cx ? from.x : a.cx;
  const toX = b.cx > a.cx ? to.x : b.cx < a.cx ? to.x + NODE_W : b.cx;
  const fromY = a.cy;
  const toY = b.cy;
  // Bezier with a horizontal tangent
  const dx = toX - fromX;
  const ctrl = Math.max(36, Math.abs(dx) * 0.4);
  return `M ${fromX} ${fromY} C ${fromX + ctrl} ${fromY}, ${toX - ctrl} ${toY}, ${toX} ${toY}`;
}

export function FsmGraph(props: FsmGraphProps): React.JSX.Element {
  const layout = buildLayout(props.states, props.initialState);
  if (layout.nodes.length === 0) {
    return (
      <div style={emptyStyle}>
        Workflow-Definition hat keine States. (Stub?)
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      style={svgStyle}
      role="img"
      aria-label="FSM-Graph"
    >
      <defs>
        <marker
          id="wf-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/* Edges */}
      <g style={{ color: 'var(--ink-3)' }}>
        {layout.nodes.flatMap((node) =>
          node.state.transitions.map((tr, idx) => {
            const target = layout.byId.get(tr.to);
            if (!target) return null;
            const path = edgePath(node, target);
            return (
              <g key={`${node.state.id}->${tr.to}-${idx}`}>
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  markerEnd="url(#wf-arrow)"
                  opacity={0.55}
                />
              </g>
            );
          }),
        )}
      </g>

      {/* Nodes */}
      {layout.nodes.map((n) => {
        const isActive = n.state.id === props.activeStateId;
        const isInitial = n.state.id === props.initialState;
        const slot = n.state.llmSlot;
        const stroke = isActive
          ? 'var(--a-now)'
          : slot === 'free-inference'
            ? 'var(--ink)'
            : slot === 'fixed-prompt'
              ? 'var(--ink-2)'
              : 'var(--ink-3)';
        const dash = slot === 'fixed-prompt' ? '4,3' : undefined;
        const fill = isActive
          ? 'color-mix(in oklab, var(--a-now) 12%, var(--sheet-2))'
          : 'var(--sheet-2)';
        return (
          <g key={n.state.id}>
            <rect
              x={n.x}
              y={n.y}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              ry={10}
              fill={fill}
              stroke={stroke}
              strokeWidth={isActive ? 1.5 : 1}
              strokeDasharray={dash}
            />
            <text
              x={n.x + 12}
              y={n.y + 22}
              fill="var(--ink)"
              fontSize={13}
              fontWeight={600}
            >
              {slot === 'free-inference' ? 'AI · ' : ''}
              {n.state.label}
            </text>
            <text
              x={n.x + 12}
              y={n.y + 40}
              fill="var(--ink-3)"
              fontSize={10}
              fontFamily="var(--font-mono, monospace)"
              letterSpacing="0.04em"
            >
              {n.state.id}
            </text>
            <text
              x={n.x + 12}
              y={n.y + 60}
              fill="var(--ink-3)"
              fontSize={10}
              fontFamily="var(--font-mono, monospace)"
            >
              {slot}
              {n.state.manualOverride === 'forbid' ? ' · gesperrt' : ''}
              {isInitial ? ' · start' : ''}
            </text>
          </g>
        );
      })}

      {/* Terminal-Nodes */}
      {layout.terminals.map((t) => (
        <g key="terminal">
          <circle
            cx={t.x + NODE_W / 2}
            cy={t.y + NODE_H / 2}
            r={20}
            fill="var(--sheet-2)"
            stroke="var(--ink)"
            strokeWidth={1.5}
          />
          <circle
            cx={t.x + NODE_W / 2}
            cy={t.y + NODE_H / 2}
            r={10}
            fill="var(--ink)"
          />
          <text
            x={t.x + NODE_W / 2}
            y={t.y + NODE_H + 14}
            fill="var(--ink-3)"
            fontSize={10}
            fontFamily="var(--font-mono, monospace)"
            textAnchor="middle"
          >
            terminal
          </text>
        </g>
      ))}
    </svg>
  );
}

const svgStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'inherit',
  minHeight: 220,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  color: 'var(--ink-3)',
  fontSize: 13,
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
};
