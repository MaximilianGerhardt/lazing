'use client';

/**
 * Lightbox — Vollbild-Bildansicht für den Sub-Chat-Thread (intern + extern).
 * Apple-Standard: Tap-zum-Schließen (Backdrop), Wisch horizontal = nächstes/
 * vorheriges Bild, Wisch nach unten = schließen (iOS-Standard), ESC (Desktop).
 * Bewegung dient der Hierarchie (Tiefe = ins Bild hineinzoomen), nie Dekoration;
 * alle Übergänge <=200ms bzw. Spring-äquivalent. Nur laz.ing-Tokens, keine Emojis.
 * Gathering-Intelligence-Goal (2026-06-02).
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
  index: number; // kontrollierter aktueller Index
  onIndexChange: (i: number) => void;
  onClose: () => void;
}): React.ReactElement | null {
  // ESC schließt (Desktop-Affordance).
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
      // Wisch nach unten = schließen (iOS-Standard).
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
      // Snap-back (kein State-Change) erledigt motion automatisch via Constraints.
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
            // Klick auf das Bild selbst schließt NICHT (nur Backdrop).
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        <div style={s.lbCaption} onClick={(e) => e.stopPropagation()}>
          {/* N1: filename wird nur per CSS auf eine Zeile geklemmt (Display-Clamp),
              der String selbst bleibt unverändert. */}
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
