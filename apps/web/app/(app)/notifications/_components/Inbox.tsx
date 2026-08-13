'use client';

import {
  NOTIFICATION_KIND_LABEL,
  type NotificationTone,
  type NotificationView,
  repeatNote,
} from '@/lib/notifications-shape';
import { relativeTime } from '@/lib/relative-time';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { BellOff, Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * LA BANDEJA.
 *
 * Tres cosas y ninguna más: leer, marcar, e ir a donde pasó la cosa. No hay
 * filtros, ni pestañas, ni archivado — un aviso ya se archiva solo al leerse, y
 * la lista está acotada a doscientos por la propia base (migración 0096, § 2).
 * Una bandeja con herramientas es una bandeja que alguien tiene que gestionar,
 * y gestionar avisos es exactamente el trabajo que este módulo existe para no
 * inventar.
 *
 * ── PULSAR UN AVISO LO MARCA Y TE LLEVA ───────────────────────────────────
 * En ese orden, y esperando al marcado: si se navegara primero, la petición se
 * cancelaría al desmontarse la página y el aviso seguiría sin leer después de
 * haberlo abierto — que es la manera más rápida de que nadie se fíe del número
 * de la campana. Si el marcado falla se navega igual: llegar a donde pasó la
 * cosa importa más que el registro de que lo miraste.
 *
 * ── EL ESTADO SE LLEVA AQUÍ, NO CON UN router.refresh() ───────────────────
 * Marcar diez avisos no puede costar diez recargas del servidor. La lista vive
 * en el cliente a partir de lo que pintó el servidor, y sólo se re-pide entera
 * cuando se marca todo.
 */

const TONE_CHIP: Record<NotificationTone, StatusTone> = {
  info: 'neutral',
  good: 'emerald',
  warning: 'amber',
  bad: 'rose',
};

async function postRead(body: { ids?: string[] | null; all?: boolean | null }): Promise<boolean> {
  try {
    const res = await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `nullish()` al otro lado precisamente por esto: `ids: undefined` se
      // omite al serializar y `ids: null` viaja. Los dos tienen que valer.
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function Inbox({ initial }: { initial: NotificationView[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const unread = items.filter((n) => n.readAt === null);

  function markLocally(id: string) {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? now } : n)));
  }

  async function open(item: NotificationView) {
    setBusy(item.id);
    if (item.readAt === null) {
      await postRead({ ids: [item.id] });
      markLocally(item.id);
    }
    setBusy(null);
    if (item.href) router.push(item.href);
  }

  async function markOne(item: NotificationView) {
    setBusy(item.id);
    const ok = await postRead({ ids: [item.id] });
    if (ok) markLocally(item.id);
    setBusy(null);
  }

  async function markEverything() {
    setMarkingAll(true);
    const ok = await postRead({ all: true });
    if (ok) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })));
      // Sólo aquí: la campana vive en el layout del servidor y ésta es la única
      // acción que cambia el número de golpe.
      router.refresh();
    }
    setMarkingAll(false);
  }

  if (items.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <BellOff className="mx-auto mb-3 h-7 w-7 text-ink-faint" />
        <h2 className="text-[15px] font-bold text-ink">Nada que contarte todavía</h2>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-muted">
          Aquí van a aparecer los hechos: un trámite que terminó y dejó un documento, una rutina que
          no pudo correr, un encargo que se atascó y te preguntó algo, un correo que salió. Lo que
          sigue <em>esperándote</em> no vive aquí — eso está en Aprobaciones, Acciones, Compromisos
          y Encargos.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="field-label">
          {unread.length > 0 ? `${unread.length} sin leer` : 'Todo leído'}
        </div>
        {unread.length > 0 && (
          <button
            type="button"
            onClick={markEverything}
            disabled={markingAll}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border px-2.5 py-[3px] text-[11px] font-semibold text-ink-muted transition-colors duration-150 hover:border-border-strong hover:text-ink disabled:opacity-60"
          >
            {markingAll ? (
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Marcar todo como leído
          </button>
        )}
      </div>
      <div className="rule-double" />
      <ul>
        {items.map((item) => {
          const isUnread = item.readAt === null;
          const repeats = repeatNote(item.occurrences);
          return (
            <li key={item.id} className="border-b border-border last:border-b-0">
              <div
                className={clsx(
                  'flex items-start gap-3 px-4 py-3.5 transition-colors',
                  isUnread ? 'bg-primary-soft/30' : 'bg-surface',
                )}
              >
                <span
                  aria-hidden
                  className={clsx(
                    'mt-[7px] h-2 w-2 shrink-0 rounded-full',
                    isUnread ? DOT_TONE[TONE_CHIP[item.tone]] : 'bg-transparent',
                  )}
                />
                <button
                  type="button"
                  onClick={() => open(item)}
                  disabled={busy === item.id}
                  className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div
                    className={clsx(
                      'text-[13.5px] leading-snug text-ink',
                      isUnread ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {item.title}
                  </div>
                  {item.body && (
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{item.body}</p>
                  )}
                  <div className="tabular mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
                    <span className={chipClass(TONE_CHIP[item.tone])}>
                      {NOTIFICATION_KIND_LABEL[item.kind]}
                    </span>
                    <span>{relativeTime(item.occurredAt)}</span>
                    {repeats && <span>· {repeats}</span>}
                    {item.href && <span>· pulsa para ir</span>}
                  </div>
                </button>
                {isUnread && (
                  <button
                    type="button"
                    onClick={() => markOne(item)}
                    disabled={busy === item.id}
                    aria-label="Marcar este aviso como leído"
                    className="mt-0.5 shrink-0 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
                  >
                    {busy === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
