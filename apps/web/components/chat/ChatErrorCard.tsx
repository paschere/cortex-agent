'use client';

import { clsx } from 'clsx';
import { AlertTriangle, Gauge, RotateCw, X } from 'lucide-react';
import Link from 'next/link';

/**
 * EL AVISO DE UN TURNO QUE SE CAYÓ, DENTRO DE LA COLUMNA.
 *
 * Era una franja rosa de borde a borde, fuera de la columna de la conversación
 * y con el texto pegado al color: se salía por la derecha y parecía un error del
 * navegador, no algo que Cortex te dice. Ahora es una tarjeta del mismo ancho
 * que los mensajes, con ícono, la frase humana que ya entrega el servidor
 * (`humanChatError`) y las dos salidas que hay de verdad: repetir el turno o
 * pedirle que siga. Sólo hay uno a la vez — el padre guarda un único estado.
 *
 * Un límite de plan es otro caso: reintentar no sirve, así que ofrece el plan.
 */
export function ChatErrorCard({
  message,
  isLimit,
  interrupted = false,
  busy,
  onRetry,
  onContinue,
  onDismiss,
}: {
  message: string;
  isLimit: boolean;
  /**
   * El turno se CORTÓ (tiempo, red) y lo hecho quedó guardado: lo que sirve es
   * «Continuar», que retoma desde ahí sin repetir trabajo; reintentar lo
   * empezaría de cero. Se dice distinto y el botón principal cambia.
   */
  interrupted?: boolean;
  /** Hay un turno en marcha: los botones que lanzan otro se apagan. */
  busy?: boolean;
  onRetry: () => void;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const Icon = isLimit ? Gauge : AlertTriangle;
  return (
    <div className="mx-auto w-full max-w-[45rem] shrink-0 px-4 pb-2 sm:px-6">
      <div
        role="alert"
        className={clsx(
          'flex w-full min-w-0 items-start gap-3 rounded-card border px-3.5 py-3 shadow-card',
          isLimit ? 'border-amber/25 bg-amber-soft' : 'border-rose/25 bg-rose-soft',
        )}
      >
        <span
          className={clsx(
            'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm',
            isLimit ? 'bg-amber/15 text-amber' : 'bg-rose/15 text-rose',
          )}
          aria-hidden
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {isLimit
              ? 'Llegaste al límite de tu plan'
              : interrupted
                ? 'La respuesta quedó a medias'
                : 'No pude terminar la respuesta'}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
            {message}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {isLimit ? (
              <Link
                href="/plan"
                className="inline-flex items-center rounded-pill bg-amber px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:brightness-95 motion-reduce:transition-none"
              >
                Ver plan y consumo
              </Link>
            ) : interrupted ? (
              <button
                type="button"
                onClick={onContinue}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-pill bg-rose px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:brightness-95 disabled:opacity-60 motion-reduce:transition-none"
              >
                <RotateCw className="h-3 w-3" aria-hidden />
                Continuar
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-pill bg-rose px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:brightness-95 disabled:opacity-60 motion-reduce:transition-none"
                >
                  <RotateCw className="h-3 w-3" aria-hidden />
                  Reintentar
                </button>
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={busy}
                  className="rounded-pill border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
                >
                  Continuar
                </button>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Descartar aviso"
          className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-ink motion-reduce:transition-none"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
