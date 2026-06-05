'use client';

/**
 * app/agents/AgentProfilesClient.tsx — „Mitarbeiter" (Agent-Templates), SP-10.
 *
 * Apple-clean redesign (2026-06-05). A „Mitarbeiter" is a REUSABLE VORLAGE
 * (template), die bei Bedarf einen sparsam-berechtigten Agenten startet (siehe
 * lib/agents/profiles-service.ts → agentProfileToSpawnInput). Diese Seite macht
 * das in Klartext sicht- und bedienbar:
 *
 *   1. Standard-Bildschirm = freundliche PRESET-KARTEN. Tippen → in ~2 Schritten
 *      angelegt (Preset setzt Rolle + Default-Skill-Bundle automatisch).
 *   2. „Anpassen" (Progressive Disclosure) ersetzt die drei Freitext-CSV-Felder
 *      durch kuratierte Mehrfach-Auswahlen: Skills (GET /api/skills), MCP/
 *      Connectors (GET /api/connectors), Pflicht-SOPs (GET /api/sops) und einen
 *      „Sichtbar in"-Workspace-Picker (Default „Überall"). Die 12er-Rollen-
 *      Auswahl ist weg — das Preset bestimmt die Rolle.
 *   3. Ergebnis-Karten in Klartext: „Kann:" / „Verbunden:" / „Pflicht:" plus
 *      eine primäre Aktion „Einsetzen".
 *
 * UI/UX (ui-ux-pro-max): eine primäre CTA pro Bildschirm (§4 primary-action),
 * Progressive Disclosure statt Überladung (§8), 44px-Touch-Targets (§2),
 * Bestätigung vor destruktiven Aktionen (§8), reduced-motion respektiert.
 * Nur laz.ing-Design-Tokens via var(); keine Emojis.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { PROFILE_PRESETS, type ProfilePreset } from '@/lib/agents/profile-presets';

// ---- API shapes -------------------------------------------------------------

interface Profile {
  id: string;
  name: string;
  description: string | null;
  role: string;
  skills: string[];
  mcpServers: string[];
  sops: string[];
  workspaceId: string | null;
  createdAt: number;
}

interface SkillItem {
  id: string;
  name: string;
  description: string | null;
}
interface ConnectorItem {
  provider: string;
  displayName: string;
  needsCredential: boolean;
  connected: boolean | null;
}
interface SopItem {
  id: string;
  name: string;
  builtIn: boolean;
}
interface WorkspaceItem {
  id: string;
  label: string;
}

// ---- Small selection helper -------------------------------------------------

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

// =============================================================================

export default function AgentProfilesClient(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Create-flow state
  const [activePreset, setActivePreset] = useState<ProfilePreset | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [customize, setCustomize] = useState(false);
  const [skillSel, setSkillSel] = useState<string[]>([]);
  const [mcpSel, setMcpSel] = useState<string[]>([]);
  const [sopSel, setSopSel] = useState<string[]>([]);
  const [workspaceSel, setWorkspaceSel] = useState<string>(''); // '' = Überall (global)
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Curated option catalogues (lazy-loaded when „Anpassen" opens)
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [sops, setSops] = useState<SopItem[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/profiles', { cache: 'no-store' });
      if (r.ok) {
        const d = (await r.json()) as { profiles?: Profile[] };
        setProfiles(Array.isArray(d.profiles) ? d.profiles : []);
      }
    } catch {
      /* ignore — empty state covers it */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Lazy-load the curated pickers the first time „Anpassen" is opened.
  const loadOptions = useCallback(async () => {
    if (optionsLoaded) return;
    setOptionsLoaded(true);
    const safeJson = async <T,>(url: string, key: string): Promise<T[]> => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return [];
        const d = (await r.json()) as Record<string, unknown>;
        const v = d[key];
        return Array.isArray(v) ? (v as T[]) : [];
      } catch {
        return [];
      }
    };
    const [sk, co, so, ws] = await Promise.all([
      safeJson<SkillItem>('/api/skills', 'skills'),
      safeJson<ConnectorItem>('/api/connectors', 'connectors'),
      safeJson<SopItem>('/api/sops', 'sops'),
      safeJson<WorkspaceItem>('/api/workspaces', 'workspaces'),
    ]);
    setSkills(sk);
    setConnectors(co);
    setSops(so);
    setWorkspaces(ws);
  }, [optionsLoaded]);

  const resetForm = useCallback(() => {
    setActivePreset(null);
    setName('');
    setDescription('');
    setCustomize(false);
    setSkillSel([]);
    setMcpSel([]);
    setSopSel([]);
    setWorkspaceSel('');
    setError(null);
  }, []);

  // Tap a preset → open the (pre-filled, minimal) create sheet.
  const pickPreset = useCallback((preset: ProfilePreset) => {
    setActivePreset(preset);
    setName(preset.defaultName);
    setDescription('');
    setCustomize(false);
    setSkillSel([]); // empty → service falls back to the role's default bundle
    setMcpSel([]);
    setSopSel([]);
    setWorkspaceSel('');
    setError(null);
  }, []);

  const openCustomize = useCallback(() => {
    setCustomize(true);
    void loadOptions();
  }, [loadOptions]);

  const submit = useCallback(async (): Promise<void> => {
    if (!activePreset) return;
    setError(null);
    if (name.trim().length < 2) {
      setError('Bitte einen Namen mit mindestens 2 Zeichen vergeben.');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/agents/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          role: activePreset.role, // preset sets the role; no role dropdown
          skills: skillSel, // empty = role-default bundle (least-privilege)
          mcpServers: mcpSel,
          sops: sopSel,
          ...(workspaceSel ? { workspaceId: workspaceSel } : {}), // '' = Überall
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(b.message || b.error || `Fehler (HTTP ${r.status}).`);
        return;
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [activePreset, name, description, skillSel, mcpSel, sopSel, workspaceSel, resetForm, load]);

  const archive = useCallback(async (id: string, label: string): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(`„${label}" archivieren?`)) return;
    setProfiles((p) => p.filter((x) => x.id !== id)); // optimistic
    await fetch(`/api/agents/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }, []);

  // „Einsetzen": start a local (ollama-heavy) agent from the template. The
  // existing POST /api/agents/spawn needs a task (verbatim N1 intent) + role.
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const deploy = useCallback(async (p: Profile): Promise<void> => {
    if (typeof window === 'undefined') return;
    const task = window.prompt(`Aufgabe für „${p.name}"?`)?.trim();
    if (!task) return;
    setDeployingId(p.id);
    try {
      const r = await fetch('/api/agents/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent: task,
          parentWorkstreamId: 'ws-default',
          roles: [p.role],
          engines: ['ollama-heavy'], // local engine → no PII-vault workspace gate
        }),
      });
      if (r.ok) {
        window.alert(`„${p.name}" wurde gestartet.`);
      } else {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        window.alert(b.message || `Start fehlgeschlagen (HTTP ${r.status}).`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Start fehlgeschlagen.');
    } finally {
      setDeployingId(null);
    }
  }, []);

  const creating = activePreset !== null;

  return (
    <div style={wrap}>
      <header style={head}>
        <h1 style={h1}>Mitarbeiter</h1>
        <p style={sub}>
          Eine Vorlage, die bei Bedarf einen Helfer mit genau den passenden
          Rechten startet. Wähle einen Typ — fertig.
        </p>
      </header>

      {creating ? (
        <CreateSheet
          preset={activePreset}
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          customize={customize}
          openCustomize={openCustomize}
          skills={skills}
          connectors={connectors}
          sops={sops}
          workspaces={workspaces}
          skillSel={skillSel}
          setSkillSel={setSkillSel}
          mcpSel={mcpSel}
          setMcpSel={setMcpSel}
          sopSel={sopSel}
          setSopSel={setSopSel}
          workspaceSel={workspaceSel}
          setWorkspaceSel={setWorkspaceSel}
          error={error}
          saving={saving}
          onCancel={resetForm}
          onSubmit={() => void submit()}
        />
      ) : (
        <section aria-label="Mitarbeiter-Typen" style={presetGrid}>
          {PROFILE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              style={presetCard}
              onClick={() => pickPreset(p)}
            >
              <span style={presetLabel}>{p.label}</span>
              <span style={presetSummary}>{p.summary}</span>
            </button>
          ))}
        </section>
      )}

      <section aria-label="Angelegte Mitarbeiter" style={list}>
        {loading ? (
          <div style={emptyStyle}>Lade …</div>
        ) : profiles.length === 0 ? (
          !creating ? (
            <div style={emptyStyle}>Noch kein Mitarbeiter angelegt. Wähle oben einen Typ.</div>
          ) : null
        ) : (
          <>
            <h2 style={h2}>Deine Mitarbeiter</h2>
            {profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                connectors={connectors}
                deploying={deployingId === p.id}
                onDeploy={() => void deploy(p)}
                onArchive={() => void archive(p.id, p.name)}
              />
            ))}
          </>
        )}
      </section>
    </div>
  );
}

// =============================================================================
// Create sheet (preset-prefilled, with optional „Anpassen")
// =============================================================================

interface CreateSheetProps {
  preset: ProfilePreset;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  customize: boolean;
  openCustomize: () => void;
  skills: SkillItem[];
  connectors: ConnectorItem[];
  sops: SopItem[];
  workspaces: WorkspaceItem[];
  skillSel: string[];
  setSkillSel: (f: (prev: string[]) => string[]) => void;
  mcpSel: string[];
  setMcpSel: (f: (prev: string[]) => string[]) => void;
  sopSel: string[];
  setSopSel: (f: (prev: string[]) => string[]) => void;
  workspaceSel: string;
  setWorkspaceSel: (v: string) => void;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

function CreateSheet(props: CreateSheetProps): React.JSX.Element {
  const {
    preset,
    name,
    setName,
    description,
    setDescription,
    customize,
    openCustomize,
    skills,
    connectors,
    sops,
    workspaces,
    skillSel,
    setSkillSel,
    mcpSel,
    setMcpSel,
    sopSel,
    setSopSel,
    workspaceSel,
    setWorkspaceSel,
    error,
    saving,
    onCancel,
    onSubmit,
  } = props;

  const workspaceLabel = useMemo(() => {
    if (!workspaceSel) return 'Überall';
    return workspaces.find((w) => w.id === workspaceSel)?.label ?? workspaceSel;
  }, [workspaceSel, workspaces]);

  return (
    <section style={formCard}>
      <div style={sheetHead}>
        <div>
          <div style={sheetKicker}>Neuer Mitarbeiter</div>
          <div style={sheetTitle}>{preset.label}</div>
          <div style={sheetSummary}>{preset.summary}</div>
        </div>
      </div>

      <div style={fieldRow}>
        <label htmlFor="ap-name" style={label}>
          Name
        </label>
        <input
          id="ap-name"
          style={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={preset.defaultName}
          autoFocus
        />
      </div>

      <div style={fieldRow}>
        <label htmlFor="ap-desc" style={label}>
          Beschreibung <span style={labelHint}>(optional)</span>
        </label>
        <input
          id="ap-desc"
          style={input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Wofür ist dieser Mitarbeiter gedacht?"
        />
      </div>

      {!customize ? (
        <button type="button" style={customizeLink} onClick={openCustomize}>
          Anpassen — Fähigkeiten, Werkzeuge &amp; Sichtbarkeit
        </button>
      ) : (
        <div style={customizeBox}>
          <Picker
            title="Kann"
            hint="Was darf dieser Mitarbeiter? Leer = sinnvolle Standard-Fähigkeiten."
            empty="Keine Fähigkeiten verfügbar."
            options={skills.map((s) => ({ value: s.id, label: s.name }))}
            selected={skillSel}
            onToggle={(v) => setSkillSel((prev) => toggle(prev, v))}
          />
          <Picker
            title="Werkzeuge"
            hint="Verbundene Dienste, die er nutzen darf."
            empty="Keine Dienste verbunden."
            options={connectors.map((c) => ({
              value: c.provider,
              label: c.displayName,
              badge: !c.needsCredential
                ? null
                : c.connected
                  ? { text: 'verbunden', tone: 'ok' as const }
                  : { text: 'Zugang nötig', tone: 'warn' as const },
            }))}
            selected={mcpSel}
            onToggle={(v) => setMcpSel((prev) => toggle(prev, v))}
          />
          <Picker
            title="Pflicht"
            hint="Abläufe, die er immer einhalten muss."
            empty="Keine Pflicht-Abläufe vorhanden."
            options={sops.map((s) => ({ value: s.id, label: s.name }))}
            selected={sopSel}
            onToggle={(v) => setSopSel((prev) => toggle(prev, v))}
          />

          <div style={fieldRow}>
            <label htmlFor="ap-scope" style={label}>
              Sichtbar in
            </label>
            <select
              id="ap-scope"
              style={input}
              value={workspaceSel}
              onChange={(e) => setWorkspaceSel(e.target.value)}
            >
              <option value="">Überall</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <span style={labelHint}>Aktuell: {workspaceLabel}</span>
          </div>
        </div>
      )}

      {error ? (
        <div style={errStyle} role="alert">
          {error}
        </div>
      ) : null}

      <div style={formActions}>
        <button type="button" style={ghostBtn} onClick={onCancel}>
          Abbrechen
        </button>
        <button
          type="button"
          style={{ ...primaryBtn, ...(saving ? disabledBtn : null) }}
          onClick={onSubmit}
          disabled={saving}
        >
          {saving ? 'Lege an …' : 'Anlegen'}
        </button>
      </div>
    </section>
  );
}

// =============================================================================
// Curated multi-select picker
// =============================================================================

interface PickerOption {
  value: string;
  label: string;
  badge?: { text: string; tone: 'ok' | 'warn' } | null;
}

function Picker(props: {
  title: string;
  hint: string;
  empty: string;
  options: PickerOption[];
  selected: string[];
  onToggle: (value: string) => void;
}): React.JSX.Element {
  const { title, hint, empty, options, selected, onToggle } = props;
  return (
    <div style={pickerBlock}>
      <div style={pickerHead}>
        <span style={pickerTitle}>{title}</span>
        <span style={pickerHint}>{hint}</span>
      </div>
      {options.length === 0 ? (
        <div style={pickerEmpty}>{empty}</div>
      ) : (
        <div style={chipRow}>
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                style={on ? chipOn : chip}
                onClick={() => onToggle(o.value)}
              >
                <span>{o.label}</span>
                {o.badge ? (
                  <span style={o.badge.tone === 'ok' ? chipBadgeOk : chipBadgeWarn}>
                    {o.badge.text}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Result / list card (de-jargoned)
// =============================================================================

function ProfileCard(props: {
  profile: Profile;
  connectors: ConnectorItem[];
  deploying: boolean;
  onDeploy: () => void;
  onArchive: () => void;
}): React.JSX.Element {
  const { profile: p, connectors, deploying, onDeploy, onArchive } = props;
  const connectorName = useCallback(
    (slug: string) => connectors.find((c) => c.provider === slug)?.displayName ?? slug,
    [connectors],
  );
  return (
    <article style={profileCard}>
      <div style={profileTop}>
        <div style={profileName}>{p.name}</div>
        <div style={profileMeta}>
          {p.workspaceId ? (
            <span style={scopeBadge}>{p.workspaceId}</span>
          ) : (
            <span style={scopeBadge}>Überall</span>
          )}
        </div>
      </div>
      {p.description ? <div style={profileDesc}>{p.description}</div> : null}

      {p.skills.length > 0 ? <FactRow term="Kann" items={p.skills} /> : null}
      {p.mcpServers.length > 0 ? (
        <FactRow term="Verbunden" items={p.mcpServers.map(connectorName)} />
      ) : null}
      {p.sops.length > 0 ? <FactRow term="Pflicht" items={p.sops} /> : null}

      <div style={cardActions}>
        <button
          type="button"
          style={{ ...primaryBtn, ...(deploying ? disabledBtn : null) }}
          onClick={onDeploy}
          disabled={deploying}
        >
          {deploying ? 'Starte …' : 'Einsetzen'}
        </button>
        <button type="button" style={archiveBtn} onClick={onArchive}>
          Archivieren
        </button>
      </div>
    </article>
  );
}

function FactRow(props: { term: string; items: string[] }): React.JSX.Element {
  return (
    <div style={factRow}>
      <span style={factTerm}>{props.term}:</span>
      <span style={factItems}>{props.items.join(', ')}</span>
    </div>
  );
}

// ---- Styles (laz.ing Design-Manifest-Tokens) --------------------------------
const wrap: CSSProperties = {
  maxWidth: 760,
  margin: '0 auto',
  padding: 'clamp(16px,4vw,28px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
};
const head: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const h1: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 'clamp(28px,5vw,36px)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  margin: 0,
  color: 'var(--ink,#F5F5F7)',
};
const h2: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--ink-3,rgba(245,245,247,0.45))',
  margin: '2px 0 2px',
};
const sub: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: 1.5,
  color: 'var(--ink-2,rgba(245,245,247,0.6))',
  maxWidth: 540,
};

// Preset grid
const presetGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 12,
};
const presetCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  alignItems: 'flex-start',
  textAlign: 'left',
  minHeight: 96,
  padding: '16px 18px',
  borderRadius: 18,
  background: 'var(--sheet-2,#0E0E0F)',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))',
  color: 'var(--ink,#F5F5F7)',
  font: 'inherit',
  cursor: 'pointer',
  transition: 'background 180ms ease, border-color 180ms ease',
};
const presetLabel: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink,#F5F5F7)',
};
const presetSummary: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--ink-2,rgba(245,245,247,0.6))',
};

// Create sheet
const formCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 'clamp(16px,3vw,22px)',
  borderRadius: 20,
  background: 'var(--sheet-2,#0E0E0F)',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))',
};
const sheetHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 };
const sheetKicker: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-3,rgba(245,245,247,0.45))',
};
const sheetTitle: CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--ink,#F5F5F7)',
  marginTop: 3,
};
const sheetSummary: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--ink-2,rgba(245,245,247,0.6))',
  marginTop: 4,
};
const fieldRow: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const label: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink,#F5F5F7)',
};
const labelHint: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: 'var(--ink-3,rgba(245,245,247,0.45))',
};
const input: CSSProperties = {
  minHeight: 44,
  padding: '11px 14px',
  borderRadius: 12,
  background: 'var(--sheet-1,#0A0A0B)',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))',
  color: 'var(--ink,#F5F5F7)',
  font: 'inherit',
  fontSize: 15,
};
const customizeLink: CSSProperties = {
  alignSelf: 'flex-start',
  minHeight: 44,
  padding: '10px 0',
  background: 'transparent',
  border: 'none',
  color: 'var(--a-now,#5E9EFF)',
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
};
const customizeBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '16px 0 4px',
  borderTop: '0.5px solid var(--line-2,rgba(255,255,255,0.1))',
};

// Picker
const pickerBlock: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const pickerHead: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const pickerTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink,#F5F5F7)',
};
const pickerHint: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: 'var(--ink-3,rgba(245,245,247,0.45))',
};
const pickerEmpty: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--ink-3,rgba(245,245,247,0.4))',
  padding: '4px 0',
};
const chipRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };
const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 36,
  padding: '7px 13px',
  borderRadius: 999,
  background: 'var(--sheet-1,#0A0A0B)',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.14))',
  color: 'var(--ink-2,rgba(245,245,247,0.7))',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease',
};
const chipOn: CSSProperties = {
  ...chip,
  background: 'var(--ink,#F5F5F7)',
  borderColor: 'var(--ink,#F5F5F7)',
  color: 'var(--bg,#070707)',
  fontWeight: 600,
};
const chipBadgeOk: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 999,
  background: 'rgba(120,255,180,0.16)',
  color: 'rgba(120,255,180,0.95)',
};
const chipBadgeWarn: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 999,
  background: 'rgba(255,200,120,0.16)',
  color: 'rgba(255,200,120,0.95)',
};

// Actions
const formActions: CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 4,
};
const primaryBtn: CSSProperties = {
  minHeight: 44,
  padding: '11px 22px',
  borderRadius: 999,
  background: 'var(--ink,#F5F5F7)',
  color: 'var(--bg,#070707)',
  border: 'none',
  font: 'inherit',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
const disabledBtn: CSSProperties = { opacity: 0.5, cursor: 'default' };
const ghostBtn: CSSProperties = {
  minHeight: 44,
  padding: '11px 18px',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--ink-2,rgba(245,245,247,0.62))',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))',
  font: 'inherit',
  fontSize: 15,
  cursor: 'pointer',
};
const errStyle: CSSProperties = { fontSize: 13.5, color: 'var(--danger,#FF6B6B)' };

// List + result cards
const list: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const emptyStyle: CSSProperties = {
  padding: 28,
  textAlign: 'center',
  color: 'var(--ink-3,rgba(245,245,247,0.45))',
  fontSize: 14,
};
const profileCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 18,
  borderRadius: 18,
  background: 'var(--sheet-2,#0E0E0F)',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.1))',
};
const profileTop: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
};
const profileName: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink,#F5F5F7)',
};
const profileMeta: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' };
const profileDesc: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--ink-2,rgba(245,245,247,0.6))',
};
const scopeBadge: CSSProperties = {
  fontSize: 11.5,
  padding: '3px 10px',
  borderRadius: 999,
  background: 'var(--sheet-3,#161617)',
  color: 'var(--ink-3,rgba(245,245,247,0.5))',
};
const factRow: CSSProperties = { display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.45 };
const factTerm: CSSProperties = {
  fontWeight: 600,
  color: 'var(--ink-2,rgba(245,245,247,0.62))',
  flexShrink: 0,
};
const factItems: CSSProperties = { color: 'var(--ink-2,rgba(245,245,247,0.72))' };
const cardActions: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  marginTop: 4,
};
const archiveBtn: CSSProperties = {
  minHeight: 44,
  fontSize: 13.5,
  padding: '10px 16px',
  borderRadius: 999,
  background: 'transparent',
  border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))',
  color: 'var(--ink-3,rgba(245,245,247,0.5))',
  cursor: 'pointer',
};
