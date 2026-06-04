'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface CloudBrowserPanelProps {
  workspaceId: string;
  workspaceLabel: string;
  sensitivity: string;
  archived: boolean;
}

interface ArtifactItem {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  pages?: number | null;
  encryptionVersion: number;
  createdBy: string;
  createdAt: string;
  downloadUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
}

interface FolderItem {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
}

interface Stats {
  artifactCount: number;
  totalBytes: number;
  folderCount: number;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Robuster Download-Trigger. iOS Safari ignoriert das `download`-Attribut
 * bei `<a>`-Tags und navigiert stattdessen zur Datei. Wir holen sie als
 * Blob, packen sie in eine ObjectURL und triggern den Save-Dialog künstlich.
 */
async function triggerDownload(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    console.warn('[cloud-download] blob fallback failed', err);
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function CloudBrowserPanel({
  workspaceId,
  workspaceLabel,
  sensitivity,
  archived,
}: CloudBrowserPanelProps): React.JSX.Element {
  const writeBlocked = sensitivity === 'high' || archived;
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>('/');
  const [breadcrumb, setBreadcrumb] = useState<FolderItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactItem | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const folderParam = folderId ?? 'root';
      const [aRes, fRes, sRes] = await Promise.all([
        fetch(
          `/api/cloud?workspace=${encodeURIComponent(workspaceId)}&folder=${encodeURIComponent(folderParam)}`,
          { cache: 'no-store' },
        ),
        fetch(
          `/api/cloud/folders?workspace=${encodeURIComponent(workspaceId)}&parent=${encodeURIComponent(folderParam)}`,
          { cache: 'no-store' },
        ),
        fetch(
          `/api/cloud/stats?workspace=${encodeURIComponent(workspaceId)}`,
          { cache: 'no-store' },
        ),
      ]);
      if (!aRes.ok) throw new Error(`Artifacts ${aRes.status}`);
      if (!fRes.ok) throw new Error(`Folders ${fRes.status}`);
      const aJson = await aRes.json();
      const fJson = await fRes.json();
      const sJson = sRes.ok ? await sRes.json() : null;
      setArtifacts(aJson.artifacts ?? []);
      setFolders(fJson.folders ?? []);
      if (sJson?.stats) setStats(sJson.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, folderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (writeBlocked) {
      setError(
        sensitivity === 'high'
          ? 'Workspace hat sensitivity=high — Upload blockiert bis Encryption-Phase-2.'
          : 'Workspace ist archiviert.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('workspace', workspaceId);
        fd.append('file', file);
        if (folderId) fd.append('folder', folderId);
        const res = await fetch('/api/cloud', { method: 'POST', body: fd });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(`${file.name}: ${j.message ?? res.status}`);
        }
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload-Fehler');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onCreateFolder = async () => {
    if (writeBlocked) return;
    const name = window.prompt('Ordnername:');
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/cloud/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: workspaceId, name, parentId: folderId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? res.status);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder-Fehler');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string, filename: string) => {
    if (!window.confirm(`„${filename}" wirklich löschen?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cloud/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? res.status);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lösch-Fehler');
    } finally {
      setBusy(false);
    }
  };

  const enterFolder = (folder: FolderItem) => {
    setBreadcrumb((b) => [...b, folder]);
    setFolderId(folder.id);
    setFolderPath(folder.path);
  };

  const goRoot = () => {
    setBreadcrumb([]);
    setFolderId(null);
    setFolderPath('/');
  };

  const goCrumb = (idx: number) => {
    const next = breadcrumb.slice(0, idx + 1);
    setBreadcrumb(next);
    const target = next[next.length - 1];
    if (!target) {
      setFolderId(null);
      setFolderPath('/');
    } else {
      setFolderId(target.id);
      setFolderPath(target.path);
    }
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      {writeBlocked && (
        <div
          style={{
            padding: '14px 18px',
            borderRadius: 12,
            border: '0.5px dashed var(--line-2)',
            background: 'color-mix(in oklab, var(--sheet-2) 60%, transparent)',
            color: 'var(--ink-3)',
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 18,
          }}
        >
          {sensitivity === 'high'
            ? 'Workspace hat Sensitivity „high" (DSGVO Art. 9). Upload ist blockiert bis Phase-2 (Encryption-at-Rest). Read-Only-Modus aktiv.'
            : 'Workspace ist archiviert — Read-Only.'}
        </div>
      )}

      {stats && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}
        >
          <Stat label="Dateien" value={String(stats.artifactCount)} />
          <Stat label="Belegt" value={formatBytes(stats.totalBytes)} />
          <Stat label="Ordner" value={String(stats.folderCount)} />
          <Stat label="Workspace" value={workspaceLabel} mono />
        </div>
      )}

      {/* Breadcrumb + Actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <button
          type="button"
          onClick={goRoot}
          style={crumbBtnStyle(breadcrumb.length === 0)}
        >
          /
        </button>
        {breadcrumb.map((c, i) => (
          <span key={c.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--ink-3)' }}>›</span>
            <button
              type="button"
              onClick={() => goCrumb(i)}
              style={crumbBtnStyle(i === breadcrumb.length - 1)}
            >
              {c.name}
            </button>
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={writeBlocked || busy}
          style={actionBtnStyle(writeBlocked || busy)}
        >
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => onUpload(e.target.files)}
        />
        <button
          type="button"
          onClick={onCreateFolder}
          disabled={writeBlocked || busy}
          style={actionBtnStyle(writeBlocked || busy)}
        >
          Neuer Ordner
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            background: 'color-mix(in oklab, #ff5252 12%, transparent)',
            color: '#ffcccc',
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      {/* Folders */}
      {folders.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={sectionTitleStyle}>Ordner</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => enterFolder(f)}
                style={folderCardStyle}
              >
                <svg
                  width={18}
                  height={18}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  style={{ flex: '0 0 auto', lineHeight: 1 }}
                >
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {f.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Artifacts */}
      <div>
        <h3 style={sectionTitleStyle}>Dateien</h3>
        {artifacts.length === 0 ? (
          <div
            style={{
              padding: '36px 0',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            Keine Dateien {folderPath === '/' ? '' : `in ${folderPath}`}.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {artifacts.map((a) => (
              <div key={a.id} style={artifactCardStyle}>
                <div
                  style={{
                    width: '100%',
                    aspectRatio: '4/3',
                    background: '#0a0a0a',
                    borderRadius: 8,
                    border: '0.5px solid var(--line-2)',
                    marginBottom: 10,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <img
                    src={a.thumbnailUrl}
                    alt={a.filename}
                    style={{ maxWidth: '100%', maxHeight: '100%' }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--ink)',
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={a.filename}
                >
                  {a.filename}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--ink-3)',
                    marginTop: 4,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {formatBytes(a.bytes)}
                  {a.pages ? ` · ${a.pages} S.` : ''}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => setPreviewArtifact(a)}
                    style={miniBtnStyle}
                  >
                    Vorschau
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void triggerDownload(a.downloadUrl, a.filename);
                    }}
                    style={miniBtnStyle}
                  >
                    Download
                  </button>
                  {!writeBlocked && (
                    <button
                      type="button"
                      onClick={() => onDelete(a.id, a.filename)}
                      style={{ ...miniBtnStyle, color: '#ff8080' }}
                      aria-label="Löschen"
                    >
                      <svg
                        width={13}
                        height={13}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.6}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M6 6 L18 18 M18 6 L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewArtifact && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewArtifact(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.86)',
            backdropFilter: 'blur(8px)',
            zIndex: 90,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 1100,
              height: '90vh',
              background: 'var(--sheet-1)',
              border: '0.5px solid var(--line-2)',
              borderRadius: 14,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '0.5px solid var(--line-2)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                {previewArtifact.filename}
              </span>
              <button
                type="button"
                onClick={() => setPreviewArtifact(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--ink-3)',
                  fontSize: 16,
                  cursor: 'pointer',
                }}
                aria-label="Schließen"
              >
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M6 6 L18 18 M18 6 L6 18" />
                </svg>
              </button>
            </div>
            <div style={{ flex: 1, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {previewArtifact.mime === 'application/pdf' ? (
                <object
                  data={previewArtifact.previewUrl}
                  type="application/pdf"
                  style={{ width: '100%', height: '100%', border: 0 }}
                  aria-label={previewArtifact.filename}
                >
                  <embed
                    src={previewArtifact.previewUrl}
                    type="application/pdf"
                    style={{ width: '100%', height: '100%', border: 0 }}
                  />
                  <div style={{ padding: 40, color: 'var(--ink-3)', fontSize: 13, textAlign: 'center' }}>
                    Dein Browser zeigt PDFs nicht inline an.{' '}
                    <a
                      href={previewArtifact.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--a-now)' }}
                    >
                      Im neuen Tab öffnen
                    </a>
                  </div>
                </object>
              ) : previewArtifact.mime.startsWith('image/') ? (
                <img
                  src={previewArtifact.previewUrl}
                  alt={previewArtifact.filename}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    margin: 'auto',
                    display: 'block',
                  }}
                />
              ) : (
                <div
                  style={{
                    padding: 40,
                    color: 'var(--ink-3)',
                    fontSize: 13,
                  }}
                >
                  Vorschau für {previewArtifact.mime} nicht verfügbar — bitte
                  herunterladen.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 12,
        border: '0.5px solid var(--line-2)',
        background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: mono ? 12 : 16,
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  );
}

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  marginBottom: 10,
};

const crumbBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 10px',
  borderRadius: 6,
  border: 'none',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: active
    ? 'color-mix(in oklab, var(--a-now) 18%, transparent)'
    : 'transparent',
  color: active ? 'var(--ink)' : 'var(--ink-3)',
  cursor: 'pointer',
});

const actionBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  borderRadius: 6,
  border: '0.5px solid var(--line-2)',
  background: disabled ? 'transparent' : 'var(--sheet-2)',
  color: disabled ? 'var(--ink-3)' : 'var(--ink)',
  fontSize: 12,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const folderCardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  cursor: 'pointer',
  textAlign: 'left',
};

const artifactCardStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

const miniBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
};
