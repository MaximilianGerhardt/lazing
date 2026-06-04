'use client';

import { forwardRef } from 'react';

export type CmdSuggestionKind = 'act' | 'nav' | 'doc';

export interface CmdSuggestion {
  id: string;
  kind: CmdSuggestionKind;
  label: string;
  detail?: string;
  shortcut?: string;
  onSelect: () => void;
}

const KIND_LABEL: Record<CmdSuggestionKind, string> = {
  act: 'TUE',
  nav: 'GEHE',
  doc: 'DOK',
};

export interface CmdSuggestProps {
  suggestions: CmdSuggestion[];
  activeIndex: number;
  listboxId: string;
  onHover?: (index: number) => void;
}

export const CmdSuggest = forwardRef<HTMLDivElement, CmdSuggestProps>(
  function CmdSuggest({ suggestions, activeIndex, listboxId, onHover }, ref) {
    if (suggestions.length === 0) return null;

    return (
      <div
        ref={ref}
        id={listboxId}
        role="listbox"
        className="cmd-suggest"
        aria-label="Vorschlaege"
      >
        {suggestions.map((s, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={s.id}
              id={`${listboxId}-opt-${s.id}`}
              role="option"
              type="button"
              aria-selected={active}
              className={active ? 'cmd-sr active' : 'cmd-sr'}
              onClick={(e) => {
                e.preventDefault();
                s.onSelect();
              }}
              onMouseEnter={onHover ? () => onHover(i) : undefined}
              tabIndex={-1}
            >
              <span className={`kind ${s.kind}`}>{KIND_LABEL[s.kind]}</span>
              <div className="what">
                <b>{s.label}</b>
                {s.detail ? <small>{s.detail}</small> : null}
              </div>
              {s.shortcut ? <div className="right">{s.shortcut}</div> : null}
            </button>
          );
        })}
      </div>
    );
  }
);
