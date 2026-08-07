'use client';

import { clsx } from 'clsx';
import { Check, Loader2, SlidersHorizontal } from 'lucide-react';
import { useState, useTransition } from 'react';
import { saveTurnContextAdjustments } from '../../actions';
import type { AdjustView, SpaceOption } from './types';

/**
 * The three knobs — and the sentence that says how far each one reaches.
 *
 * WHY SO FEW. This panel could hold twenty controls and every one of them would
 * have a plausible advocate. It holds three, because a knob nobody understands
 * is worse than no knob: it gets turned, something changes, nobody connects the
 * two, and the product acquires a haunted setting. Each of these answers a
 * failure the panel above it has just SHOWN you — too many fragments crowding
 * out the good one, fragments from the wrong space, a family of tools being
 * dangled that had no business being on this turn. If you cannot see the
 * problem in the record above, you should not be reaching for a control.
 *
 * WHY THE SCOPE IS SAID OUT LOUD, EVERY TIME. "Solo en esta conversación" is
 * printed on the panel rather than left to be inferred, because the whole
 * hazard of a diagnostics control is somebody assuming it reaches further than
 * it does — or less far. Most people should never touch any of this, and the
 * person who does touch it should finish the interaction knowing exactly what
 * they changed and for whom.
 *
 * DEFAULTS ARE NOT PRE-FILLED AS NUMBERS. "Lo normal" is a real state, distinct
 * from "3", and it is what the conversation reverts to. If the product's
 * default moves, a conversation left on "lo normal" moves with it, which is the
 * behaviour somebody who never touched this expects.
 */

const MAX = 8;
const CHOICES: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Lo normal' },
  { value: 0, label: 'Ninguno' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
  { value: MAX, label: String(MAX) },
];

export function ContextAdjust({
  conversationId,
  initial,
  spaces,
  families,
  canEdit,
}: {
  conversationId: string;
  initial: AdjustView;
  spaces: SpaceOption[];
  /** Families seen on this conversation's turns, so the list is not abstract. */
  families: string[];
  /**
   * False for an org admin reading somebody else's conversation. Reading why it
   * answered is an oversight power; changing how another person's assistant
   * behaves is not the same thing, and is not offered here.
   */
  canEdit: boolean;
}) {
  const [value, setValue] = useState<AdjustView>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const commit = (next: AdjustView) => {
    setValue(next);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveTurnContextAdjustments(conversationId, next);
      if (res.ok) {
        setSaved(true);
        return;
      }
      setError(res.error);
      // Put the control back where it was: a switch that stays flipped after a
      // failed save is a switch that lies about the state of the system.
      setValue(value);
    });
  };

  if (!canEdit) return null;

  const toggleSpace = (id: string) => {
    const current = value.spaceIds ?? [];
    const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
    commit({ ...value, spaceIds: next.length === 0 ? null : next });
  };

  const toggleFamily = (family: string) => {
    const next = value.mutedFamilies.includes(family)
      ? value.mutedFamilies.filter((f) => f !== family)
      : [...value.mutedFamilies, family];
    commit({ ...value, mutedFamilies: next });
  };

  return (
    <div className="rounded-card border border-border bg-surface-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SlidersHorizontal className="h-3.5 w-3.5 text-ink-faint" />
        <h4 className="text-[12px] font-bold text-ink">Ajustar lo que recibe</h4>
        <span className="rounded-pill border border-border bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">
          Solo en esta conversación
        </span>
        {pending && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint motion-reduce:animate-none" />
        )}
        {saved && !pending && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald">
            <Check className="h-3 w-3" />
            Guardado
          </span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
        Cambia lo que se le entrega de aquí en adelante, y solo aquí. Ni otras conversaciones ni
        las de tus compañeros se enteran. Si empiezas una conversación nueva, vuelve todo a lo
        normal. La mayoría de la gente no debería tocar nada de esto.
      </p>

      {error && (
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[11.5px] text-rose">
          {error}
        </p>
      )}

      {/* ------------------------------------------------------- fragments */}
      <div className="mt-3">
        <div className="text-[11px] font-semibold text-ink">Cuántos fragmentos se le pegan</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {CHOICES.map((choice) => (
            <button
              key={String(choice.value)}
              type="button"
              disabled={pending}
              onClick={() => commit({ ...value, fragmentLimit: choice.value })}
              className={clsx(
                'rounded-pill border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50',
                value.fragmentLimit === choice.value
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
              )}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
          «Ninguno» le hace contestar sin nada del cerebro encima — útil para comprobar si el
          problema venía de ahí.
        </p>
      </div>

      {/* ---------------------------------------------------------- spaces */}
      {spaces.length > 1 && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-ink">De qué espacios puede sacarlos</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <button
              type="button"
              disabled={pending}
              onClick={() => commit({ ...value, spaceIds: null })}
              className={clsx(
                'rounded-pill border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50',
                value.spaceIds === null
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
              )}
            >
              Todos los que ves
            </button>
            {spaces.map((space) => (
              <button
                key={space.id}
                type="button"
                disabled={pending}
                onClick={() => toggleSpace(space.id)}
                className={clsx(
                  'rounded-pill border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50',
                  value.spaceIds?.includes(space.id)
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {space.name}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
            Esto solo recorta. Nunca te da acceso a un espacio que no puedas ver de todos modos.
          </p>
        </div>
      )}

      {/* --------------------------------------------------------- families */}
      {families.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-ink">
            Familias de herramientas que no quieres que se le ofrezcan
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {families.map((family) => {
              const muted = value.mutedFamilies.includes(family);
              return (
                <button
                  key={family}
                  type="button"
                  disabled={pending}
                  onClick={() => toggleFamily(family)}
                  className={clsx(
                    'rounded-pill border px-2.5 py-1 font-mono text-[11px] transition-colors disabled:opacity-50',
                    muted
                      ? 'border-rose/40 bg-rose-soft text-rose line-through'
                      : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
                  )}
                >
                  {family}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
            Tachada quiere decir que no se le ofrece aquí. Igual verás arriba lo que habría
            puntuado, para que puedas devolverte si te equivocaste.
          </p>
        </div>
      )}
    </div>
  );
}
