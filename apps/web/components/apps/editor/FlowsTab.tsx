'use client';

import { FlowEditor, type FlowEditorTable } from '@/components/trackers/FlowEditor';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type AppEditorData, CARD } from './shared';

/**
 * «Flujos»: por cada tabla que usan las pantallas de la app, el flujo por
 * estados (los estados en orden, quién da cada paso, qué se pide al entrar).
 * Cortex arma lo mismo con «agrega un flujo: recibido → en bodega → …» en el chat.
 */
export function FlowsTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const withState = data.trackers.filter((t) => t.fields.some((f) => f.type === 'select'));
  const [open, setOpen] = useState<string | null>(
    withState.find((t) => t.flow)?.slug ?? withState[0]?.slug ?? null,
  );
  if (withState.length === 0)
    return (
      <section className={CARD}>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Un flujo necesita una tabla con un campo de opciones (por ejemplo «Estado»). Ninguna tabla
          de esta app lo tiene todavía. Pídele a Cortex: «agrega un campo Estado a la tabla…».
        </p>
      </section>
    );
  return (
    <section className="space-y-3">
      <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
        El flujo hace que un registro avance por pasos: cada rol sólo ve y da los pasos que le
        tocan, y el servidor rechaza cualquier otro salto.
      </p>
      {withState.map((t) => (
        <div key={t.slug} className={CARD}>
          <button
            type="button"
            onClick={() => setOpen(open === t.slug ? null : t.slug)}
            aria-expanded={open === t.slug}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-sm font-bold text-ink">{t.name}</span>
            <span className="text-xs font-semibold text-ink-muted">
              {t.flow ? 'Con flujo' : 'Sin flujo'}
            </span>
          </button>
          {open === t.slug && (
            <div className="mt-4 border-t border-border pt-4">
              <FlowEditor
                table={t as unknown as FlowEditorTable}
                roles={data.roles.map((r) => ({ key: r.key, name: r.name }))}
                onSaved={() => router.refresh()}
              />
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
