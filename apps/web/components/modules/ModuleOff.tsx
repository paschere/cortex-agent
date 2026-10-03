'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import type { ModulePageState } from '@/lib/modules/shape';
import { PowerOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ModuleActions } from './types';

/**
 * «ESTE MÓDULO ESTÁ APAGADO», EN VEZ DE UN 404.
 *
 * Alguien que llega a /pagar por un enlace viejo o un marcador no tiene por
 * qué saber que la empresa apagó Cuentas por pagar: un 404 le diría que algo
 * se rompió. Esto le dice qué pasó, que no se perdió nada, y — si administra —
 * le deja prenderlo ahí mismo.
 */
export function ModuleOff({
  state,
  toggle,
  modulesHref = '/settings/modulos',
}: {
  state: Extract<ModulePageState, { off: true }>;
  toggle?: ModuleActions['toggle'];
  modulesHref?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  function enable() {
    if (!toggle) return;
    start(async () => {
      const res = await toggle(state.key, true);
      setNote({ ok: res.ok, text: res.note });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-10">
      <Panel className="w-full p-6 text-center md:p-8">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-pill bg-surface-2 text-ink-muted">
          <PowerOff className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">
          Este módulo está apagado
        </h1>
        <p className="mt-2 text-base font-bold text-ink">{state.label}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{state.description}</p>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          Apagarlo no borró nada: cuando se prenda, todo vuelve como estaba.
        </p>
        {state.canEnable && toggle ? (
          <div className="mt-6 flex flex-col items-center gap-2">
            <Button type="button" onClick={enable} disabled={pending}>
              {pending ? 'Prendiendo…' : 'Prenderlo'}
            </Button>
            {state.alsoEnables.length > 0 && (
              <p className="text-xs text-ink-faint">
                También prende {state.alsoEnables.join(' y ')}, que necesita.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-6 rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink-muted">
            Pídele a quien administra la empresa que lo prenda en Ajustes › Módulos.
          </p>
        )}
        {note && (
          <p
            aria-live="polite"
            className={note.ok ? 'mt-4 text-sm text-emerald' : 'mt-4 text-sm text-rose'}
          >
            {note.text}
          </p>
        )}
        <Link
          href={modulesHref}
          className="mt-6 inline-block text-sm font-bold text-primary hover:underline"
        >
          Ver todos los módulos
        </Link>
      </Panel>
    </div>
  );
}
