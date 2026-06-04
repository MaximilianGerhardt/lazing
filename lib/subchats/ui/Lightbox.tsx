'use client';

/**
 * Lightbox — full-screen image view for the sub-chat thread (internal + external).
 * Apple standard: tap-to-close (backdrop), horizontal swipe = next/
 * previous image, swipe down = close (iOS standard), ESC (desktop).
 * Motion serves the hierarchy (depth = zooming into the image), never decoration;
 * all transitions <=200ms or spring-equivalent. Only laz.ing tokens, no emojis.
 * Gathering-Intelligence goal (2026-06-02).
 */

import { useCallback, useEffect } from 'react';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';

import * as s from './styles';
import { IconClose } from './icons';

export interface LightboxImage {
  url: string;
  filename: string;
}

export function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: LightboxImage[];
  index: number; // controlled current index
  onIndexChange: (i: number) => void;
  onClose: () => void;
}): React.ReactElement | null {
  // ESC closes (desktop affordance).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && images.length > 1) onIndexChange(Math.min(index + 1, images.length - 1));
      else if (e.key === 'ArrowLeft' && images.length > 1) onIndexChange(Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onIndexChange, onClose]);

  const onDragEnd = useCallback(
    (_e: unknown, info: PanInfo) => {
      const { offset } = info;
      // Swipe down = close (iOS standard).
      if (Math.abs(offset.y) > 120 && Math.abs(offset.y) > Math.abs(offset.x)) {
        onClose();
        return;
      }
      if (images.length > 1) {
        if (offset.x < -60) {
          onIndexChange(Math.min(index + 1, images.length - 1));
          return;
        }
        if (offset.x > 60) {
          onIndexChange(Math.max(index - 1, 0));
          return;
        }
      }
      // Snap-back (no state change) is handled automatically by motion via constraints.
    },
    [images.length, index, onIndexChange, onClose],
  );

  if (images.length === 0) return null;
  const safe = Math.max(0, Math.min(index, images.length - 1));
  const current = images[safe];

  return (
    <AnimatePresence>
      <motion.div
        key="lb-backdrop"
        style={s.lbBackdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={current.filename}
      >
        <button
          type="button"
          style={s.lbClose}
          aria-label="Schließen"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <IconClose size={20} />
        </button>

        <div style={s.lbStage}>
          <motion.img
            key={current.url}
            src={current.url}
            alt={current.filename}
            style={s.lbImage}
            draggable={false}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.4}
            onDragEnd={onDragEnd}
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            // Clicking the image itself does NOT close (only the backdrop).
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        <div style={s.lbCaption} onClick={(e) => e.stopPropagation()}>
          {/* N1: filename is only clamped to one line via CSS (display clamp),
              the string itself stays unchanged. */}
          <span style={s.lbCaptionName}>{current.filename}</span>
          {images.length > 1 ? (
            <span style={s.lbCaptionCounter}>
              {safe + 1} / {images.length}
            </span>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default Lightbox;
