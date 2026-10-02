'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRecordOpener } from './RecordDrawer';
import { Card, EmptyState, TONE_BAR, TONE_SOFT, shortDay, upperFirst } from './theme';

/**
 * EL CALENDARIO: CITAS, ENTREGAS, CLASES, VENCIMIENTOS.
 *
 * Dos formas. `month`: la cuadrícula del mes, de lunes a domingo; el cálculo
 * entregó el mes anterior, el actual y el siguiente, y las flechas se mueven
 * entre ellos sin pedir nada al servidor (fuera de ese rango no hay datos, así
 * que las flechas se apagan en los bordes). `agenda`: los próximos días, cada
 * uno con sus eventos.
 *
 * En la cuadrícula, cada día es un botón que lo elige; lo elegido se lista
 * debajo, y ahí cada evento abre su ficha. En escritorio los eventos también
 * se ven dentro del día; en un teléfono la celda no cabe, y lleva puntos.
 */

type Calendar = Extract<ComputedBlock, { type: 'calendar' }>;
type CalEvent = Calendar['events'][number];

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

function monthTitle(month: string): string {
  return upperFirst(
    new Intl.DateTimeFormat('es-CO', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month}-15T12:00:00Z`)),
  );
}

/** Las celdas del mes: días del mes con relleno para empezar en lunes. */
function monthCells(month: string): Array<string | null> {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1, 12));
  const days = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function CalendarBlock({ block }: { block: Calendar }) {
  const open = useRecordOpener(block.id, block.record);
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of block.events) map.set(e.day, [...(map.get(e.day) ?? []), e]);
    return map;
  }, [block.events]);

  return block.mode === 'agenda' ? (
    <Card title={block.title} source={block.source}>
      <Agenda block={block} byDay={byDay} open={open} />
      <Legend legend={block.legend} />
    </Card>
  ) : (
    <MonthView block={block} byDay={byDay} open={open} />
  );
}

function EventButton({
  event,
  open,
  compact,
}: {
  event: CalEvent;
  open: ((id: string) => void) | null;
  compact?: boolean;
}) {
  const className = clsx(
    'flex w-full min-w-0 items-center gap-1.5 text-left transition-colors duration-150',
    compact
      ? 'rounded-pill px-1.5 py-px text-micro'
      : 'rounded-sm border border-border/70 bg-surface px-3 py-2 text-sm shadow-card',
    compact && (event.tone ? TONE_SOFT[event.tone] : 'bg-surface-2 text-ink'),
    open &&
      (compact
        ? 'hover:brightness-95 focus-visible:ring-2 focus-visible:ring-primary/40'
        : 'hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary/40'),
  );
  const body = (
    <>
      {!compact && (
        <span
          aria-hidden
          className={clsx(
            'h-2 w-2 shrink-0 rounded-pill',
            event.tone ? TONE_BAR[event.tone] : 'bg-ink-faint',
          )}
        />
      )}
      <span className={clsx('truncate', compact ? 'font-medium' : 'font-semibold text-ink')}>
        {event.label}
      </span>
      {!compact && event.tag && (
        <span className="ml-auto shrink-0 text-micro text-ink-faint">{event.tag}</span>
      )}
    </>
  );
  return open ? (
    <button type="button" onClick={() => open(event.id)} className={className} title={event.label}>
      {body}
    </button>
  ) : (
    <span className={className} title={event.label}>
      {body}
    </span>
  );
}

function MonthView({
  block,
  byDay,
  open,
}: {
  block: Calendar;
  byDay: Map<string, CalEvent[]>;
  open: ((id: string) => void) | null;
}) {
  const current = block.today.slice(0, 7);
  const [month, setMonth] = useState(() =>
    block.months.includes(current) ? current : (block.months[0] ?? current),
  );
  const [selected, setSelected] = useState<string | null>(block.today);
  const at = block.months.indexOf(month);
  const cells = useMemo(() => monthCells(month), [month]);
  const chosen = selected?.startsWith(month) ? selected : null;
  const chosenEvents = chosen ? (byDay.get(chosen) ?? []) : [];

  const go = (delta: number) => {
    const next = block.months[at + delta];
    if (!next) return;
    setMonth(next);
    setSelected(next === current ? block.today : null);
  };

  return (
    <Card
      title={block.title}
      action={
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={at <= 0}
            aria-label="Mes anterior"
            className="grid h-7 w-7 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span
            aria-live="polite"
            className="min-w-[7.5rem] text-center text-xs font-semibold text-ink"
          >
            {monthTitle(month)}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={at < 0 || at >= block.months.length - 1}
            aria-label="Mes siguiente"
            className="grid h-7 w-7 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <section aria-label={`${block.title}, ${monthTitle(month)}`}>
        <div aria-hidden className="grid grid-cols-7 gap-1 pb-1.5">
          {WEEKDAYS.map((d) => (
            <span
              key={d}
              className="text-center text-micro font-semibold uppercase tracking-field text-ink-faint"
            >
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            const weekend = i % 7 >= 5;
            if (!day)
              // biome-ignore lint/suspicious/noArrayIndexKey: relleno fijo antes del día 1.
              return <span key={`pad-${i}`} aria-hidden className="min-h-10" />;
            const events = byDay.get(day) ?? [];
            const isToday = day === block.today;
            const isChosen = day === chosen;
            return (
              <div
                key={day}
                className={clsx(
                  'relative flex min-h-11 flex-col rounded-sm border p-1 transition-colors duration-150 md:min-h-[5.75rem] md:p-1.5',
                  isChosen
                    ? 'border-primary/60 bg-primary-soft/50 ring-1 ring-primary/30'
                    : weekend
                      ? 'border-border/50 bg-surface-2/60 hover:border-border-strong'
                      : 'border-border/60 bg-surface hover:border-border-strong',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelected(day)}
                  aria-pressed={isChosen}
                  aria-label={`${shortDay(day)}${events.length ? `, ${events.length} ${events.length === 1 ? 'evento' : 'eventos'}` : ''}`}
                  className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                />
                <span
                  className={clsx(
                    'tabular pointer-events-none relative grid h-6 min-w-6 place-items-center self-start rounded-pill px-1 font-mono text-micro',
                    isToday ? 'bg-primary font-semibold text-white' : 'text-ink-muted',
                  )}
                >
                  {Number(day.slice(8))}
                </span>
                {events.length > 0 && (
                  <>
                    <span className="pointer-events-none relative mt-auto flex justify-center gap-0.5 md:hidden">
                      {events.slice(0, 3).map((e) => (
                        <span
                          key={e.id}
                          className={clsx(
                            'h-1.5 w-1.5 rounded-pill',
                            e.tone ? TONE_BAR[e.tone] : 'bg-ink-faint',
                          )}
                        />
                      ))}
                    </span>
                    <ul className="relative mt-1 hidden space-y-0.5 md:block">
                      {events.slice(0, 2).map((e) => (
                        <li key={e.id}>
                          <EventButton event={e} open={open} compact />
                        </li>
                      ))}
                      {events.length > 2 && (
                        <li className="pointer-events-none px-1 text-micro text-ink-faint">
                          +{events.length - 2} más
                        </li>
                      )}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-4 border-t border-border pt-4" aria-live="polite">
        {chosen ? (
          <>
            <p className="mb-2.5 flex items-center justify-between text-xs font-bold text-ink">
              {shortDay(chosen)}
              {chosenEvents.length > 0 && (
                <span className="tabular rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-micro font-semibold text-ink-muted">
                  {chosenEvents.length}
                </span>
              )}
            </p>
            {chosenEvents.length ? (
              <ul className="space-y-1.5">
                {chosenEvents.map((e) => (
                  <li key={e.id}>
                    <EventButton event={e} open={open} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-micro text-ink-faint">Nada este día.</p>
            )}
          </>
        ) : (
          <p className="text-micro text-ink-faint">Elige un día para ver lo que tiene.</p>
        )}
      </div>
      <Legend legend={block.legend} />
      {block.hidden > 0 && (
        <p className="mt-2 text-micro text-ink-faint">
          {block.hidden} eventos más no caben en el calendario.
        </p>
      )}
    </Card>
  );
}

function Agenda({
  block,
  byDay,
  open,
}: {
  block: Calendar;
  byDay: Map<string, CalEvent[]>;
  open: ((id: string) => void) | null;
}) {
  const days = [...byDay.keys()].sort();
  if (!days.length)
    return (
      <EmptyState
        icon={<CalendarDays className="h-5 w-5" aria-hidden />}
        title="Nada en la agenda"
        hint={`Nada entre hoy y el ${shortDay(block.range.to)}.`}
      />
    );
  return (
    <ol className="space-y-4">
      {days.map((day) => (
        <li key={day} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3">
          <span
            className={clsx(
              'flex h-14 flex-col items-center justify-center rounded-sm border text-center',
              day === block.today
                ? 'border-primary/40 bg-primary-soft text-primary-ink'
                : 'border-border bg-surface-2/60 text-ink-muted',
            )}
          >
            <span className="text-micro font-semibold uppercase leading-none tracking-field">
              {day === block.today
                ? 'Hoy'
                : WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7]}
            </span>
            <span className="tabular mt-1 font-mono text-lg font-semibold leading-none text-ink">
              {Number(day.slice(8))}
            </span>
          </span>
          <ul className="space-y-1.5">
            {(byDay.get(day) ?? []).map((e) => (
              <li key={e.id}>
                <EventButton event={e} open={open} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function Legend({ legend }: { legend: Array<{ label: string; tone: Tone }> }) {
  if (!legend.length) return null;
  return (
    <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
      {legend.map((l) => (
        <li key={l.label} className="inline-flex items-center gap-1.5 text-micro text-ink-muted">
          <span className={clsx('h-2 w-2 rounded-pill', TONE_BAR[l.tone])} aria-hidden />
          {l.label}
        </li>
      ))}
    </ul>
  );
}
