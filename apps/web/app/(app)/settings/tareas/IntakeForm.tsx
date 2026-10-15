'use client';

import { Panel } from '@/components/ui/panel';
import type { IntakePrefs } from '@/lib/task-intake/shape';
import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';

export type SaveIntakeFn = (input: unknown) => Promise<{ ok: boolean; note: string }>;

/**
 * AJUSTES › PEDIR TAREAS. Dos interruptores, ambos apagados de entrada: el
 * correo (lo que te mandas a ti, a tu alias +cortex o etiquetas «Cortex») y
 * WhatsApp («Cortex, …» desde tu número vinculado). Nada se envía solo.
 */
export function IntakeForm({
  initial,
  alias,
  save,
}: { initial: IntakePrefs; alias: string; save: SaveIntakeFn }) {
  const [prefs, setPrefs] = useState(initial);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const patch = (p: Partial<IntakePrefs>) => {
    setPrefs((cur) => ({ ...cur, ...p }));
    setDirty(true);
    setNote(null);
  };

  return (
    <div className="flex max-w-[44rem] flex-col gap-5">
      <Panel className="p-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={prefs.emailEnabled}
            onChange={(e) => patch({ emailEnabled: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-semibold text-ink">Pedir tareas por correo</span>
            <span className="mt-1 block text-sm text-ink-muted">
              Cortex revisa tu Gmail conectado cada pocos minutos y abre una tarea con lo que:
            </span>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
              <li>
                te mandas a ti mismo o a tu alias <strong className="text-ink">{alias}</strong>, o
              </li>
              <li>
                marcas con la etiqueta <strong className="text-ink">Cortex</strong> (créala en
                Gmail).
              </li>
            </ul>
            <span className="mt-2 block text-sm text-ink-muted">
              Los adjuntos quedan a su alcance en el hilo. Cortex no responde por correo: te avisa y
              te da el enlace de la tarea. Un correo de otra persona nunca abre una tarea si no lo
              marcas tú.
            </span>
          </span>
        </label>
      </Panel>

      <Panel className="p-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={prefs.whatsappEnabled}
            onChange={(e) => patch({ whatsappEnabled: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-semibold text-ink">Pedir tareas por WhatsApp</span>
            <span className="mt-1 block text-sm text-ink-muted">
              Desde tu número vinculado, escribe al WhatsApp de la empresa{' '}
              <strong className="text-ink">«Cortex, concilia el banco de septiembre»</strong>.
              Cortex contesta en ese mismo chat con un acuse y el enlace de la tarea.
            </span>
          </span>
        </label>
        <label className="mt-4 ml-7 flex max-w-xs flex-col gap-1 text-xs font-semibold text-ink">
          Otra palabra que también sirva (opcional)
          <input
            className="min-h-9 rounded-input border border-border-strong bg-surface px-2.5 text-sm font-normal"
            value={prefs.whatsappKeyword ?? ''}
            maxLength={20}
            placeholder="p. ej. tarea"
            onChange={(e) => patch({ whatsappKeyword: e.target.value.trim() || null })}
          />
        </label>
      </Panel>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              const r = await save(prefs);
              setNote({ ok: r.ok, text: r.note });
              if (r.ok) setDirty(false);
            })
          }
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-ink disabled:opacity-60"
        >
          {pending && (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          Guardar
        </button>
        {note && (
          <p className={`text-sm ${note.ok ? 'text-emerald' : 'text-rose'}`} aria-live="polite">
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
