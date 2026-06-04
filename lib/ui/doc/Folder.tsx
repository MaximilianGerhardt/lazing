'use client';

export interface FolderProps {
  id: string;
  name: string;
  path: string;
  workspace?: string;
  workspaceLabel?: string;
  itemCount?: number;
  href?: string;
}

/**
 * DOC-02 Folder-Card. Kompakte Verzeichnis-Anzeige für `<surface:folder>`.
 */
export function Folder(props: FolderProps): React.JSX.Element {
  const inner = (
    <>
      <div className="shrink-0 w-9 h-9 rounded bg-[#1a1a1a] border border-[#262626] flex items-center justify-center text-base">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[#e6e6e6] truncate">
          {props.name}
        </div>
        <div className="text-[11px] text-[#7a7a7a] mt-0.5 truncate">
          {props.path}
          {typeof props.itemCount === 'number' && (
            <span className="ml-2 text-[#5a5a5a]">
              {props.itemCount} Einträge
            </span>
          )}
        </div>
      </div>
    </>
  );

  const className =
    'rounded-xl border border-[#1f1f1f] bg-[#0c0c0c]/80 p-3 my-2 max-w-[420px] flex items-center gap-3 transition-colors';

  if (props.href) {
    return (
      <a
        href={props.href}
        className={`${className} hover:border-[#2f2f2f]`}
      >
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}
