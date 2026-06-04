'use client';

export interface CloudBrowserProps {
  workspace: string;
  workspaceLabel: string;
  artifactCount: number;
  totalBytes: number;
  folderCount: number;
  /** href zur Cloud-Page-URL (`/workspaces/<id>/cloud`). */
  href?: string;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * DOC-03 CloudBrowser-Summary-Card. Zeigt Workspace-Cloud-Stats kompakt
 * mit "Öffnen"-Button. Default-Surface beim ersten Aufruf.
 */
export function CloudBrowser(props: CloudBrowserProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[#1f1f1f] bg-[#0c0c0c]/80 p-4 my-2 max-w-[460px]">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[12px] text-[#7a7a7a] mb-0.5">
            Cloud · {props.workspaceLabel}
          </div>
          <div className="text-[18px] font-semibold text-[#e6e6e6] tabular-nums">
            {props.artifactCount}
            <span className="text-[12px] text-[#5a5a5a] font-normal ml-1">
              {props.artifactCount === 1 ? 'Datei' : 'Dateien'}
            </span>
          </div>
        </div>
        {props.href && (
          <a
            href={props.href}
            className="text-[11px] px-3 py-1.5 rounded border border-[#2a2a2a] hover:border-[#3a3a3a] text-[#cccccc] hover:text-white transition-colors"
          >
            Öffnen
          </a>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px] text-[#7a7a7a]">
        <div>
          <div className="text-[#5a5a5a]">Belegt</div>
          <div className="text-[#cccccc] mt-0.5 tabular-nums">
            {formatBytes(props.totalBytes)}
          </div>
        </div>
        <div>
          <div className="text-[#5a5a5a]">Ordner</div>
          <div className="text-[#cccccc] mt-0.5 tabular-nums">
            {props.folderCount}
          </div>
        </div>
      </div>
    </div>
  );
}
