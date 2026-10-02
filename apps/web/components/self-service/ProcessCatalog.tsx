'use client';

import { PROCESS_TEMPLATES, type ProcessTemplate } from '@/lib/self-service/catalog';
import { clsx } from 'clsx';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * EL CATÁLOGO DE PROCESOS LISTOS.
 *
 * Lo usan /procesos y el paso 3 de los primeros 10 minutos. Cada tarjeta abre
 * el chat con la petición escrita (lib/self-service/catalog.ts): activar un
 * proceso es una conversación en la que Cortex pregunta lo justo, no un
 * formulario que hay que entender antes de empezar.
 */
export function ProcessCatalog() {
  const [area, setArea] = useState<ProcessTemplate['area'] | 'Todos'>('Todos');
  const areas = ['Todos', ...new Set(PROCESS_TEMPLATES.map((t) => t.area))] as const;
  const shown = PROCESS_TEMPLATES.filter((t) => area === 'Todos' || t.area === area);

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Áreas" className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={area === a}
            onClick={() => setArea(a)}
            className={clsx(
              'rounded-pill px-3.5 py-1.5 text-xs font-bold transition-colors',
              area === a
                ? 'bg-ink text-surface'
                : 'border border-border bg-surface text-ink-muted hover:text-ink',
            )}
          >
            {a}
          </button>
        ))}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => (
          <li
            key={t.id}
            className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5 shadow-card"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-micro font-bold uppercase tracking-wider text-ink-faint">
                {t.area}
              </span>
              {t.featured && (
                <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                  El más usado
                </span>
              )}
            </div>
            <h2 className="text-base font-extrabold text-ink">{t.title}</h2>
            <p className="text-sm leading-relaxed text-ink-muted">{t.body}</p>
            <p className="text-xs text-ink-faint">Necesita: {t.needs}</p>
            <Link
              href={`/chat?prompt=${encodeURIComponent(t.prompt)}`}
              className={clsx(
                'mt-auto inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2.5 text-sm font-bold transition-colors',
                t.featured
                  ? 'cortex-primary-button bg-primary text-white hover:bg-primary-strong'
                  : 'border border-border-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              Activar en 2 minutos
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4 rounded-card border-2 border-dashed border-border-strong bg-surface p-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-extrabold text-ink">
            ¿No está el tuyo? Descríbelo y Cortex lo arma.
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            «Cuando llegue un pedido nuevo al correo, ponlo en la tabla y avísale al de turno.»
          </p>
        </div>
        <Link
          href={`/chat?prompt=${encodeURIComponent('Quiero que hagas esto solo, cada vez que pase: ')}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-ink px-4 py-2.5 text-sm font-bold text-surface hover:opacity-90"
        >
          Describir mi proceso
        </Link>
      </div>
    </div>
  );
}
