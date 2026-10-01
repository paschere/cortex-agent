'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRecordOpener } from './RecordDrawer';
import { Card, TONE_BAR, TONE_SOFT, shortDay, upperFirst } from './theme';

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
    'flex w-full min-w-0 items-center gap-1.5 rounded-pill text-left transition-colors duration-150',
    compact ? 'px-1.5 py-px text-micro' : 'px-2.5 py-1.5 text-sm',
    event.tone ? TONE_SOFT[event.tone] : 'bg-surface-2 text-ink',
    open && 'hover:brightness-95 focus-visible:ring-2 focus-visible:ring-primary/40',
  );
  const body = (
    <>
      {!compact && event.tag && (
        <span className="shrink-0 text-micro font-semibold opacity-80">{event.tag}</span>
      )}
      <span className="truncate font-medium">{event.label}</span>
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
        <div aria-hidden className="grid grid-cols-7 gap-1 pb-1">
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
                  'relative flex min-h-10 flex-col rounded-sm border p-1 transition-colors duration-150 md:min-h-[5.5rem]',
                  isChosen
                    ? 'border-primary/50 bg-primary-soft/40'
                    : 'border-border/70 bg-surface-2/40',
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
                    'tabular pointer-events-none relative self-start rounded-pill px-1 font-mono text-micro',
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

      <div className="mt-3 border-t border-border pt-3" aria-live="polite">
        {chosen ? (
          <>
            <p className="mb-2 text-xs font-semibold text-ink">{shortDay(chosen)}</p>
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
      <p className="py-6 text-center text-sm text-ink-faint">
        Nada entre hoy y el {shortDay(block.range.to)}.
      </p>
    );
  return (
    <ol className="space-y-3">
      {days.map((day) => (
        <li key={day} className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-2 sm:gap-3">
          <span
            className={clsx(
              'pt-1.5 text-xs font-semibold',
              day === block.today ? 'text-primary' : 'text-ink-muted',
            )}
          >
            {day === block.today ? 'Hoy' : shortDay(day)}
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
    <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
      {legend.map((l) => (
        <li key={l.label} className="inline-flex items-center gap-1.5 text-micro text-ink-muted">
          <span className={clsx('h-2 w-2 rounded-pill', TONE_BAR[l.tone])} aria-hidden />
          {l.label}
        </li>
      ))}
    </ul>
  );
}
