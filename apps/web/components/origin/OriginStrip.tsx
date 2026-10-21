'use client';

import { readTableOrigins, refreshTableOrigin } from '@/app/(app)/trackers/origin-actions';
import type { TableOriginInfo } from '@/app/(app)/trackers/origin-types';
import { freshnessText } from '@cortex/agent-tools/src/trackers/origin';
import { clsx } from 'clsx';
import { Loader2, Lock, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «Viene de Siigo · actualizado hace 3 min» + «Actualizar ahora» (0237).
 *
 * Va bajo cada bloque de una vista o de una app que lee una tabla sincronizada
 * (y arriba de la grilla de la tabla). Dice de dónde viene, cuándo se leyó por
 * última vez, y —sólo a quien puede— deja pedir una lectura nueva: «Actualizando…»
 * mientras corre y, al terminar, vuelve a pintar el bloque. Quien abre un
 * enlace público no puede (la acción pide sesión): ve el texto y nada más.
 */

const POLL_MS = 4000;
const POLL_MAX_MS = 3 * 60_000;
const TICK_MS = 30_000;

interface Props {
  /** Slug de la tabla. */
  tracker: string;
  /** Qué origen mostrar si la tabla tiene varios; por omisión el primero. */
  originRef?: string;
  /** Nombre ya dicho («Siigo»), para pintar algo antes de que llegue el estado. */
  name: string;
  /** Etiquetas de los campos de sólo lectura y de los propios, para el detalle. */
  lockedLabels?: string[];
  ownLabels?: string[];
  /** Sin filas a mano. */
  creates?: boolean;
  className?: string;
}

export function OriginStrip({
  tracker,
  originRef,
  name,
  lockedLabels = [],
  ownLabels = [],
  creates = false,
  className,
}: Props) {
  const router = useRouter();
  const [info, setInfo] = useState<TableOriginInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    const res = await readTableOrigins(tracker);
    if (!res.ok) return null;
    const mine = res.items.find((i) => !originRef || i.ref === originRef) ?? res.items[0] ?? null;
    setInfo(mine);
    setNow(Date.now());
    return mine;
  }, [tracker, originRef]);

  useEffect(() => {
    void load();
  }, [load]);

  // El reloj de «hace 3 min».
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const running = busy || Boolean(info?.status.running);

  // Mientras corre, pregunta cada pocos segundos; al terminar, repinta el bloque.
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        router.refresh();
      }
      return;
    }
    wasRunning.current = true;
    startedAt.current ??= Date.now();
    const id = window.setInterval(async () => {
      if (startedAt.current && Date.now() - startedAt.current > POLL_MAX_MS) {
        startedAt.current = null;
        setBusy(false);
        return;
      }
      const fresh = await load();
      if (fresh && !fresh.status.running) {
        startedAt.current = null;
        setBusy(false);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [running, load, router]);

  const refresh = async () => {
    if (!info || busy) return;
    setError(null);
    setBusy(true);
    startedAt.current = Date.now();
    const res = await refreshTableOrigin(tracker, info.ref);
    if (!res.ok) {
      setBusy(false);
      startedAt.current = null;
      setError(res.error);
      return;
    }
    await load();
  };

  const text = freshnessText(
    info?.name ?? name,
    info
      ? { ...info.status, running }
      : running
        ? { lastSyncAt: null, state: 'never', running }
        : null,
    now,
  );
  const detail = [
    lockedLabels.length
      ? `Sólo lectura (vienen de ${info?.name ?? name}): ${lockedLabels.join(', ')}.`
      : '',
    ownLabels.length ? `Propios (se editan aquí): ${ownLabels.join(', ')}.` : '',
    creates ? 'Las filas nuevas llegan de la fuente; no se agregan a mano.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint',
        className,
      )}
    >
      <output title={detail || undefined} className="inline-flex min-w-0 items-center gap-1.5">
        <Lock className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0">{text}</span>
      </output>
      {info?.canRefresh ? (
        <button
          type="button"
          onClick={refresh}
          disabled={running}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 text-micro font-semibold text-ink transition-colors hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
          {running ? 'Actualizando…' : 'Actualizar ahora'}
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="font-semibold text-rose">
          {error}
        </span>
      ) : null}
    </div>
  );
}
