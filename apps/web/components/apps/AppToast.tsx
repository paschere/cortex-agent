'use client';

import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * LOS AVISOS DE UNA APP, TODOS IGUALES (0215).
 *
 * Un solo lugar y una sola forma: arriba de la barra inferior en el celular,
 * abajo a la derecha en escritorio, con `aria-live` para lectores de pantalla.
 * Lo que sale bien dura 4 s; un error se queda hasta que se cierra (o 8 s) y
 * puede traer su acción («Reintentar»). Sin proveedor, `useAppToast` no hace
 * nada: un componente que lo use sigue funcionando fuera de una app.
 */

export type ToastTone = 'ok' | 'error' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  text: string;
  action?: { label: string; run: () => void };
}

interface Toast extends ToastInput {
  id: number;
  tone: ToastTone;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useAppToast(): (t: ToastInput) => void {
  return useContext(ToastContext) ?? (() => undefined);
}

const TONE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  ok: { icon: CheckCircle2, cls: 'text-emerald' },
  error: { icon: AlertTriangle, cls: 'text-rose' },
  info: { icon: Info, cls: 'text-sky' },
};

export function AppToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((input: ToastInput) => {
    const toast: Toast = { ...input, tone: input.tone ?? 'info', id: Date.now() + Math.random() };
    setToasts((all) => [...all, toast].slice(-3));
  }, []);
  const drop = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="view-no-print pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-6 md:right-6 md:items-end"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => drop(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, toast.tone === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(id);
  }, [toast.tone, onClose]);
  const { icon: Icon, cls } = TONE[toast.tone];
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className="app-sheet pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-card border border-border bg-surface px-4 py-3 shadow-pop"
    >
      <Icon className={clsx('h-4.5 w-4.5 shrink-0', cls)} aria-hidden />
      <p className="min-w-0 flex-1 text-sm font-semibold text-ink">{toast.text}</p>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
          className="min-h-11 shrink-0 px-2 text-xs font-semibold text-primary hover:underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar aviso"
        className="grid h-11 w-9 shrink-0 place-items-center text-ink-faint hover:text-ink"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
