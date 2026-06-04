'use client';

import { useEffect, useRef, useState } from 'react';

import { Toast, type ToastProps } from './Toast';

export interface ToastStackItem extends ToastProps {
  /** Stable identity used to reconcile the animating list. */
  id: string;
}

export interface ToastStackProps {
  /** Currently visible toasts, ordered oldest -> newest. */
  toasts: ToastStackItem[];
  /**
   * Invoked when a toast should be removed from the list — either
   * because its auto-hide timer fired or because it finished its
   * exit animation. Parent owns the list state.
   */
  onDismiss: (id: string) => void;
  /**
   * Corner anchor. Defaults to bottom-right. Only two anchors are
   * supported — this is a deliberate constraint so we don't grow a
   * positioning matrix that nobody uses.
   */
  position?: 'bottom-right' | 'bottom-center';
}

/** CSS duration of the exit animation below — keep in sync with keyframes. */
const EXIT_MS = 220;

/**
 * Scoped keyframes. Inlined so the component is fully self-contained
 * and doesn't require edits to `app/components.css`. The class names
 * are namespaced (`lzy-ts-*`) to avoid collisions.
 */
const STACK_STYLES = `
.lzy-ts-stack {
  position: fixed;
  z-index: 1000;
  bottom: 24px;
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  pointer-events: none;
}
.lzy-ts-stack.br { right: 24px; align-items: flex-end; }
.lzy-ts-stack.bc { left: 50%; transform: translateX(-50%); align-items: center; }
.lzy-ts-stack > * { pointer-events: auto; }
.lzy-ts-item {
  animation: lzy-ts-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.lzy-ts-item.leaving {
  animation: lzy-ts-out ${EXIT_MS}ms cubic-bezier(0.4, 0, 1, 1) both;
}
@keyframes lzy-ts-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes lzy-ts-out {
  from { opacity: 1; transform: translateX(0); }
  to   { opacity: 0; transform: translateX(24px); }
}
@media (prefers-reduced-motion: reduce) {
  .lzy-ts-item,
  .lzy-ts-item.leaving { animation: none; }
}
`;

/**
 * Manager for multiple concurrent toasts with mount-transition
 * animations.
 *
 * Ownership model:
 * - The parent owns the list of toasts that *should* be visible.
 * - When the parent removes an id, we keep that toast mounted for
 *   `EXIT_MS` while the CSS exit animation plays, then drop it from
 *   our internal render list.
 * - `onDismiss` is called when a child toast wants to go away
 *   (auto-hide fires). The parent is expected to remove the id from
 *   its list in response; we then run the exit animation.
 */
export function ToastStack({
  toasts,
  onDismiss,
  position = 'bottom-right',
}: ToastStackProps): React.JSX.Element {
  // Internal render list — superset of props.toasts that also keeps
  // exiting toasts mounted during their animation.
  const [rendered, setRendered] = useState<ToastStackItem[]>(toasts);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const exitTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const incomingIds = new Set(toasts.map((t) => t.id));

    // Schedule exit for any id we're currently rendering that has
    // disappeared from props and isn't already leaving.
    setRendered((prev) => {
      const prevIds = new Set(prev.map((t) => t.id));
      const departing = prev.filter(
        (t) => !incomingIds.has(t.id) && !exitTimers.current.has(t.id),
      );

      if (departing.length > 0) {
        setLeaving((s) => {
          const next = new Set(s);
          for (const t of departing) next.add(t.id);
          return next;
        });
        for (const t of departing) {
          const handle = window.setTimeout(() => {
            exitTimers.current.delete(t.id);
            setRendered((r) => r.filter((x) => x.id !== t.id));
            setLeaving((s) => {
              if (!s.has(t.id)) return s;
              const next = new Set(s);
              next.delete(t.id);
              return next;
            });
          }, EXIT_MS);
          exitTimers.current.set(t.id, handle);
        }
      }

      // Update props-backed entries in-place (so prop changes like
      // title/body flow through) and append any new ids at the end.
      const propsById = new Map(toasts.map((t) => [t.id, t]));
      const updated = prev.map((t) => propsById.get(t.id) ?? t);
      const additions = toasts.filter((t) => !prevIds.has(t.id));
      return [...updated, ...additions];
    });
  }, [toasts]);

  useEffect(() => {
    // Capture ref contents at mount so the cleanup closure doesn't
    // reach into a possibly-mutated `.current` much later.
    const timers = exitTimers.current;
    return () => {
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, []);

  const posClass = position === 'bottom-center' ? 'bc' : 'br';

  return (
    <>
      <style>{STACK_STYLES}</style>
      {rendered.length > 0 ? (
        <div
          className={`lzy-ts-stack ${posClass}`}
          aria-live="polite"
          aria-relevant="additions"
        >
          {rendered.map((t) => {
            const isLeaving = leaving.has(t.id);
            // Strip `onDismiss` and `id` — we wire our own dismiss
            // so the parent's removal is the single source of truth.
            const { id, onDismiss: _childDismiss, ...toastProps } = t;
            void _childDismiss;
            return (
              <div
                key={id}
                className={`lzy-ts-item${isLeaving ? ' leaving' : ''}`}
              >
                <Toast
                  {...toastProps}
                  onDismiss={() => onDismiss(id)}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

export default ToastStack;
