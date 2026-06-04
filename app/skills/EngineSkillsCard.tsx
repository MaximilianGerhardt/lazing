'use client';

/**
 * app/skills/EngineSkillsCard.tsx — cross-engine skills (2026-06-03).
 *
 * Browser management of the laz.ing skill layer: shows installed SKILL.md
 * skills + which engines (claude/codex) they are synced into, + installing from
 * path/Git + re-syncing. Design tokens only, no emojis.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

interface EngineSkill {
  id: string;
  name: string;
  description: string;
  source: string | null;
  engines: { 'claude-cli': boolean; 'codex-cli': boolean };
}

export function EngineSkillsCard(): React.JSX.Element {
  const [skills, setSkills] = useState<EngineSkill[]>([]);
  const [store, setStore] = useState('');
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/skills/installed', { cache: 'no-store' });
      if (r.ok) {
        const d = (await r.json()) as { skills?: EngineSkill[]; store?: string };
        setSkills(Array.isArray(d.skills) ? d.skills : []);
        setStore(d.store ?? '');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (): Promise<void> => {
    const src = source.trim();
    if (!src || busy) return;
    setBusy(true);
    setMsg('Installiere … (Git-Quellen können ~10–30 s dauern)');
    try {
      const r = await fetch('/api/skills/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: src }),
      });
      const d = (await r.json().catch(() => ({}))) as { installed?: string[]; message?: string };
      if (!r.ok) {
        setMsg(`Fehlgeschlagen: ${d.message ?? `HTTP ${r.status}`}`);
        return;
      }
      setMsg(`Installiert: ${(d.installed ?? []).join(', ') || '—'} (in claude + codex)`);
      setSource('');
      await load();
    } catch (err) {
      setMsg(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    setMsg('Synce in alle Engines …');
    try {
      await fetch('/api/skills/sync', { method: 'POST' });
      setMsg('Sync abgeschlossen.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={card}>
      <div style={headRow}>
        <div>
          <h2 style={title}>Engine-übergreifende Skills</h2>
          <p style={sub}>
            SKILL.md-Skills aus einem Store, der in <b>claude</b> + <b>codex</b> nativ gesynct und
            für <b>ollama</b> per Prompt injiziert wird. Installierbar aus Pfad oder Git.
          </p>
        </div>
        <button type="button" style={ghostBtn} onClick={() => void sync()} disabled={busy}>
          Sync
        </button>
      </div>

      <div style={installRow}>
        <input
          style={input}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void install();
          }}
          placeholder="z. B. anthropics/skills/skills/pdf  ·  ./mein-skill  ·  git-url"
        />
        <button type="button" style={primaryBtn} onClick={() => void install()} disabled={busy || source.trim().length === 0}>
          {busy ? '…' : 'Installieren'}
        </button>
      </div>
      {msg ? <div style={msgStyle}>{msg}</div> : null}

      <div style={list}>
        {loading ? (
          <div style={empty}>Lade …</div>
        ) : skills.length === 0 ? (
          <div style={empty}>Noch keine engine-übergreifenden Skills installiert.</div>
        ) : (
          skills.map((s) => (
            <article key={s.id} style={skillRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={skillName}>{s.name}</div>
                {s.description ? <div style={skillDesc}>{s.description.slice(0, 160)}</div> : null}
                {s.source ? <div style={skillSrc}>{s.source}</div> : null}
              </div>
              <div style={badges}>
                <span style={s.engines['claude-cli'] ? badgeOn : badgeOff}>claude</span>
                <span style={s.engines['codex-cli'] ? badgeOn : badgeOff}>codex</span>
              </div>
            </article>
          ))
        )}
      </div>
      {store ? <div style={storeNote}>Store: {store}</div> : null}
    </section>
  );
}

// ---- Styles ----
const card: CSSProperties = { marginTop: 22, padding: 18, borderRadius: 18, background: 'var(--sheet-2,#0E0E0F)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', display: 'flex', flexDirection: 'column', gap: 12 };
const headRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 };
const title: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--ink,#F5F5F7)' };
const sub: CSSProperties = { margin: '6px 0 0', fontSize: 13, color: 'var(--ink-2,rgba(245,245,247,0.6))', maxWidth: 560 };
const installRow: CSSProperties = { display: 'flex', gap: 8 };
const input: CSSProperties = { flex: 1, minHeight: 40, padding: '9px 12px', borderRadius: 10, background: 'var(--sheet-1,#0A0A0B)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', color: 'var(--ink,#F5F5F7)', font: 'inherit', fontSize: 13.5 };
const primaryBtn: CSSProperties = { minHeight: 40, padding: '9px 16px', borderRadius: 999, background: 'var(--ink,#F5F5F7)', color: 'var(--bg,#070707)', border: 'none', font: 'inherit', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: CSSProperties = { minHeight: 34, padding: '7px 14px', borderRadius: 999, background: 'transparent', color: 'var(--ink-2,rgba(245,245,247,0.62))', border: '0.5px solid var(--line-2,rgba(255,255,255,0.12))', font: 'inherit', fontSize: 13, cursor: 'pointer' };
const msgStyle: CSSProperties = { fontSize: 12.5, color: 'var(--ink-2,rgba(245,245,247,0.6))' };
const list: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const empty: CSSProperties = { padding: 16, textAlign: 'center', color: 'var(--ink-3,rgba(245,245,247,0.45))', fontSize: 13 };
const skillRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 12, background: 'var(--sheet-1,#0A0A0B)', border: '0.5px solid var(--line-2,rgba(255,255,255,0.08))' };
const skillName: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--ink,#F5F5F7)' };
const skillDesc: CSSProperties = { fontSize: 12, color: 'var(--ink-2,rgba(245,245,247,0.55))', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const skillSrc: CSSProperties = { fontSize: 11, color: 'var(--ink-3,rgba(245,245,247,0.4))', marginTop: 3 };
const badges: CSSProperties = { display: 'flex', gap: 6, flexShrink: 0 };
const badgeOn: CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: 'rgba(120,255,180,0.14)', color: 'rgba(120,255,180,0.9)' };
const badgeOff: CSSProperties = { fontSize: 11, padding: '3px 9px', borderRadius: 999, background: 'var(--sheet-3,#161617)', color: 'var(--ink-3,rgba(245,245,247,0.35))' };
const storeNote: CSSProperties = { fontSize: 11, color: 'var(--ink-3,rgba(245,245,247,0.35))', marginTop: 2 };
