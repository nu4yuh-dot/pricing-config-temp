'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Telling somebody what just happened.
 *
 * Most actions in this console called `revalidatePath` and nothing else, so a save looked
 * identical to a no-op: the page re-rendered with the same numbers and you were left to
 * infer success from the absence of an error. That is how an offer that never reached the
 * pricing engine went unnoticed — the screen said nothing either way, and saying nothing
 * reads as success.
 *
 * So a toast is not decoration here; it is the difference between "it saved" and "I think it
 * saved". Three rules follow from that:
 *
 *  - **A failure says what to do.** "Could not save" is barely better than silence. The
 *    message carries the reason the action gave, because that reason was written by the code
 *    that knows why.
 *  - **A failure does not disappear.** Successes fade; errors stay until dismissed, because
 *    the one you need to read is the one you were not watching for.
 *  - **It is announced, not just drawn.** `role="status"` and `aria-live` mean a screen
 *    reader hears it. A confirmation only sighted users receive is not a confirmation.
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  /** What happened, in a few words: "Offer scheduled". */
  title: string;
  /** Why, or what to do about it. Optional for a plain success. */
  detail?: string;
}

interface ToastApi {
  show: (toast: Omit<Toast, 'id'>) => void;
  saved: (what: string, detail?: string) => void;
  deleted: (what: string, detail?: string) => void;
  failed: (what: string, reason: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** How long a success stays. Errors ignore this — see the note above. */
const LINGER_MS = 4500;

/**
 * Read the reason out of whatever an action returned or threw.
 *
 * Actions here report failure three ways — a thrown Error, a returned `{ error }`, or a bare
 * string — because they were written at different times. Rather than make every caller
 * remember which, this takes any of them.
 */
export function reasonFrom(cause: unknown): string {
  if (typeof cause === 'string' && cause.trim() !== '') return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (cause && typeof cause === 'object') {
    const maybe = (cause as { error?: unknown; message?: unknown });
    if (typeof maybe.error === 'string' && maybe.error.trim() !== '') return maybe.error;
    if (typeof maybe.message === 'string' && maybe.message.trim() !== '') return maybe.message;
  }
  return 'No reason was given, which is usually a bug rather than a silent success.';
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    // A no-op rather than a crash: a component rendered outside the provider should not
    // take the page down over a notification.
    return {
      show: () => {},
      saved: () => {},
      deleted: () => {},
      failed: () => {},
    };
  }
  return api;
}

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = next.current++;
    // Newest first, and capped: a bulk action that fires twenty of these should not bury
    // the page it is reporting on.
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, 4));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      saved: (what, detail) => show({ kind: 'success', title: `${what} saved`, ...(detail ? { detail } : {}) }),
      deleted: (what, detail) => show({ kind: 'success', title: `${what} deleted`, ...(detail ? { detail } : {}) }),
      failed: (what, reason) => show({ kind: 'error', title: `Could not ${what}`, detail: reasonFrom(reason) }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    // An error stays until it is read. A success that vanished while somebody was looking
    // elsewhere has still told them nothing.
    if (toast.kind === 'error' || paused) return undefined;
    const timer = setTimeout(onDismiss, LINGER_MS);
    return () => clearTimeout(timer);
  }, [toast.kind, paused, onDismiss]);

  return (
    <div
      className={`toast ${toast.kind}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="toast-body">
        <strong>{toast.title}</strong>
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </div>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
