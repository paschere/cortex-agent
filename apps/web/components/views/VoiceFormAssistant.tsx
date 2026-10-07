'use client';

import { clsx } from 'clsx';
import {
  CornerUpLeft,
  Loader2,
  Mic,
  Pencil,
  Repeat,
  Send,
  SkipForward,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useFormController } from './blocks/form-voice-bridge';
import { Card } from './blocks/theme';
import { type UiPhase, useVoiceForm } from './useVoiceForm';

/**
 * EL ASISTENTE DE VOZ DE UN FORMULARIO.
 *
 * Cortex pregunta en voz alta campo por campo, escucha, valida, salta lo que no
 * aplica, lee el resumen y envía al confirmar con «sí». Llena el formulario
 * VISIBLE (mismo estado que FormBlock: ver blocks/form-voice-bridge.tsx), así
 * que la persona ve lo que se va poniendo y lo corrige con el dedo; el envío
 * sale por el mismo camino del formulario (con su cola sin internet).
 *
 * Dos presentaciones:
 *   - `button`: «Llenar hablando» dentro del formulario; al arrancar sube una
 *     hoja abajo, sin tapar el formulario.
 *   - `panel`: el bloque `voice`, un panel grande y táctil para la pantalla de
 *     planta; con `autoStart` arranca al abrir (si el navegador no deja sonar
 *     la voz sin un toque, el círculo pide ese toque).
 *
 * Todo se puede hacer con el dedo (Repetir, Saltar, Atrás, Sí enviar), lo que
 * se dice se muestra y se anuncia (aria-live), y sin movimiento si la persona
 * pidió reducirlo. Voz de salida: la del navegador (gratis, también en el
 * enlace público) o, dentro de la app y con plan, la de Cortex.
 */

const PHASE_LABEL: Record<UiPhase, string> = {
  idle: 'Toca para hablar',
  tap: 'Toca para empezar',
  speaking: 'Hablando… toca para interrumpir',
  listening: 'Escuchando… habla ahora',
  thinking: 'Pensando…',
  ended: 'Listo',
};

export function VoiceFormAssistant({
  blockId,
  variant,
  title,
  autoStart = false,
  className,
}: {
  blockId: string;
  variant: 'button' | 'panel';
  title?: string | null;
  autoStart?: boolean;
  className?: string;
}) {
  const controller = useFormController(blockId);
  const v = useVoiceForm(controller);
  const auto = useRef(false);

  // Al abrir la pantalla (bloque `voice` con autoStart), una sola vez y cuando el formulario ya está.
  useEffect(() => {
    if (!autoStart || auto.current || !controller || controller.disabled || !v.supported) return;
    auto.current = true;
    v.startOrAsk();
  }, [autoStart, controller, v.supported, v.startOrAsk]);

  const running = v.phase !== 'idle' || (v.engine !== null && v.engine !== 'done');
  const disabled = !controller || controller.disabled;
  // «Llenar otro»: formulario en blanco y vuelta a empezar (tras dejar que se repinte).
  const again = () => {
    controller?.reset();
    v.stop();
    setTimeout(v.start, 150);
  };

  if (variant === 'button') {
    if (!v.supported || !controller || controller.done) return null;
    return (
      <>
        <button
          type="button"
          onClick={v.start}
          disabled={disabled || running}
          className={clsx(
            'inline-flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 px-5 text-base font-bold text-primary transition-colors duration-150 hover:bg-primary/10 disabled:opacity-60',
            className,
          )}
        >
          <Volume2 className="h-5 w-5" aria-hidden />
          Llenar hablando
        </button>
        {running && (
          <section
            aria-label="Asistente de voz"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[58vh] overflow-y-auto rounded-t-2xl border-t border-border-strong bg-surface p-4 shadow-pop sm:mx-auto sm:max-w-xl"
          >
            <Console v={v} onClose={v.stop} onAgain={again} />
          </section>
        )}
      </>
    );
  }

  // --- panel (bloque `voice`) ---
  return (
    <Card title={title ?? 'Asistente de voz'} className={className}>
      {!v.supported ? (
        <p className="text-sm text-ink-muted">
          Este navegador no permite hablar con el formulario. Llénalo con el dedo, o prueba con
          Chrome o Safari.
        </p>
      ) : !controller ? (
        <p className="text-sm text-ink-muted">
          El asistente se activa en la vista guardada, junto a su formulario (abre la página donde
          está).
        </p>
      ) : !running ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
            Cortex te pregunta en voz alta, campo por campo, y envía cuando le digas «sí». También
            puedes tocar la pantalla en cualquier momento.
          </p>
          <button
            type="button"
            onClick={v.start}
            disabled={disabled}
            className="cortex-primary-button inline-flex h-16 w-full max-w-sm items-center justify-center gap-3 rounded-pill bg-primary text-lg font-semibold text-white shadow-card transition-colors hover:bg-primary-strong disabled:opacity-45"
          >
            <Mic className="h-6 w-6" aria-hidden />
            {controller.done ? 'Llenar otro' : 'Llenar hablando'}
          </button>
          {controller.disabled && (
            <p className="text-xs text-ink-faint">Vista previa: guarda para usar la voz.</p>
          )}
        </div>
      ) : (
        <Console v={v} onClose={v.stop} onAgain={again} />
      )}
    </Card>
  );
}

type Voice = ReturnType<typeof useVoiceForm>;

function Console({ v, onClose, onAgain }: { v: Voice; onClose: () => void; onAgain: () => void }) {
  const busy = v.phase === 'thinking';
  const confirming = v.engine === 'confirming';
  const ended = v.phase === 'ended';
  const pill =
    'inline-flex min-h-12 items-center justify-center gap-2 rounded-pill border border-border-strong px-4 text-base font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-45';
  return (
    <div className="flex flex-col items-center gap-4">
      <button
        type="button"
        onClick={ended ? onAgain : v.tap}
        disabled={busy}
        aria-label={PHASE_LABEL[v.phase]}
        className={clsx(
          'relative grid h-28 w-28 shrink-0 place-items-center rounded-full border-4 text-white shadow-pop outline-none transition-colors focus-visible:ring-4 focus-visible:ring-primary/30',
          v.phase === 'listening' && 'border-rose bg-rose',
          v.phase === 'speaking' && 'border-primary bg-primary',
          v.phase === 'thinking' && 'border-amber bg-amber',
          v.phase === 'ended' && 'border-emerald bg-emerald',
          (v.phase === 'idle' || v.phase === 'tap') && 'border-primary bg-primary',
        )}
      >
        {v.phase === 'listening' && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-rose/40 motion-safe:animate-ping"
          />
        )}
        {v.phase === 'thinking' ? (
          <Loader2 className="relative h-12 w-12 motion-safe:animate-spin" aria-hidden />
        ) : v.phase === 'speaking' ? (
          <Volume2 className="relative h-12 w-12" aria-hidden />
        ) : v.phase === 'listening' ? (
          <Square className="relative h-10 w-10 fill-current" aria-hidden />
        ) : (
          <Mic className="relative h-12 w-12" aria-hidden />
        )}
      </button>
      <p className="text-center text-base font-bold text-ink">
        {ended ? 'Listo. Toca el círculo para llenar otro.' : PHASE_LABEL[v.phase]}
      </p>

      <div className="w-full space-y-2 text-center">
        <p
          aria-live="polite"
          className="min-h-[3.5rem] text-xl font-semibold leading-snug text-ink sm:text-2xl"
        >
          {v.said}
        </p>
        {v.heard && (
          <p className="text-base text-ink-muted">
            Oí: <span className="font-semibold text-ink">«{v.heard}»</span>
          </p>
        )}
        {v.problem && (
          <p role="alert" className="text-sm font-semibold text-rose">
            {v.problem}
          </p>
        )}
      </div>

      {!ended && (
        <div className="flex w-full flex-wrap items-center justify-center gap-2">
          {confirming ? (
            <>
              <button
                type="button"
                className={clsx(pill, 'bg-primary text-white hover:bg-primary-strong')}
                onClick={() => v.inject('sí')}
                disabled={busy}
              >
                <Send className="h-5 w-5" aria-hidden />
                Sí, enviar
              </button>
              <button type="button" className={pill} onClick={() => v.inject('no')} disabled={busy}>
                <Pencil className="h-5 w-5" aria-hidden />
                Corregir
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={pill}
                onClick={() => v.inject('repite')}
                disabled={busy}
              >
                <Repeat className="h-5 w-5" aria-hidden />
                Repetir
              </button>
              <button
                type="button"
                className={pill}
                onClick={() => v.inject('atrás')}
                disabled={busy}
              >
                <CornerUpLeft className="h-5 w-5" aria-hidden />
                Atrás
              </button>
              <button
                type="button"
                className={pill}
                onClick={() => v.inject('salta')}
                disabled={busy}
              >
                <SkipForward className="h-5 w-5" aria-hidden />
                Saltar
              </button>
            </>
          )}
          <button type="button" className={pill} onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
            Terminar
          </button>
        </div>
      )}

      {ended && (
        <button type="button" className={pill} onClick={onClose}>
          <X className="h-5 w-5" aria-hidden />
          Cerrar
        </button>
      )}

      <details className="w-full text-sm text-ink-muted">
        <summary className="cursor-pointer select-none py-1 font-semibold">Voz</summary>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            Velocidad
            <select
              value={String(v.settings.rate)}
              onChange={(e) => v.setSettings({ rate: Number(e.target.value) })}
              className="h-10 rounded-sm border border-border-strong bg-surface px-2 text-ink"
            >
              <option value="0.85">Lenta</option>
              <option value="1">Normal</option>
              <option value="1.2">Rápida</option>
            </select>
          </label>
          {v.cortexAvailable && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={v.settings.cortex}
                onChange={(e) => v.setSettings({ cortex: e.target.checked })}
                className="h-5 w-5 accent-primary"
              />
              Voz de Cortex
            </label>
          )}
        </div>
      </details>
    </div>
  );
}
