'use client';

/**
 * ToastProvider — hängt im RootLayout, stellt den ToastContext bereit.
 *
 * Verwaltet eine Liste von ToastEntry-Items und rendert den ToastStack.
 * ID-Vergabe: monoton per counter (kein crypto.randomUUID → SSR-safe).
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastStack } from './ToastStack';
import { ToastContext, type ToastDispatcher, type ToastEntry } from './useToast';
import type { ToastVariant } from './Toast';

let _counter = 0;
function nextId(): string {
  return `t-${++_counter}`;
}

const AUTO_HIDE: Record<ToastVariant, number> = {
  ok: 3000,
  err: 6000,
  warn: 4000,
  default: 3000,
};

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((variant: ToastVariant, title: string, body?: string) => {
    const id = nextId();
    const entry: ToastEntry = {
      id,
      variant,
      title,
      body,
      autoHideMs: AUTO_HIDE[variant],
    };
    setToasts((prev) => [...prev, entry]);
  }, []);

  const dispatcherRef = useRef<ToastDispatcher>({
    ok: (title, body) => push('ok', title, body),
    err: (title, body) => push('err', title, body),
    warn: (title, body) => push('warn', title, body),
    info: (title, body) => push('default', title, body),
    dismiss,
  });

  // Keep dispatcher stable — update inner push/dismiss refs without recreating the object.
  dispatcherRef.current.ok = (title, body) => push('ok', title, body);
  dispatcherRef.current.err = (title, body) => push('err', title, body);
  dispatcherRef.current.warn = (title, body) => push('warn', title, body);
  dispatcherRef.current.info = (title, body) => push('default', title, body);
  dispatcherRef.current.dismiss = dismiss;

  return (
    <ToastContext.Provider value={dispatcherRef.current}>
      {children}
      <ToastStack
        toasts={toasts}
        onDismiss={dismiss}
        position="bottom-right"
      />
    </ToastContext.Provider>
  );
}
