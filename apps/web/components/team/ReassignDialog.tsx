'use client';

import type { MoveModel } from '@/lib/team/screen';
import { clsx } from 'clsx';
import { ArrowRightLeft, Loader2, X } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import type { TeamActions } from './types';

const pill =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill px-4 py-1.5 text-xs font-semibold transition-colors';

/**
 * «Reasignar»: las movidas que sugiere la señal, ítem por ítem, para que quien
 * administra quite lo que no quiera pasar y confirme. Nada se mueve sin el
 * botón de confirmar; el servidor vuelve a aplicar las reglas de work.assign.
 */
export function ReassignDialog({
  moves,
  blocked,
  fromName,
  reassign,
}: {
  moves: MoveModel[];
  blocked: number;
  fromName: string | null;
  reassign: TeamActions['reassign'];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const all = moves.flatMap((m) => m.items.map((i) => i.id));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(all));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const count = chosen.size;
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const confirm = () =>
    start(async () => {
      const r = await reassign({
        moves: moves
          .map((m) => ({
            toId: m.toId,
            itemIds: m.items.map((i) => i.id).filter((id) => chosen.has(id)),
          }))
          .filter((m) => m.itemIds.length > 0),
      });
      setResult(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
    });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setChosen(new Set(all));
          ref.current?.showModal();
        }}
        className={clsx(
          pill,
          'cortex-primary-button bg-primary font-bold text-white hover:bg-primary-strong',
        )}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />
        Reasignar
      </button>
      <dialog
        ref={ref}
        aria-labelledby="reasignar-titulo"
        className="m-auto w-[min(560px,calc(100vw-2rem))] rounded-card border border-border bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/30"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="reasignar-titulo" className="text-lg font-extrabold">
              Reasignar trabajo
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {fromName ? `De ${fromName}, ` : 'Lo que no tiene responsable, '}a quien tiene menos
              carga en el mismo tipo de trabajo. Quita lo que prefieras dejar.
            </p>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-pill p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          {moves.map((m) => (
            <fieldset key={m.toId}>
              <legend className="text-sm font-bold">
                A {m.toName}{' '}
                <span className="font-normal text-ink-muted">
                  (tiene <span className="tabular">{m.toOpen}</span> abiertos)
                </span>
              </legend>
              <ul className="mt-2 space-y-1">
                {m.items.map((i) => (
                  <li key={i.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={chosen.has(i.id)}
                        onChange={() => toggle(i.id)}
                        disabled={pending || result?.ok}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate">{i.title}</span>
                      {i.overdue && (
                        <span className="text-micro font-semibold text-rose">vencido</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
          {blocked > 0 && (
            <p className="rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              {blocked === 1 ? '1 ítem es' : `${blocked} ítems son`} de Gerencia o una aprobación:
              se pasan en su propia pantalla, no desde aquí.
            </p>
          )}
          <p className="text-xs text-ink-muted">
            El cambio se hace en la fuente (el compromiso o la fila de la tabla) y a cada persona le
            llega un aviso en la campana.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
          <output
            aria-live="polite"
            className={clsx('text-xs', result ? (result.ok ? 'text-emerald' : 'text-rose') : '')}
          >
            {result?.text ?? ''}
          </output>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className={clsx(
                pill,
                'border border-border-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              {result?.ok ? 'Cerrar' : 'Cancelar'}
            </button>
            {!result?.ok && (
              <button
                type="button"
                disabled={pending || count === 0}
                onClick={confirm}
                className={clsx(
                  pill,
                  'cortex-primary-button bg-primary font-bold text-white hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Pasar {count} {count === 1 ? 'ítem' : 'ítems'}
              </button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
