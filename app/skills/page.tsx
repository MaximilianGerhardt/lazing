/**
 * /skills — Liste aller Skills (Built-in + User-defined).
 *
 * Read-Heavy + Inline-Create-Form (Phase S Minimal). Edit-Page kommt
 * später; für jetzt: User können neue Skills anlegen, Built-Ins werden
 * read-only angezeigt mit eindeutigem Marker.
 */

import type { CSSProperties } from 'react';

import { listSkills } from '@/lib/agents/skills/service';
import { ContextBand } from '@/lib/ui/cbd';
import { CreateSkillForm } from './CreateSkillForm';
import { EngineSkillsCard } from './EngineSkillsCard';

export const dynamic = 'force-dynamic';

export default function SkillsPage() {
  const skills = listSkills({ includeArchived: false });
  const builtIns = skills.filter((s) => s.builtIn);
  const userDefined = skills.filter((s) => !s.builtIn);

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 1100 }}>
        <ContextBand
          pillLabel="Skills"
          breadcrumb={`${skills.length} aktiv · ${userDefined.length} eigene`}
        />

        <h1
          className="t-h1"
          style={{
            marginTop: 22,
            fontSize: 'clamp(28px, 4vw, 40px)',
            letterSpacing: '-0.02em',
          }}
        >
          Skills
        </h1>
        <p style={{ color: 'var(--ink-2)', maxWidth: 640, marginTop: 8 }}>
          Skills sind die Fokus-Linsen, mit denen Tier-Spawn-Agents an einer
          Anfrage arbeiten. Pro Slot wird ein Skill ausgewählt (z.B. UX,
          Architecture, Critic). Built-Ins sind die 16 Standard-Skills, du
          kannst eigene anlegen — z.B. „Demo Fitness-Tonalität" oder „TAP-
          Compliance".
        </p>

        <EngineSkillsCard />

        <CreateSkillForm />

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>
            Eigene Skills{' '}
            <span style={countStyle}>({userDefined.length})</span>
          </h2>
          {userDefined.length === 0 ? (
            <div style={emptyStyle}>
              Noch keine eigenen Skills. Lege oben einen an, um Tier-Spawns mit
              individueller Tonalität zu fahren.
            </div>
          ) : (
            <ul style={listStyle}>
              {userDefined.map((s) => (
                <SkillRow key={s.id} skill={s} />
              ))}
            </ul>
          )}
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>
            Built-In Skills{' '}
            <span style={countStyle}>({builtIns.length})</span>
          </h2>
          <ul style={listStyle}>
            {builtIns.map((s) => (
              <SkillRow key={s.id} skill={s} />
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}

interface SkillRowProps {
  skill: {
    id: string;
    name: string;
    focusPrompt: string;
    preferTier: string;
    defaultEffort: string;
    defaultCount: number;
    description: string | null;
    builtIn: boolean;
  };
}

function SkillRow({ skill }: SkillRowProps) {
  return (
    <li style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowHeaderStyle}>
          <span style={skillNameStyle}>{skill.name}</span>
          {skill.builtIn ? (
            <span style={builtInBadgeStyle}>Built-In</span>
          ) : (
            <span style={userBadgeStyle}>Eigen</span>
          )}
          <span style={tierBadgeStyle(skill.preferTier)}>
            {skill.preferTier}
          </span>
          <span style={effortBadgeStyle}>{skill.defaultEffort}</span>
          <span style={countBadgeStyle}>×{skill.defaultCount}</span>
        </div>
        <div style={focusStyle}>{skill.focusPrompt}</div>
        {skill.description ? (
          <div style={descStyle}>{skill.description}</div>
        ) : null}
      </div>
    </li>
  );
}

function tierBadgeStyle(tier: string): CSSProperties {
  const color =
    tier === 'opus'
      ? 'var(--a-own)'
      : tier === 'sonnet'
        ? 'var(--a-private)'
        : 'var(--ink-3)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    border: `0.5px solid ${color}`,
    color,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };
}

const sectionStyle: CSSProperties = {
  marginTop: 36,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
};

const countStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
  color: 'var(--ink-3)',
  fontSize: 13,
  background: 'color-mix(in oklab, var(--sheet-2) 40%, transparent)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

const rowHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 6,
};

const skillNameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const builtInBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--ink-3) 12%, transparent)',
  color: 'var(--ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const userBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--a-now) 14%, transparent)',
  color: 'var(--a-now)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const effortBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-2)',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--sheet-3)',
};

const countBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
};

const focusStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-2)',
  lineHeight: 1.5,
};

const descStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: 'var(--ink-3)',
  fontStyle: 'italic',
};
