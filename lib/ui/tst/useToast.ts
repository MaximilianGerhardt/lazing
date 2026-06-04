'use client';

/**
 * useToast — Context-basierter Toast-Dispatcher.
 *
 * Verwendung:
 *   const toast = useToast();
 *   toast.ok("Gespeichert");
 *   toast.err("Fehler", err.message);
 *
 * Provider: <ToastProvider> muss im Root-Layout sitzen.
 * Die `id`-Vergabe ist monoton-inkrementell (kein crypto.randomUUID,
 * damit SSR-Hydration sicher bleibt).
 */

import { createContext, useContext } from 'react';
import type { ToastVariant } from './Toast';

export interface ToastEntry {
  id: string;
  variant: ToastVariant;
  title: string;
  body?: string;
  autoHideMs?: number;
}

export interface ToastDispatcher {
  /** Erfolgs-Toast (grüner Akzent, 3 s). */
  ok(title: string, body?: string): void;
  /** Fehler-Toast (roter Akzent, 6 s). */
  err(title: string, body?: string): void;
  /** Warn-Toast (gelber Akzent, 4 s). */
  warn(title: string, body?: string): void;
  /** Generischer Toast (keine Farbe, 3 s). */
  info(title: string, body?: string): void;
  /** Einen Toast manuell entfernen. */
  dismiss(id: string): void;
}

export const ToastContext = createContext<ToastDispatcher>({
  ok: () => undefined,
  err: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  dismiss: () => undefined,
});

/** In Client-Komponenten nutzbar. Gibt einen no-op zurück wenn kein Provider vorhanden. */
export function useToast(): ToastDispatcher {
  return useContext(ToastContext);
}
