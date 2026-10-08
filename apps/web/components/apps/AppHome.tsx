'use client';

import { cardHref } from '@/lib/apps/app-nav';
import type { ComputedHome, ComputedHomeCard } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowRight, CheckCircle2, ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { Glyph } from './AppGlyph';

/**
 * EL INICIO DE UNA APP (0215): el saludo y las tarjetas que el administrador
 * armó para ESTE rol. Las cifras ya vienen calculadas en el servidor con el
 * scope de filas del rol (computeHome); aquí sólo se pintan.
 *
 * Una cifra en cero no celebra ni asusta: dice qué falta y deja a un toque la
 * pantalla donde se arregla. Cada tarjeta que lleva a una pantalla es toda
 * ella un enlace (≥ 44 px de alto).
 */

const TONE: Record<ComputedHomeCard['tone'], { chip: string; ring: string }> = {
  primary: { chip: 'bg-primary-soft text-primary-ink', ring: 'hover:border-primary/50' },
  emerald: { chip: 'bg-emerald-soft text-emerald', ring: 'hover:border-emerald/50' },
  amber: { chip: 'bg-amber-soft text-amber', ring: 'hover:border-amber/50' },
  sky: { chip: 'bg-sky-soft text-sky', ring: 'hover:border-sky/50' },
  rose: { chip: 'bg-rose-soft text-rose', ring: 'hover:border-rose/50' },
};

const CARD =
  'group relative flex min-h-11 flex-col gap-2 rounded-card border border-border bg-surface p-4 shadow-card transition-colors motion-reduce:transition-none';

export function AppHome({
  home,
  base,
  como = '',
  appName,
}: {
  home: ComputedHome;
  /** /apps/<slug> o /a/<id>. */
  base: string;
  como?: string;
  appName: string;
}) {
  return (
    <div className="space-y-5">
      {home.greeting ? (
        <header>
          <h1 className="text-xl font-extrabold tracking-tight text-ink">{home.greeting.title}</h1>
          <p className="mt-0.5 text-xs text-ink-muted first-letter:uppercase">
            {home.greeting.date}
          </p>
        </header>
      ) : (
        <h1 className="text-xl font-extrabold tracking-tight text-ink">{appName}</h1>
      )}

      {home.cards.length === 0 ? (
        <div className="rounded-card border border-dashed border-border-strong bg-surface p-6 text-center">
          <ClipboardList className="mx-auto h-6 w-6 text-ink-faint" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-ink">Este inicio aún no tiene tarjetas</p>
          <p className="mt-1 text-xs text-ink-muted">
            Usa el menú para ir a las pantallas de la app. Quien la administra puede agregar
            tarjetas desde el editor.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {home.cards.map((card) => (
            <Card key={card.id} card={card} base={base} como={como} />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ card, base, como }: { card: ComputedHomeCard; base: string; como: string }) {
  const href = cardHref(base, como, card);
  const tone = TONE[card.tone];
  const body =
    card.kind === 'shortcut' ? (
      <>
        <span className={clsx('grid h-10 w-10 place-items-center rounded-sm', tone.chip)}>
          <Glyph name={card.icon || 'ClipboardPlus'} className="h-5 w-5 text-xl" />
        </span>
        <span className="text-base font-bold text-ink">{card.text}</span>
        {card.hint && <span className="text-xs text-ink-muted">{card.hint}</span>}
      </>
    ) : card.kind === 'pending' ? (
      <>
        <div className="flex items-center gap-3">
          {card.empty ? (
            <span className="grid h-10 w-10 place-items-center rounded-sm bg-emerald-soft text-emerald">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </span>
          ) : (
            <span
              className={clsx(
                'grid h-10 min-w-10 place-items-center rounded-sm px-2 font-mono text-lg font-extrabold tabular-nums',
                tone.chip,
              )}
            >
              {card.n}
            </span>
          )}
          <span className="text-sm font-semibold text-ink">{card.text}</span>
        </div>
        {card.rows.length > 0 && (
          <ul className="space-y-1 border-t border-border pt-2">
            {card.rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: las filas de ejemplo no tienen id y no se reordenan
              <li key={i} className="truncate font-mono text-xs text-ink-muted">
                {row}
              </li>
            ))}
          </ul>
        )}
        {href && (
          <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
            {card.empty ? 'Ver la lista' : 'Abrir la lista'}{' '}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </>
    ) : (
      <>
        <span
          className={clsx(
            'font-mono text-display font-extrabold leading-none tabular-nums',
            card.empty ? 'text-ink-faint' : 'text-ink',
          )}
        >
          {card.n}
        </span>
        <span className="text-sm font-semibold text-ink">{card.text}</span>
        {href && (
          <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
            {card.empty ? 'Abrir' : 'Ver detalle'}{' '}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </>
    );
  return href ? (
    <Link
      href={href}
      className={clsx(CARD, tone.ring, 'focus-visible:ring-2 focus-visible:ring-primary/40')}
    >
      {body}
    </Link>
  ) : (
    <div className={CARD}>{body}</div>
  );
}
