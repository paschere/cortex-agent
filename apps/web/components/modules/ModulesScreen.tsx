'use client';

import { Panel } from '@/components/ui/panel';
import type { ModuleArea, ModuleCard } from '@/lib/modules/shape';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { PresetPicker } from './PresetPicker';
import type { ModuleActions, PresetOption } from './types';

/**
 * AJUSTES › MÓDULOS: CADA ÁREA DE CORTEX CON SU INTERRUPTOR.
 *
 * Tarjetas por área, cada una con lo que trae en palabras (sus pantallas y lo
 * que Cortex puede hacer con él en el chat) y lo que necesita. Quien no
 * administra ve lo mismo sin poder mover nada: saber por qué no aparece
 * Inventario también es una respuesta.
 */
export function ModulesScreen({
  areas,
  canEdit,
  actions,
  presets,
  workspaceId,
}: {
  areas: ModuleArea[];
  canEdit: boolean;
  actions: ModuleActions;
  presets: PresetOption[];
  /** El espacio de trabajo, para que los enlaces no lo pierdan. */
  workspaceId?: string;
}) {
  const hrefFor = (href: string) => (workspaceId ? workspaceHref(workspaceId, href) : href);
  const on = areas.flatMap((a) => a.modules).filter((m) => m.enabled).length;
  const total = areas.flatMap((a) => a.modules).length;
  return (
    <div className="flex flex-col gap-8">
      {canEdit ? (
        <PresetPicker presets={presets} actions={actions} />
      ) : (
        <p className="flex items-start gap-2 rounded-card border border-border bg-surface-2 px-4 py-3 text-sm text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Sólo quien administra la empresa o es su dueño puede prender o apagar módulos. Aquí ves
          cuáles están prendidos y qué trae cada uno.
        </p>
      )}

      <p className="text-sm text-ink-muted">
        <span className="tabular font-bold text-ink">{on}</span> de{' '}
        <span className="tabular">{total}</span> módulos prendidos. Apagar uno lo saca del menú, de
        lo que Cortex puede hacer en el chat y del piloto automático; no borra datos.
      </p>

      {areas.map((area) => (
        <section
          key={area.area}
          aria-labelledby={`area-${area.area}`}
          className="flex flex-col gap-3"
        >
          <h2
            id={`area-${area.area}`}
            className="text-sm font-extrabold uppercase tracking-wide text-ink-faint"
          >
            {area.area}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {area.modules.map((m) => (
              <ModuleTile
                key={m.key}
                module={m}
                canEdit={canEdit}
                toggle={actions.toggle}
                hrefFor={hrefFor}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const TOOLS_SHOWN = 4;

function ModuleTile({
  module: m,
  canEdit,
  toggle,
  hrefFor,
}: {
  module: ModuleCard;
  canEdit: boolean;
  toggle: ModuleActions['toggle'];
  hrefFor: (href: string) => string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  // Apagar uno que otro prendido necesita no se ofrece: el interruptor lo dice.
  const locked = m.enabled && m.blockedBy.length > 0;
  const disabled = !canEdit || pending || locked;
  const id = `module-${m.key}`;

  function flip() {
    if (disabled) return;
    start(async () => {
      const res = await toggle(m.key, !m.enabled);
      setNote({ ok: res.ok, text: res.note });
      if (res.ok) router.refresh();
    });
  }

  const tools = open ? m.tools : m.tools.slice(0, TOOLS_SHOWN);
  return (
    <Panel className={clsx('flex flex-col gap-3 p-4', !m.enabled && 'bg-surface-2/60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={id} className="flex flex-wrap items-center gap-2 text-base font-bold text-ink">
            {m.label}
            {m.beta && (
              <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                Beta
              </span>
            )}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{m.description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={m.enabled}
          aria-labelledby={id}
          disabled={disabled}
          onClick={flip}
          title={
            locked
              ? `${m.blockedBy.join(' y ')} lo necesita${m.blockedBy.length > 1 ? 'n' : ''}`
              : undefined
          }
          className={clsx(
            'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-pill transition-colors',
            m.enabled ? 'bg-primary' : 'bg-border-strong',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <span
            className={clsx(
              'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
              m.enabled ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
          <span className="sr-only">{m.enabled ? 'Prendido' : 'Apagado'}</span>
        </button>
      </div>

      <div className="text-sm">
        <p className="text-micro font-bold uppercase tracking-wide text-ink-faint">Qué incluye</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-ink-muted">
          {m.screens.map((s) => (
            <li key={s.href}>
              Pantalla{' '}
              {m.enabled ? (
                <Link href={hrefFor(s.href)} className="font-bold text-primary hover:underline">
                  {s.label}
                </Link>
              ) : (
                <span className="font-bold text-ink">{s.label}</span>
              )}
            </li>
          ))}
          {tools.map((t) => (
            <li key={t}>En el chat: {t.charAt(0).toLowerCase() + t.slice(1)}</li>
          ))}
          {!open && m.tools.length > TOOLS_SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="font-bold text-primary hover:underline"
              >
                y {m.tools.length - TOOLS_SHOWN} más
              </button>
            </li>
          )}
          {m.tools.length === 0 && m.screens.length === 0 && <li>Llega pronto.</li>}
        </ul>
      </div>

      {(m.note || locked) && (
        <p className="text-xs text-ink-faint">
          {locked
            ? `No se puede apagar mientras ${m.blockedBy.join(' y ')} esté${m.blockedBy.length > 1 ? 'n' : ''} prendido${m.blockedBy.length > 1 ? 's' : ''}.`
            : m.note}
        </p>
      )}
      {note && (
        <p aria-live="polite" className={clsx('text-xs', note.ok ? 'text-emerald' : 'text-rose')}>
          {note.text}
        </p>
      )}
    </Panel>
  );
}
