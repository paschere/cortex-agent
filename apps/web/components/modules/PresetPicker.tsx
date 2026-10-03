'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { Briefcase, Factory, Store, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ModuleActions, PresetOption } from './types';

const ICON: Record<string, typeof Store> = {
  comercio: Store,
  servicios: Briefcase,
  logistica: Truck,
  manufactura: Factory,
};

/**
 * «¿QUÉ HACE TU EMPRESA?» — la pregunta de la puesta en marcha.
 *
 * Elegir una respuesta NO cambia nada: enseña qué prendería y qué apagaría, y
 * sólo «Aplicar» lo escribe. Es un punto de partida; cada módulo se sigue
 * moviendo suelto después.
 */
export function PresetPicker({
  presets,
  actions,
  compact = false,
}: {
  presets: PresetOption[];
  actions: Pick<ModuleActions, 'previewPreset' | 'applyPreset'>;
  /** En la puesta en marcha va más corto. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ on: string[]; off: string[]; note: string } | null>(
    null,
  );
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function pick(key: string) {
    setChosen(key);
    setResult(null);
    setPreview(null);
    start(async () => {
      const res = await actions.previewPreset(key);
      if (!res.ok) setResult({ ok: false, text: res.note });
      else setPreview({ on: res.on, off: res.off, note: res.note });
    });
  }

  function apply() {
    if (!chosen) return;
    start(async () => {
      const res = await actions.applyPreset(chosen);
      setResult({ ok: res.ok, text: res.note });
      if (res.ok) {
        setPreview(null);
        router.refresh();
      }
    });
  }

  const nothing = preview && preview.on.length === 0 && preview.off.length === 0;
  return (
    <Panel className={clsx('flex flex-col gap-4', compact ? 'p-4' : 'p-5')}>
      <div>
        <h2 className="text-lg font-extrabold tracking-tight text-ink">¿Qué hace tu empresa?</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Te sugiero qué módulos prender. No cambia nada hasta que lo confirmes.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {presets.map((p) => {
          const Icon = ICON[p.key] ?? Store;
          const active = chosen === p.key;
          return (
            <button
              key={p.key}
              type="button"
              aria-pressed={active}
              onClick={() => pick(p.key)}
              disabled={pending}
              className={clsx(
                'flex flex-col items-start gap-1 rounded-card border p-3 text-left transition-colors',
                active
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-surface hover:bg-surface-2',
              )}
            >
              <Icon className={clsx('h-5 w-5', active ? 'text-primary' : 'text-ink-muted')} />
              <span className="text-sm font-bold text-ink">{p.label}</span>
              <span className="text-xs leading-snug text-ink-faint">{p.examples}</span>
            </button>
          );
        })}
      </div>

      {preview && (
        <div className="rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink-muted">
          {nothing ? (
            <p>{preview.note || 'Ya tienes prendido justo lo que sugiero.'}</p>
          ) : (
            <>
              {preview.on.length > 0 && (
                <p>
                  <span className="font-bold text-ink">Prendería:</span> {preview.on.join(', ')}.
                </p>
              )}
              {preview.off.length > 0 && (
                <p className="mt-1">
                  <span className="font-bold text-ink">Apagaría:</span> {preview.off.join(', ')}. No
                  se borra ningún dato.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" onClick={apply} disabled={pending}>
                  {pending ? 'Aplicando…' : 'Aplicar'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPreview(null);
                    setChosen(null);
                  }}
                  disabled={pending}
                >
                  Ahora no
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {result && (
        <p aria-live="polite" className={clsx('text-sm', result.ok ? 'text-emerald' : 'text-rose')}>
          {result.text}
        </p>
      )}
    </Panel>
  );
}
