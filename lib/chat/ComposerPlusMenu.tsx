'use client';

/**
 * ComposerPlusMenu — SP-7 (Phase 3 Chat-Surface).
 *
 * Apple-style „+" attachment menu in the composer. Replaces the standalone
 * right-side paperclip — its job (Foto / Dokument / Kamera) now lives behind
 * ONE „+" affordance at the LEFT of the composer row.
 *
 * Two presentations (responsive, single component):
 *
 *   - Desktop / fine pointer: a popover anchored to the „+" button. It opens
 *     UPWARD (bottom: calc(100% + 8px)) because the composer sits at the
 *     bottom of the screen. Visual language cloned from the existing
 *     suggestion dropdown (suggestionListStyle in ChatComposer): blurred
 *     --sheet-2 surface, 0.5px --line-2 border, soft shadow, rounded.
 *
 *   - Mobile (≤640px): a bottom sheet with a scrim + grab-handle. The sheet
 *     respects var(--safe-bottom) so the rows clear the home indicator. The
 *     scrim isolates the foreground (Apple HIG blur-purpose) and closes the
 *     sheet on tap / swipe-down.
 *
 * The component owns NO upload logic. Each row triggers `onPick(kind)`; the
 * parent (ChatComposer) clicks the relevant hidden <input> so the files flow
 * through the EXISTING upload chain (useChatCloudUpload → StagedAttachmentsBar
 * → attachment-message). The „Kamera" row is offered ONLY on coarse pointers
 * (matchMedia('(pointer: coarse)')) where a capture-camera makes sense.
 *
 * Accessibility (Apple HIG / WCAG):
 *   - „+" carries aria-haspopup="menu" + aria-expanded; it rotates 45°→× via a
 *     transform when open (motion conveys the open/close cause-effect).
 *   - The list is role="menu"; rows are role="menuitem", ≥44px (≥48 mobile).
 *   - Keyboard: Enter/Space open, ArrowUp/Down move focus, Escape closes and
 *     refocuses the „+". Tab/outside-click/scroll (desktop) close.
 *   - Foto/Dokument rows disable while an upload runs (aria-busy mirror).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { IconPlus, IconImage, IconFile, IconCamera } from './icons';

export type ComposerPlusPick = 'photo' | 'document' | 'camera';

export interface ComposerPlusMenuProps {
  /** Row click → parent clicks the matching hidden input. */
  onPick: (kind: ComposerPlusPick) => void;
  /** While an upload runs → Foto/Dokument rows are disabled (aria-busy). */
  uploading?: boolean;
}

interface RowDef {
  kind: ComposerPlusPick;
  label: string;
  Icon: (p: { size?: number }) => React.JSX.Element;
  /** Only true for actions that consume the upload chain (disabled while busy). */
  uploads: boolean;
}

/** SSR-safe coarse-pointer probe (Kamera-row gating). */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    setCoarse(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setCoarse(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return coarse;
}

/** SSR-safe ≤640px probe (popover vs bottom-sheet). */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    setMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setMobile(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return mobile;
}

export function ComposerPlusMenu({
  onPick,
  uploading = false,
}: ComposerPlusMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // -1 = no roving focus yet (e.g. opened by mouse). ≥0 = focused row index.
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const coarse = useCoarsePointer();
  const isMobile = useIsMobile();

  // Kamera row only on coarse pointers (capture="environment" is meaningless
  // on a desktop mouse). Foto + Dokument are always present.
  const rows: RowDef[] = [
    { kind: 'photo', label: 'Foto', Icon: IconImage, uploads: true },
    { kind: 'document', label: 'Dokument', Icon: IconFile, uploads: true },
    ...(coarse
      ? [{ kind: 'camera' as const, label: 'Kamera', Icon: IconCamera, uploads: false }]
      : []),
  ];

  const close = useCallback((refocus: boolean): void => {
    setOpen(false);
    setActiveIndex(-1);
    if (refocus) {
      // Defer to after the menu unmounts so focus lands cleanly on the „+".
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback((focusFirst: boolean): void => {
    setOpen(true);
    setActiveIndex(focusFirst ? 0 : -1);
  }, []);

  // Roving focus: move DOM focus to the active row when it changes.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    rowRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // ---- Desktop dismissal: outside-click + scroll close. -------------------
  // Mobile uses the scrim (handled in the sheet markup) instead.
  useEffect(() => {
    if (!open || isMobile) return undefined;
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (): void => close(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, isMobile, close]);

  const handleTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (open) close(true);
        else openMenu(true);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // Menu opens UPWARD → ArrowUp lands on the last row, ArrowDown on the first.
        if (!open) {
          setOpen(true);
          setActiveIndex(e.key === 'ArrowUp' ? rows.length - 1 : 0);
        }
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close(true);
      }
    },
    [open, rows.length, close, openMenu],
  );

  const handleMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % rows.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setActiveIndex(rows.length - 1);
      }
    },
    [rows.length, close],
  );

  const pick = useCallback(
    (row: RowDef): void => {
      if (row.uploads && uploading) return;
      // Close first (refocus the trigger), then trigger the input click in the
      // parent — opening the OS file/camera dialog steals focus anyway.
      close(false);
      onPick(row.kind);
    },
    [uploading, close, onPick],
  );

  // ---- Mobile swipe-down-to-dismiss on the sheet. -------------------------
  const touchStartY = useRef<number | null>(null);
  const onSheetTouchStart = useCallback((e: React.TouchEvent): void => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }, []);
  const onSheetTouchEnd = useCallback(
    (e: React.TouchEvent): void => {
      const start = touchStartY.current;
      touchStartY.current = null;
      if (start === null) return;
      const end = e.changedTouches[0]?.clientY ?? start;
      // Drag-threshold (HIG: avoid accidental dismiss) — ≥48px downward.
      if (end - start > 48) close(false);
    },
    [close],
  );

  const renderRows = (): React.JSX.Element[] =>
    rows.map((row, i) => {
      const disabled = row.uploads && uploading;
      return (
        <button
          key={row.kind}
          ref={(el) => {
            rowRefs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={activeIndex === i ? 0 : -1}
          className="composer-plus-row"
          disabled={disabled}
          aria-busy={disabled || undefined}
          onMouseEnter={() => setActiveIndex(i)}
          onMouseDown={(e) => {
            // Fire before the composer-shell focus handler / blur — keeps the
            // pointer interaction from bouncing focus back into the textarea.
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            pick(row);
          }}
        >
          <span className="composer-plus-row-glyph" aria-hidden="true">
            <row.Icon size={isMobile ? 20 : 18} />
          </span>
          <span className="composer-plus-row-label">{row.label}</span>
        </button>
      );
    });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="lazyos-composer__plus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={open ? 'Anhang-Menü schließen' : 'Anhängen'}
        title="Anhängen"
        data-open={open || undefined}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) close(false);
          else openMenu(false);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="lazyos-composer__plus-glyph" aria-hidden="true">
          <IconPlus size={20} />
        </span>
      </button>

      {open && isMobile ? (
        // ----- Mobile: bottom sheet + scrim ------------------------------
        <div
          className="composer-plus-scrim"
          role="presentation"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => close(false)}
        >
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Anhängen"
            className="composer-plus-sheet"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={handleMenuKeyDown}
            onTouchStart={onSheetTouchStart}
            onTouchEnd={onSheetTouchEnd}
          >
            <span className="composer-plus-grab" aria-hidden="true" />
            {renderRows()}
          </div>
        </div>
      ) : null}

      {open && !isMobile ? (
        // ----- Desktop: upward popover -----------------------------------
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Anhängen"
          className="composer-plus-menu"
          onKeyDown={handleMenuKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {renderRows()}
        </div>
      ) : null}
    </>
  );
}

export default ComposerPlusMenu;
