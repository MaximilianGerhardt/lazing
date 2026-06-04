'use client';

/**
 * app/agents/AgentProfilesClient.tsx — „Mitarbeiter"-Profile-UI (2026-06-03).
 *
 * Macht die agent_profiles-API nutzbar: Liste + Anlege-Formular. Ein
 * „Mitarbeiter" = Rolle + allow-gelistetes Capability-Bundle (Skills/MCP/SOPs).
 * Nur laz.ing-Design-Tokens (Pitch-Black), keine Emojis.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

const ROLES = [
  'architect',
  'coder',
  'tester',
  'reviewer',
  'security',
  'perf',
  'policy-checker',
  'curator',
  'judge',
  'researcher',
  'planner',
  'scribe',
] as const;

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

function csv(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export default function AgentProfilesClient(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('scribe');
  const [skills, setSkills] = useState('');
  const [mcp, setMcp] = useState('');
  const [sops, setSops] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/profiles', { cache: 'no-store' });
      if (r.ok) {
        const d = (await r.json()) as { profiles?: Profile[] };
        setProfiles(Array.isArray(d.profiles) ? d.profiles : []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    setError(null);
    if (name.trim().length < 2) {
      setError('Name zu kurz (≥ 2 Zeichen).');
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
          role,
          skills: csv(skills),
          mcpServers: csv(mcp),
          sops: csv(sops),
          ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(b.message || b.error || `HTTP ${r.status}`);
        return;
      }
      setName('');
      setDescription('');
      setSkills('');
      setMcp('');
      setSops('');
      setWorkspaceId('');
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (id: string): Promise<void> => {
    // Optimistic
    setProfiles((p) => p.filter((x) => x.id !== id));
    await fetch(`/api/agents/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  };

  return (
    <div style={wrap}>
      <header style={head}>
        <div>
          <h1 style={h1}>Mitarbeiter</h1>
          <p style={sub}>
            Benannte Rollen-Profile mit Skill-/MCP-/SOP-Bundle — ad-hoc spawnbar.
          </p>
        </div>
        {!open ? (
          <button type="button" style={primaryBtn} onClick={() => setOpen(true)}>
            + Mitarbeiter anlegen
          </button>
        ) : null}
      </header>

      {open ? (
        <section style={formCard}>
          <div style={fieldRow}>
            <label style={label}>Name</label>
            <input
              style={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Kunden-Report-Mitarbeiter Nord"
              autoFocus
            />
          </div>
          <div style={fieldRow}>
            <label style={label}>Beschreibung</label>
            <input
              style={input}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Wozu dient dieser Mitarbeiter?"
            />
          </div>
          <div style={fieldRow}>
            <label style={label}>Rolle</label>
            <select style={input} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div style={fieldRow}>
            <label style={label}>Skills (Komma-getrennt)</label>
            <input style={input} value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="xlsx, pdf, brand-guidelines" />
          </div>
          <div style={fieldRow}>
            <label style={label}>MCP-Server</label>
            <input style={input} value={mcp} onChange={(e) => setMcp(e.target.value)} placeholder="github, ruflo-memory" />
          </div>
          <div style={fieldRow}>
            <label style={label}>Pflicht-SOPs (Gate)</label>
            <input style={input} value={sops} onChange={(e) => setSops(e.target.value)} placeholder="lazing-policy-checker" />
          </div>
          <div style={fieldRow}>
            <label style={label}>Workspace-Scope (optional)</label>
            <input style={input} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="leer = global/personal" />
          </div>
          {error ? <div style={errStyle}>{error}</div> : null}
          <div style={formActions}>
            <button type="button" style={ghostBtn} onClick={() => setOpen(false)}>
              Abbrechen
            </button>
            <button type="button" style={primaryBtn} onClick={() => void submit()} disabled={saving}>
              {saving ? 'Speichere …' : 'Anlegen'}
            </button>
          </div>
        </section>
      ) : null}

      <div style={list}>
        {loading ? (
          <div style={emptyStyle}>Lade …</div>
        ) : profiles.length === 0 ? (
          <div style={emptyStyle}>Noch kein Mitarbeiter angelegt.</div>
        ) : (
          profiles.map((p) => (
            <article key={p.id} style={profileCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={profileName}>{p.name}</div>
                  <div style={profileMeta}>
                    <span style={roleBadge}>{p.role}</span>
                    {p.workspaceId ? <span style={scopeBadge}>{p.workspaceId}</span> : <span style={scopeBadge}>global</span>}
                  </div>
                </div>
                <button type="button" style={archiveBtn} onClick={() => void archive(p.id)} aria-label="Archivieren">
                  Archivieren
                </button>
              </div>
              {p.description ? <div style={profileDesc}>{p.description}</div> : null}
              {(p.skills.length > 0 || p.mcpServers.length > 0 || p.sops.length > 0) ? (
                <div style={bundleRow}>
                  {p.skills.map((s) => (
                    <span key={`sk-${s}`} style={tag}>skill:{s}</span>
                  ))}
                  {p.mcpServers.map((s) => (
                    <span key={`mc-${s}`} style={tagMcp}>mcp:{s}</span>
                  ))}
                  {p.sops.map((s) => (
                    <span key={`so-${s}`} style={tagSop}>sop:{s}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Styles (Design-Manifest-Tokens) ----------------------------------------
const wrap: CSSProperties = { maxWidth: 720, margin: '0 auto', padding: 'clamp(16px,4vw,28px)', display: 'flex', flexDirection: 'column', gap: 18 };
const head: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' };
const h1: CSSProperties = { fontFamily: 'var(--font-display)', fontSize: 'clamp(26px,5vw,34px)', fontWeight: 600, letterSpacing: '-0.03em', margin: 0, color: 'var(--ink,#F5F5F7)' };
const sub: CSSProperties = { margin: '6px 0 0', fontSize: 13.5, color: 'var(--ink-2,rgba(245,245,247,0.6))' };
const formCard: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, borderRadius: 18, background: 'var(--sheet-2,#0E0E0F)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))' };
const fieldRow: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--ink-2,rgba(245,245,247,0.62))' };
const input: CSSProperties = { minHeight: 40, padding: '9px 12px', borderRadius: 10, background: 'var(--sheet-1,#0A0A0B)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', color: 'var(--ink,#F5F5F7)', font: 'inherit', fontSize: 14 };
const formActions: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 };
const primaryBtn: CSSProperties = { minHeight: 40, padding: '9px 18px', borderRadius: 999, background: 'var(--ink,#F5F5F7)', color: 'var(--bg,#070707)', border: 'none', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: CSSProperties = { minHeight: 40, padding: '9px 16px', borderRadius: 999, background: 'transparent', color: 'var(--ink-2,rgba(245,245,247,0.62))', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', font: 'inherit', fontSize: 14, cursor: 'pointer' };
const errStyle: CSSProperties = { fontSize: 13, color: 'var(--danger,#FF6B6B)' };
const list: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const emptyStyle: CSSProperties = { padding: 24, textAlign: 'center', color: 'var(--ink-3,rgba(245,245,247,0.45))', fontSize: 13.5 };
const profileCard: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 16, background: 'var(--sheet-2,#0E0E0F)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.1))' };
const profileName: CSSProperties = { fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ink,#F5F5F7)' };
const profileMeta: CSSProperties = { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' };
const profileDesc: CSSProperties = { fontSize: 13, color: 'var(--ink-2,rgba(245,245,247,0.6))' };
const roleBadge: CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: 'rgba(94,158,255,0.16)', color: 'var(--a-now,#5E9EFF)' };
const scopeBadge: CSSProperties = { fontSize: 11.5, padding: '3px 9px', borderRadius: 999, background: 'var(--sheet-3,#161617)', color: 'var(--ink-3,rgba(245,245,247,0.5))' };
const bundleRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };
const tag: CSSProperties = { fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--sheet-3,#161617)', color: 'var(--ink-2,rgba(245,245,247,0.6))' };
const tagMcp: CSSProperties = { ...tag, color: 'rgba(120,255,180,0.8)' };
const tagSop: CSSProperties = { ...tag, color: 'rgba(255,200,120,0.85)' };
const archiveBtn: CSSProperties = { fontSize: 12, padding: '5px 11px', borderRadius: 999, background: 'transparent', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', color: 'var(--ink-3,rgba(245,245,247,0.45))', cursor: 'pointer' };
