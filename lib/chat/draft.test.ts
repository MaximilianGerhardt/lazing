/**
 * Tests fuer lib/chat/draft.ts
 * ----------------------------
 * Streaming-Recovery V2 · Synthesis-Punkt 8.5.
 *
 * Was wird getestet (pure-Funktionen, ohne Hook-Pfad — der useDraftPersistence-Hook
 * wuerde React-Test-Renderer brauchen, was wir hier bewusst nicht aufziehen):
 *   - readDraftFor / writeDraftFor / clearDraftFor — set/get/clear pro Workspace.
 *   - Workspace-Isolation: ein Draft fuer ws-A leakt nicht in ws-B.
 *   - SSR-Safety / Storage-Errors throwen NICHT.
 *   - 64KB-Truncation greift bei Riesen-Pasten.
 *
 * Storage:
 *   happy-dom liefert eine echte localStorage-Implementierung — wir nutzen
 *   die direkt und resetten zwischen den Tests via `localStorage.clear()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDraftFor, readDraftFor, writeDraftFor } from './draft';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('draft.ts · set/get/clear pro Workspace', () => {
  it('writeDraftFor + readDraftFor returns the same string', () => {
    writeDraftFor('ws-north', 'Hallo Welt');
    expect(readDraftFor('ws-north')).toBe('Hallo Welt');
  });

  it('readDraftFor returns null for an empty/unknown workspace', () => {
    expect(readDraftFor('ws-empty')).toBeNull();
  });

  it('writeDraftFor("") removes the key (treats empty as clear)', () => {
    writeDraftFor('ws-clear', 'temp');
    expect(readDraftFor('ws-clear')).toBe('temp');

    writeDraftFor('ws-clear', '');
    expect(readDraftFor('ws-clear')).toBeNull();
    // Direkter localStorage-Check: Key wirklich weg, nicht nur leerer String.
    expect(localStorage.getItem('lazyos.chat.draft.ws-clear')).toBeNull();
  });

  it('clearDraftFor removes only the targeted workspace', () => {
    writeDraftFor('ws-A', 'Draft A');
    writeDraftFor('ws-B', 'Draft B');

    clearDraftFor('ws-A');

    expect(readDraftFor('ws-A')).toBeNull();
    expect(readDraftFor('ws-B')).toBe('Draft B');
  });

  it('drafts for different workspaces are isolated under separate keys', () => {
    writeDraftFor('ws-north', 'für North');
    writeDraftFor('ws-clientb', 'für clientb');

    expect(readDraftFor('ws-north')).toBe('für North');
    expect(readDraftFor('ws-clientb')).toBe('für clientb');

    // Implementation-detail: Keys folgen dem dokumentierten Schema.
    expect(localStorage.getItem('lazyos.chat.draft.ws-north')).toBe('für North');
    expect(localStorage.getItem('lazyos.chat.draft.ws-clientb')).toBe(
      'für clientb',
    );
  });

  it('overwrites existing drafts on subsequent writeDraftFor', () => {
    writeDraftFor('ws-overwrite', 'erste Version');
    writeDraftFor('ws-overwrite', 'zweite Version');
    expect(readDraftFor('ws-overwrite')).toBe('zweite Version');
  });

  it('truncates drafts larger than 64KB on write', () => {
    const huge = 'A'.repeat(70 * 1024); // 70 KB
    writeDraftFor('ws-huge', huge);
    const read = readDraftFor('ws-huge');
    expect(read).not.toBeNull();
    expect((read as string).length).toBe(64 * 1024);
  });

  it('truncates on read if a leftover localStorage value exceeds 64KB', () => {
    // Direkter Schreibzugriff (z.B. von einer alten Version oder Migration).
    const huge = 'B'.repeat(70 * 1024);
    localStorage.setItem('lazyos.chat.draft.ws-legacy', huge);
    const read = readDraftFor('ws-legacy');
    expect(read).not.toBeNull();
    expect((read as string).length).toBe(64 * 1024);
  });

  it('readDraftFor swallows localStorage errors and returns null', () => {
    // Simuliere ein Storage das beim getItem wirft (private mode / quota).
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(readDraftFor('ws-broken')).toBeNull();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it('writeDraftFor swallows localStorage errors silently', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      // MUSS NICHT throwen — Caller (Composer) darf nicht crashen.
      expect(() => writeDraftFor('ws-quota', 'value')).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it('clearDraftFor swallows localStorage errors silently', () => {
    const orig = Storage.prototype.removeItem;
    Storage.prototype.removeItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => clearDraftFor('ws-broken')).not.toThrow();
    } finally {
      Storage.prototype.removeItem = orig;
    }
  });
});
