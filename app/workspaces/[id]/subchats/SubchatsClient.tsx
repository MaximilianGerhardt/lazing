'use client';

/**
 * SubchatsClient — list + create + management of the sub-chats of a workspace
 * (internal view). When creating an external sub-chat, the shareable
 * customer link is shown ONCE (copy). Per row: rename · delete · manage link
 * (revoke/renew + copy) via the verified API routes.
 * Gathering-Intelligence-Goal P2 (2026-06-02). Mobile-first, Apple-quiet.
 *
 * NOTE (flag to parent): the list-GET route does NOT return shareExpiresAt /
 * shareRevokedAt to the client — so we show link status only as
 * „Link aktiv" / „Kein aktiver Link", no precise expiry date. Likewise there is
 * (yet) NO /archive route → „Archivieren" is deliberately omitted until
 * POST /api/subchats/[subchatId]/archive exists (calls archiveSubchat).
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { IconBack } from '@/lib/subchats/ui/icons';
import { SubchatSearch } from '@/lib/subchats/SubchatSearch';

interface SubchatItem {
  id: string;
  title: string;
  kind: 'external' | 'internal';
  description: string | null;
  hasExternalAccess: boolean;
  status: 'active' | 'archived';
  updatedAt: number;
}

type CreateKind = 'external' | 'internal';

/**
 * „Allgemein" is the workspace default (ensureGeneralSubchat) — gets pinned.
 * ensureGeneralSubchat creates the default as kind:'external' (customer main
 * conversation), so match ONLY on the title, not on kind.
 */
function isGeneral(it: SubchatItem): boolean {
  return it.title.trim() === 'Allgemein';
}

/** Stable sort: default („Allgemein") first, then updatedAt descending. */
function sortItems(rows: SubchatItem[]): SubchatItem[] {
  return [...rows].sort((a, b) => {
    const ga = isGeneral(a) ? 0 : 1;
    const gb = isGeneral(b) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return b.updatedAt - a.updatedAt;
  });
}

export function SubchatsClient({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const [items, setItems] = useState<SubchatItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [createKind, setCreateKind] = useState<CreateKind>('external');
  const [showForm, setShowForm] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Per-row management
  const [menuFor, setMenuFor] = useState<string | null>(null); // subchatId with open action sheet
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null); // subchatId with an in-flight share/delete mutation

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/subchats`, { cache: 'no-store' });
      if (!res.ok) { setStatus('error'); return; }
      const data = (await res.json()) as { subchats: SubchatItem[] };
      setItems(sortItems(data.subchats));
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => sortItems(items), [items]);

  const create = useCallback(async () => {
    const t = title.trim();
    if (t.length < 1 || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/subchats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t, kind: createKind }),
      });
      if (res.ok) {
        const data = (await res.json()) as { externalUrl?: string | null };
        // Internal sub-chats return no externalUrl → no link reveal.
        if (data.externalUrl) {
          // Server returns the full public URL (tunnel/domain). Only if
          // exceptionally relative, fill in with the current origin.
          setLastLink(
            /^https?:\/\//.test(data.externalUrl)
              ? data.externalUrl
              : `${window.location.origin}${data.externalUrl}`,
          );
        }
        setTitle('');
        setShowForm(false);
        await load();
      }
    } finally {
      setCreating(false);
    }
  }, [title, creating, workspaceId, createKind, load]);

  const copyLink = useCallback(async () => {
    if (!lastLink) return;
    try {
      await navigator.clipboard.writeText(lastLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }, [lastLink]);

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setRenameFor(null);
    setRenameText('');
    setConfirmDel(null);
  }, []);

  // --- Rename ---
  const startRename = useCallback((it: SubchatItem) => {
    setRenameFor(it.id);
    setRenameText(it.title);
    setConfirmDel(null);
  }, []);

  const submitRename = useCallback(async (id: string) => {
    const t = renameText.trim();
    if (t.length < 1 || renameBusy) return;
    setRenameBusy(true);
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      if (res.ok) {
        const data = (await res.json()) as { subchat?: { title?: string } };
        const nextTitle = data.subchat?.title ?? t;
        setItems((prev) => sortItems(prev.map((x) => (x.id === id ? { ...x, title: nextTitle } : x))));
        closeMenu();
        await load();
      }
    } finally {
      setRenameBusy(false);
    }
  }, [renameText, renameBusy, load, closeMenu]);

  // --- Delete ---
  const doDelete = useCallback(async (id: string) => {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setItems((prev) => prev.filter((x) => x.id !== id));
        closeMenu();
        await load();
      }
    } finally {
      setRowBusy(null);
    }
  }, [rowBusy, load, closeMenu]);

  // --- Manage link ---
  const revokeLink = useCallback(async (id: string) => {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(id)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'revoke' }),
      });
      if (res.ok) {
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, hasExternalAccess: false } : x)));
        await load();
      }
    } finally {
      setRowBusy(null);
    }
  }, [rowBusy, load]);

  const renewLink = useCallback(async (id: string, hours: number) => {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(id)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'renew', hours }),
      });
      if (res.ok) {
        const data = (await res.json()) as { externalUrl?: string | null };
        if (data.externalUrl) {
          setLastLink(
            /^https?:\/\//.test(data.externalUrl)
              ? data.externalUrl
              : `${window.location.origin}${data.externalUrl}`,
          );
        }
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, hasExternalAccess: true } : x)));
        closeMenu();
        await load();
      }
    } finally {
      setRowBusy(null);
    }
  }, [rowBusy, load, closeMenu]);

  const regenerateLink = useCallback(async (id: string) => {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(id)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate' }),
      });
      if (res.ok) {
        const data = (await res.json()) as { externalUrl?: string | null };
        if (data.externalUrl) {
          setLastLink(
            /^https?:\/\//.test(data.externalUrl)
              ? data.externalUrl
              : `${window.location.origin}${data.externalUrl}`,
          );
        }
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, hasExternalAccess: true } : x)));
        closeMenu();
        await load();
      }
    } finally {
      setRowBusy(null);
    }
  }, [rowBusy, load, closeMenu]);

  const menuItem = menuFor ? sorted.find((x) => x.id === menuFor) ?? null : null;

  return (
    <div style={shell}>
      <header style={headerStyle}>
        <a href="/" style={backLink} aria-label="Zurück"><IconBack size={22} /></a>
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', flex: 1 }}>Sub-Chats</div>
        <button type="button" style={newBtn} onClick={() => setShowForm((s) => !s)}>+ Neu</button>
      </header>

      <div style={body}>
        {/* Messenger standard: search across the sub-chat knowledge, pinned at the top
            (like WhatsApp/iMessage). Searches by content (RAG) across all chats and
            jumps to the hit via deep link. */}
        <div style={{ marginBottom: 14 }}>
          <SubchatSearch placeholder="Sub-Chat-Wissen durchsuchen" />
        </div>
        <p style={lead}>
          Gruppenchats mit Kunden oder Team. Alles fließt als Wissen in den Workspace — der Haupt-Chat greift es auf.
        </p>

        {showForm && (
          <div style={formCard}>
            <div style={segWrap} role="group" aria-label="Art des Sub-Chats">
              <button
                type="button"
                onClick={() => setCreateKind('external')}
                aria-pressed={createKind === 'external'}
                style={createKind === 'external' ? segPillActive : segPill}
              >
                Kunde
              </button>
              <button
                type="button"
                onClick={() => setCreateKind('internal')}
                aria-pressed={createKind === 'internal'}
                style={createKind === 'internal' ? segPillActive : segPill}
              >
                Team
              </button>
            </div>
            <div style={segHelper}>
              {createKind === 'external' ? 'Kundenchat (extern)' : 'Team-Chat (intern)'}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
              placeholder={'Titel, z.B. „Kunde XY — Onboarding"'}
              autoFocus
              style={inputStyle}
            />
            <button type="button" onClick={() => void create()} disabled={title.trim().length < 1 || creating} style={primaryBtn}>
              {creating ? 'Lege an …' : 'Sub-Chat anlegen'}
            </button>
          </div>
        )}

        {lastLink && (
          <div style={linkCard}>
            <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 6 }}>Kunden-Link (einmalig sichtbar — jetzt kopieren):</div>
            <div style={linkRow}>
              <span style={linkText}>{lastLink}</span>
              <button type="button" onClick={() => void copyLink()} style={copyBtn}>{copied ? 'Kopiert' : 'Kopieren'}</button>
            </div>
          </div>
        )}

        {status === 'loading' ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 14, padding: '20px 0' }}>Lädt …</div>
        ) : status === 'error' ? (
          <div style={{ color: 'var(--ink-2)', fontSize: 14, padding: '20px 0' }}>Konnte Sub-Chats nicht laden.</div>
        ) : sorted.length === 0 ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 14, padding: '20px 0' }}>Noch keine Sub-Chats. Leg den ersten an.</div>
        ) : (
          <ul style={list}>
            {sorted.map((it) => {
              const general = isGeneral(it);
              const renaming = renameFor === it.id && menuFor === it.id;
              return (
                <li key={it.id} style={rowWrap}>
                  <a
                    href={`/workspaces/${encodeURIComponent(workspaceId)}/subchats/${encodeURIComponent(it.id)}`}
                    style={rowLink}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={rowTitle}>{it.title}</div>
                      {(() => {
                        const meta = rowMetaParts(it, general);
                        return (
                          <div style={rowMeta}>
                            <span>{meta.text}</span>
                            {meta.flag && (
                              <span style={rowFlag}>
                                <span style={rowFlagDot} aria-hidden="true" />
                                {meta.flag}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </a>
                  <button
                    type="button"
                    onClick={() => { setMenuFor(it.id); setRenameFor(null); setConfirmDel(null); }}
                    style={dotsBtn}
                    aria-label="Aktionen"
                  >
                    <DotsIcon />
                  </button>
                  {/* Inline rename directly below the row (ergonomic on mobile) */}
                  {renaming && (
                    <div style={inlineEdit}>
                      <input
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(it.id); }}
                        placeholder="Neuer Titel"
                        autoFocus
                        style={inputStyle}
                      />
                      <div style={inlineRow}>
                        <button type="button" onClick={() => closeMenu()} style={ghostBtn}>Abbrechen</button>
                        <button
                          type="button"
                          onClick={() => void submitRename(it.id)}
                          disabled={renameText.trim().length < 1 || renameBusy}
                          style={primaryBtnSm}
                        >
                          {renameBusy ? 'Speichert …' : 'Speichern'}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Bottom action sheet — Apple-quiet, ≤180ms slide-up */}
      {menuItem && !renameFor && (
        <div style={sheetBackdrop} onClick={closeMenu}>
          <style>{'@keyframes subchatSheetUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}'}</style>
          <div style={sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={menuItem.title}>
            <div style={sheetHandle} aria-hidden="true" />
            <div style={sheetTitle}>{menuItem.title}</div>

            <button type="button" style={sheetAction} onClick={() => startRename(menuItem)}>
              Umbenennen
            </button>

            {/* Manage link — only for external sub-chats */}
            {menuItem.kind === 'external' && (
              <div style={sheetSection}>
                <div style={sheetSectionLabel}>
                  {menuItem.hasExternalAccess ? 'Link aktiv' : 'Kein aktiver Link'}
                </div>
                {menuItem.hasExternalAccess && (
                  <button
                    type="button"
                    style={sheetAction}
                    disabled={rowBusy === menuItem.id}
                    onClick={() => void revokeLink(menuItem.id)}
                  >
                    Link widerrufen
                  </button>
                )}
                <button
                  type="button"
                  style={sheetAction}
                  disabled={rowBusy === menuItem.id}
                  onClick={() => void renewLink(menuItem.id, 720)}
                >
                  {menuItem.hasExternalAccess ? 'Link erneuern' : 'Neuen Link erzeugen'}
                </button>
                {menuItem.hasExternalAccess && (
                  <button
                    type="button"
                    style={sheetAction}
                    disabled={rowBusy === menuItem.id}
                    onClick={() => void regenerateLink(menuItem.id)}
                  >
                    Neuen Token (alter Link wird ungültig)
                  </button>
                )}
              </div>
            )}

            {/* Delete — hidden for „Allgemein" (default), no accidental deletion */}
            {!isGeneral(menuItem) && (
              confirmDel === menuItem.id ? (
                <div style={sheetSection}>
                  <div style={sheetSectionLabel}>Wirklich löschen? Das kann nicht rückgängig gemacht werden.</div>
                  <div style={inlineRow}>
                    <button type="button" onClick={() => setConfirmDel(null)} style={ghostBtn}>Abbrechen</button>
                    <button
                      type="button"
                      onClick={() => void doDelete(menuItem.id)}
                      disabled={rowBusy === menuItem.id}
                      style={dangerBtn}
                    >
                      {rowBusy === menuItem.id ? 'Lösche …' : 'Löschen'}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" style={sheetActionDanger} onClick={() => setConfirmDel(menuItem.id)}>
                  Löschen
                </button>
              )
            )}

            <button type="button" style={sheetCancel} onClick={closeMenu}>Schließen</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline 3-dot menu glyph (currentColor, no emoji, no icon import). */
function DotsIcon(): React.ReactElement {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

/** Compact relative time „gerade eben / vor 2 Min / vor 2 Std / vor 3 Tg" from updatedAt (ms). */
function relativeTime(updatedAt: number): string {
  const ms = Date.now() - updatedAt;
  if (!Number.isFinite(ms) || ms < 0) return 'gerade eben';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `vor ${hrs} Std`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `vor ${days} Tg`;
  const wks = Math.floor(days / 7);
  return `vor ${wks} Wo`;
}

/**
 * Row meta line with „scent": primarily the last activity (relative time), kind
 * only when not the default („Kunde" for external, otherwise omitted). Link status
 * appears ONLY as an exception (inactive/revoked link of an external chat) —
 * the normal case „Link aktiv" is deliberately not repeated.
 */
function rowMetaParts(it: SubchatItem, general: boolean): { text: string; flag: string | null } {
  const parts: string[] = [relativeTime(it.updatedAt)];
  // Kind only when it differs from the default (external = customer). The default
  // „Allgemein" and internal team chats need no redundant label.
  if (!general && it.kind === 'external') parts.push('Kunde');
  // Exception token: external chat without an active link.
  const flag = it.kind === 'external' && !it.hasExternalAccess ? 'Link inaktiv' : null;
  return { text: parts.join(' · '), flag };
}

const shell: CSSProperties = { display: 'flex', flexDirection: 'column', minHeight: '100dvh', background: 'var(--sheet, #070707)', color: 'var(--ink)', fontFamily: 'var(--font-sans)' };
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: 'max(14px, env(safe-area-inset-top)) 14px 12px', borderBottom: '0.5px solid var(--line-2)' };
const backLink: CSSProperties = { width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1, color: 'var(--ink-2)', textDecoration: 'none', marginLeft: -10 };
const newBtn: CSSProperties = { minHeight: 44, display: 'inline-flex', alignItems: 'center', background: 'var(--sheet-3, #141416)', border: '0.5px solid var(--line-2)', borderRadius: 999, padding: '6px 12px', color: 'var(--ink)', fontSize: 13, cursor: 'pointer' };
const body: CSSProperties = { padding: '14px 16px 40px', maxWidth: 680, width: '100%', margin: '0 auto' };
const lead: CSSProperties = { fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.5, margin: '0 0 16px' };
const formCard: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--sheet-2, #0E0E0F)', border: '0.5px solid var(--line-2)', borderRadius: 14, padding: 14, marginBottom: 14 };
const segWrap: CSSProperties = { display: 'flex', gap: 6 };
const segPill: CSSProperties = { flex: 1, minHeight: 44, padding: '0 10px', borderRadius: 10, border: '0.5px solid var(--line-2)', background: 'var(--sheet-3, #141416)', color: 'var(--ink-2)', fontSize: 13, fontWeight: 550, cursor: 'pointer', whiteSpace: 'nowrap' };
const segPillActive: CSSProperties = { ...segPill, background: 'var(--a-now, #2E6FF2)', color: 'var(--on-accent)', border: '0.5px solid var(--a-now, #2E6FF2)' };
const segHelper: CSSProperties = { fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.4, margin: '-2px 2px 0' };
const inputStyle: CSSProperties = { background: 'var(--sheet, #070707)', border: '0.5px solid var(--line-2)', borderRadius: 10, padding: '11px 13px', color: 'var(--ink)', fontSize: 16, outline: 'none' };
const primaryBtn: CSSProperties = { minHeight: 44, background: 'var(--a-now, #2E6FF2)', color: 'var(--on-accent)', border: 'none', borderRadius: 10, padding: '11px', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const primaryBtnSm: CSSProperties = { minHeight: 44, background: 'var(--a-now, #2E6FF2)', color: 'var(--on-accent)', border: 'none', borderRadius: 10, padding: '0 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: CSSProperties = { minHeight: 44, background: 'var(--sheet-3, #141416)', border: '0.5px solid var(--line-2)', borderRadius: 10, padding: '0 16px', color: 'var(--ink-2)', fontSize: 13, cursor: 'pointer' };
const dangerBtn: CSSProperties = { minHeight: 44, background: 'var(--sheet-3, #141416)', border: '0.5px solid var(--line-2)', borderRadius: 10, padding: '0 16px', color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const linkCard: CSSProperties = { background: 'color-mix(in oklab, var(--a-now) 10%, transparent)', border: '0.5px solid var(--line-2)', borderRadius: 14, padding: 14, marginBottom: 14 };
const linkRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const linkText: CSSProperties = { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--ink)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const copyBtn: CSSProperties = { flexShrink: 0, background: 'var(--sheet-3, #141416)', border: '0.5px solid var(--line-2)', borderRadius: 8, padding: '6px 10px', color: 'var(--ink)', fontSize: 12, cursor: 'pointer' };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const rowWrap: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 8, background: 'var(--sheet-2, #0E0E0F)', border: '0.5px solid var(--line-2)', borderRadius: 12, padding: '4px 6px 4px 14px' };
const rowLink: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: '9px 0', textDecoration: 'none', color: 'var(--ink)' };
const rowTitle: CSSProperties = { fontSize: 15, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowMeta: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--ink-3)', marginTop: 2 };
const rowFlag: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink-2)' };
const rowFlagDot: CSSProperties = { width: 6, height: 6, borderRadius: 999, background: 'var(--a-attn, var(--ink-2))', flexShrink: 0 };
const dotsBtn: CSSProperties = { flexShrink: 0, width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 10, color: 'var(--ink-3)', cursor: 'pointer', padding: 0, alignSelf: 'center' };
const inlineEdit: CSSProperties = { flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 8px 10px 0' };
const inlineRow: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' };

const sheetBackdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 900, background: 'color-mix(in oklab, var(--sheet) 70%, transparent)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' };
const sheet: CSSProperties = { background: 'var(--sheet-2, #0E0E0F)', borderTop: '0.5px solid var(--line-2)', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '8px 14px max(18px, env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 4, animation: 'subchatSheetUp 0.18s ease-out', maxWidth: 680, width: '100%', margin: '0 auto', boxSizing: 'border-box' };
const sheetHandle: CSSProperties = { width: 36, height: 4, borderRadius: 999, background: 'var(--line-2)', alignSelf: 'center', margin: '4px 0 10px' };
const sheetTitle: CSSProperties = { fontSize: 13, color: 'var(--ink-3)', padding: '0 2px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const sheetAction: CSSProperties = { minHeight: 48, textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 10, padding: '0 4px', color: 'var(--ink)', fontSize: 15, cursor: 'pointer' };
const sheetActionDanger: CSSProperties = { ...sheetAction, color: 'var(--ink-2)' };
const sheetSection: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0 4px', borderTop: '0.5px solid var(--line-2)', marginTop: 4 };
const sheetSectionLabel: CSSProperties = { fontSize: 12, color: 'var(--ink-3)', padding: '2px 2px 4px' };
const sheetCancel: CSSProperties = { minHeight: 48, marginTop: 8, background: 'var(--sheet-3, #141416)', border: '0.5px solid var(--line-2)', borderRadius: 12, color: 'var(--ink-2)', fontSize: 15, fontWeight: 550, cursor: 'pointer' };

export default SubchatsClient;
