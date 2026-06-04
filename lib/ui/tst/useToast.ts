'use client';

/**
 * useToast — context-based toast dispatcher.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.ok("Gespeichert");
 *   toast.err("Fehler", err.message);
 *
 * Provider: <ToastProvider> must sit in the root layout.
 * The `id` assignment is monotonically incremental (no crypto.randomUUID,
 * so SSR hydration stays safe).
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
  /** Success toast (green accent, 3 s). */
  ok(title: string, body?: string): void;
  /** Error toast (red accent, 6 s). */
  err(title: string, body?: string): void;
  /** Warning toast (yellow accent, 4 s). */
  warn(title: string, body?: string): void;
  /** Generic toast (no color, 3 s). */
  info(title: string, body?: string): void;
  /** Remove a toast manually. */
  dismiss(id: string): void;
}

export const ToastContext = createContext<ToastDispatcher>({
  ok: () => undefined,
  err: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  dismiss: () => undefined,
});

/** Usable in client components. Returns a no-op when no provider is present. */
export function useToast(): ToastDispatcher {
  return useContext(ToastContext);
}
