'use client';

import type { CSSProperties, JSX } from 'react';

import { ToolStepCard } from './ToolStepCard';
import { ToolStepGroup } from './ToolStepGroup';
import type { ToolStep } from './types';

interface ToolPipelineProps {
  tools: ToolStep[];
  /** If true, the ladder renders with the top-edge rail (used for
   *  streaming turns). Keeps the visual weight consistent with the
   *  rest of the chat surface. */
  rail?: boolean;
}

/**
 * Vertical ladder of `ToolStepCard`s representing the tool chain
 * Claude ran during one turn. Konsekutive Tools gleicher Art (z.B. 5x Bash)
 * werden zu einem ausklappbaren `ToolStepGroup` gefaltet, damit der Chat
 * nicht von langen Bash-Ketten ueberschwemmt wird (Default: collapsed bei
 * >=2 gleichen Tools hintereinander).
 */
export function ToolPipeline({ tools, rail = false }: ToolPipelineProps): JSX.Element | null {
  if (tools.length === 0) return null;

  // Konsekutive Tools mit gleichem Namen zu Runs zusammenfassen.
  const runs: Array<{ name: string; steps: ToolStep[]; startIndex: number }> = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const last = runs[runs.length - 1];
    if (last && last.name === t.name) {
      last.steps.push(t);
    } else {
      runs.push({ name: t.name, steps: [t], startIndex: i });
    }
  }

  return (
    <div style={rail ? railStyle : baseStyle} aria-label={`${tools.length} Tool-Schritte`}>
      {runs.map((run) => {
        if (run.steps.length === 1) {
          return (
            <ToolStepCard
              key={run.steps[0].id}
              step={run.steps[0]}
              index={run.startIndex}
            />
          );
        }
        // Group fuer 2+ gleiche Tools hintereinander
        return (
          <ToolStepGroup
            key={`group-${run.steps[0].id}`}
            toolName={run.name}
            steps={run.steps}
            startIndex={run.startIndex}
          />
        );
      })}
    </div>
  );
}

const baseStyle: CSSProperties = {
  marginTop: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const railStyle: CSSProperties = {
  ...baseStyle,
  paddingLeft: 12,
  borderLeft: '0.5px solid var(--line)',
  marginLeft: 4,
};
