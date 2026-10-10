'use client';

import { cardHref } from '@/lib/apps/app-nav';
import type { ComputedHome, ComputedHomeCard } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowRight, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { DeltaPill } from '../charts/DeltaPill';
import { Sparkline } from '../charts/Sparkline';
import { Glyph } from './AppGlyph';
import { AppIllustration } from './AppIllustration';

/**
 * EL INICIO DE UNA APP (0215, rediseño 0217): un saludo con la marca de la
 * empresa y, debajo, lo que el administrador armó para ESTE rol, en tres
 * familias que se leen de un vistazo en el celular:
 *
 *   - cifras: número grande, la tendencia y un micrográfico si hay serie;
 *   - accesos rápidos: botones grandes que llevan a registrar algo;
 *   - pendientes: una lista con su estado en un chip y las primeras filas.
 *
 * Las cifras ya vienen calculadas en el servidor con el scope de filas del rol
 * (computeHome); aquí sólo se pintan. Una cifra en cero no celebra ni asusta:
 * dice qué falta y deja a un toque la pantalla donde se arregla. Cada tarjeta
 * que lleva a una pantalla es toda ella un enlace (≥ 44 px de alto). El color
 * de la marca sólo se gasta en el saludo, los accesos y el foco; el resto es
 * neutro y los tonos de estado conservan su sentido (ámbar: atención).
 */

const TONE: Record<
  ComputedHomeCard['tone'],
  { chip: string; text: string; bar: string; ring: string }
> = {
  primary: {
    chip: 'bg-primary-soft text-primary-ink',
    text: 'text-primary',
    bar: 'bg-primary',
    ring: 'hover:border-primary/40',
  },
  emerald: {
    chip: 'bg-emerald-soft text-emerald',
    text: 'text-emerald',
    bar: 'bg-emerald',
    ring: 'hover:border-emerald/40',
  },
  amber: {
    chip: 'bg-amber-soft text-amber',
    text: 'text-amber',
    bar: 'bg-amber',
    ring: 'hover:border-amber/40',
  },
  sky: {
    chip: 'bg-sky-soft text-sky',
    text: 'text-sky',
    bar: 'bg-sky',
    ring: 'hover:border-sky/40',
  },
  rose: {
    chip: 'bg-rose-soft text-rose',
    text: 'text-rose',
    bar: 'bg-rose',
    ring: 'hover:border-rose/40',
  },
};

const CARD =
  'app-press group relative flex min-h-11 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card motion-reduce:transition-none';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

/** «▲ 3 vs. antes»: la diferencia entre el último valor de la serie y el anterior. */
function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const last = values[values.length - 1] ?? 0;
  const prev = values[values.length - 2] ?? 0;
  const delta = last - prev;
  return (
    <>
      <DeltaPill
        ratio={delta === 0 ? 0 : delta / (Math.abs(prev) || 1)}
        good={null}
        text={`${delta > 0 ? '+' : delta < 0 ? '−' : '='}${Math.abs(delta)}`}
      />
      <span className="sr-only"> frente a la medición anterior</span>
    </>
  );
}

export function AppHome({
  home,
  base,
  como = '',
  appName,
  roleName,
}: {
  home: ComputedHome;
  /** /apps/<slug> o /a/<id>. */
  base: string;
  como?: string;
  appName: string;
  roleName?: string;
}) {
  const counters = home.cards.filter((c) => c.kind === 'counter');
  const shortcuts = home.cards.filter((c) => c.kind === 'shortcut');
  const pendings = home.cards.filter((c) => c.kind === 'pending');
  const open = pendings.reduce((sum, c) => sum + (c.empty ? 0 : (c.n ?? 0)), 0);
  let place = 0;
  const next = () => place++;

  return (
    <div className="space-y-6">
      <header className="app-hero rounded-card border border-border p-5 shadow-card sm:p-6">
        <h1 className="text-xl font-extrabold leading-tight tracking-tight text-ink sm:text-display">
          {home.greeting?.title ?? appName}
        </h1>
        {home.greeting && (
          <p className="mt-1 text-xs font-medium text-ink-muted first-letter:uppercase">
            {home.greeting.date}
          </p>
        )}
        {(roleName || pendings.length > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {roleName && (
              <span className="inline-flex h-7 items-center rounded-pill bg-surface/80 px-3 text-micro font-semibold text-ink-muted ring-1 ring-border">
                {roleName}
              </span>
            )}
            {pendings.length > 0 && (
              <span
                className={clsx(
                  'inline-flex h-7 items-center gap-1.5 rounded-pill px-3 text-micro font-semibold',
                  open > 0 ? 'bg-amber-soft text-amber' : 'bg-emerald-soft text-emerald',
                )}
              >
                <span
                  aria-hidden
                  className={clsx('h-1.5 w-1.5 rounded-pill', open > 0 ? 'bg-amber' : 'bg-emerald')}
                />
                {open > 0 ? `${open} por atender` : 'Todo al día'}
              </span>
            )}
          </div>
        )}
      </header>

      {home.cards.length === 0 ? (
        <div className="flex flex-col items-center rounded-card border border-dashed border-border-strong bg-surface px-6 py-8 text-center">
          <AppIllustration kind="empty" />
          <p className="mt-3 text-base font-bold text-ink">Este inicio aún no tiene tarjetas</p>
          <p className="mt-1 max-w-xs text-xs text-ink-muted">
            Usa el menú para ir a las pantallas de la app. Quien la administra puede agregar
            tarjetas desde el editor.
          </p>
        </div>
      ) : (
        <>
          {counters.length > 0 && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {counters.map((card, i) => (
                <Counter
                  key={card.id}
                  card={card}
                  base={base}
                  como={como}
                  place={next()}
                  wide={counters.length % 2 === 1 && i === counters.length - 1}
                />
              ))}
            </div>
          )}

          {shortcuts.length > 0 && (
            <section aria-label="Accesos rápidos" className="space-y-3">
              <h2 className="px-1 text-base font-extrabold tracking-tight text-ink">
                Accesos rápidos
              </h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {shortcuts.map((card, i) => (
                  <Shortcut
                    key={card.id}
                    card={card}
                    base={base}
                    como={como}
                    place={next()}
                    wide={shortcuts.length % 2 === 1 && i === shortcuts.length - 1}
                  />
                ))}
              </div>
            </section>
          )}

          {pendings.length > 0 && (
            <section aria-label="Pendientes" className="space-y-3">
              <h2 className="px-1 text-base font-extrabold tracking-tight text-ink">Pendientes</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {pendings.map((card) => (
                  <Pending key={card.id} card={card} base={base} como={como} place={next()} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Envuelve el cuerpo: enlace si la tarjeta lleva a una pantalla, tarjeta fija si no. */
function Shell({
  href,
  className,
  place,
  children,
}: {
  href: string | null;
  className: string;
  place: number;
  children: React.ReactNode;
}) {
  const style = { '--i': place } as React.CSSProperties;
  return href ? (
    <Link href={href} style={style} className={clsx(className, 'app-rise', FOCUS)}>
      {children}
    </Link>
  ) : (
    <div style={style} className={clsx(className, 'app-rise')}>
      {children}
    </div>
  );
}

function Counter({
  card,
  base,
  como,
  place,
  wide,
}: { card: ComputedHomeCard; base: string; como: string; place: number; wide: boolean }) {
  const href = cardHref(base, como, card);
  const tone = TONE[card.tone];
  const series = card.series ?? [];
  return (
    <Shell
      href={href}
      place={place}
      className={clsx(
        CARD,
        'gap-1 p-4',
        wide && 'col-span-2 lg:col-span-1',
        href && tone.ring,
        href && 'active:bg-surface-2',
      )}
    >
      <span
        aria-hidden
        className={clsx('absolute inset-x-4 top-0 h-[3px] rounded-b-pill', tone.bar)}
      />
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-xs font-semibold leading-snug text-ink-muted">
          {card.text}
        </span>
        {href && (
          <ArrowUpRight
            className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none"
            aria-hidden
          />
        )}
      </span>
      <span className="mt-1 flex items-end justify-between gap-2">
        <span
          className={clsx(
            'font-mono text-display font-extrabold leading-none tracking-tight tabular-nums',
            card.empty ? 'text-ink-faint' : 'text-ink',
          )}
        >
          {card.n}
        </span>
        <Trend values={series} />
      </span>
      {series.length >= 2 ? (
        <span className={clsx('mt-2 block', tone.text)}>
          <Sparkline values={series} color="currentColor" height={36} name={card.text} />
        </span>
      ) : (
        card.empty &&
        href && (
          <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary">
            Abrir <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        )
      )}
    </Shell>
  );
}

function Shortcut({
  card,
  base,
  como,
  place,
  wide,
}: { card: ComputedHomeCard; base: string; como: string; place: number; wide: boolean }) {
  const href = cardHref(base, como, card);
  return (
    <Shell
      href={href}
      place={place}
      className={clsx(
        CARD,
        'cortex-primary-button min-h-28 justify-between gap-5 border-transparent bg-primary p-4 text-white shadow-pop',
        wide && 'col-span-2 lg:col-span-1',
      )}
    >
      <span className="grid h-11 w-11 place-items-center rounded-sm bg-white/20 ring-1 ring-white/25">
        <Glyph name={card.icon || 'ClipboardPlus'} className="h-6 w-6 text-2xl" />
      </span>
      <span className="block">
        <span className="block text-base font-extrabold leading-snug">{card.text}</span>
        {card.hint && <span className="mt-0.5 block text-xs opacity-90">{card.hint}</span>}
      </span>
      <ArrowRight
        className="absolute right-4 top-4 h-5 w-5 opacity-80 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden
      />
    </Shell>
  );
}

function Pending({
  card,
  base,
  como,
  place,
}: { card: ComputedHomeCard; base: string; como: string; place: number }) {
  const href = cardHref(base, como, card);
  const tone = TONE[card.tone];
  return (
    <Shell
      href={href}
      place={place}
      className={clsx(CARD, 'gap-3 p-4', href && tone.ring, href && 'active:bg-surface-2')}
    >
      <span className="flex items-center gap-3">
        {card.empty ? (
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-emerald-soft text-emerald">
            <CheckCircle2 className="h-6 w-6" aria-hidden />
          </span>
        ) : (
          <span
            className={clsx(
              'grid h-11 min-w-11 shrink-0 place-items-center rounded-sm px-2 font-mono text-lg font-extrabold tabular-nums',
              tone.chip,
            )}
          >
            {card.n}
          </span>
        )}
        <span className="min-w-0 flex-1 text-sm font-bold leading-snug text-ink">{card.text}</span>
        <span
          className={clsx(
            'inline-flex h-6 shrink-0 items-center rounded-pill px-2.5 text-micro font-semibold',
            card.empty ? 'bg-emerald-soft text-emerald' : tone.chip,
          )}
        >
          {card.empty ? 'Al día' : 'Por atender'}
        </span>
      </span>
      {card.rows.length > 0 && (
        <ul className="space-y-1.5 rounded-sm bg-surface-2/70 p-3">
          {card.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: las filas de ejemplo no tienen id y no se reordenan
            <li key={i} className="flex items-center gap-2 truncate font-mono text-xs text-ink">
              <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-pill', tone.bar)} />
              <span className="truncate">{row}</span>
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
    </Shell>
  );
}
