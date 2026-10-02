'use client';

import { addDaysIso, awayRanges, daysInRange, rangeLabel, shortDay } from '@/lib/team/shape';
import { clsx } from 'clsx';
import { CalendarOff, Loader2, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { TeamActions } from './types';

const field =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';

/**
 * Días fuera (vacaciones, incapacidad): no cuentan en contra. Cada persona
 * anota los suyos; los de otra persona, quien administra. El servidor aplica
 * la misma regla (`workPersonChangeRefusal`).
 */
export function AwayDaysEditor({
  personId,
  firstName,
  self,
  initial,
  today,
  saveAway,
}: {
  personId: string;
  firstName: string;
  self: boolean;
  initial: string[];
  today: string;
  saveAway: TeamActions['saveAway'];
}) {
  const [days, setDays] = useState<string[]>(initial);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const recent = days.filter((d) => d >= addDaysIso(today, -30));
  const ranges = awayRanges(recent);

  const run = (add: string[], remove: string[]) =>
    start(async () => {
      const r = await saveAway({ personId, add, remove });
      if (r.ok) {
        setDays((prev) => {
          const next = new Set(prev);
          for (const d of add) next.add(d);
          for (const d of remove) next.delete(d);
          return [...next].sort();
        });
        setNote({ ok: true, text: r.note });
      } else setNote({ ok: false, text: r.error });
    });

  return (
    <div className="space-y-4">
      {ranges.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {self ? 'No tienes días fuera anotados.' : `${firstName} no tiene días fuera anotados.`}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {ranges.map((r) => (
            <li
              key={r.from}
              className="inline-flex items-center gap-1.5 rounded-pill border border-sky/20 bg-sky-soft py-1 pl-3 pr-1 text-xs font-semibold text-sky"
            >
              <CalendarOff className="h-3.5 w-3.5" aria-hidden />
              <span className="tabular">{r.from === r.to ? shortDay(r.from) : rangeLabel(r)}</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => run([], daysInRange(r.from, r.to))}
                className="rounded-pill p-1 hover:bg-surface"
                aria-label={`Quitar ${r.from === r.to ? shortDay(r.from) : rangeLabel(r)}`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const add = daysInRange(from, to || from);
          if (!add.length) {
            setNote({
              ok: false,
              text: 'Revisa las fechas: «hasta» no puede ser antes de «desde».',
            });
            return;
          }
          run(add, []);
        }}
      >
        <label className="block">
          <span className="field-label">Desde</span>
          <input
            type="date"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={clsx(field, 'mt-1')}
          />
        </label>
        <label className="block">
          <span className="field-label">Hasta (opcional)</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className={clsx(field, 'mt-1')}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Anotar días fuera
        </button>
      </form>
      <output
        aria-live="polite"
        className={clsx(
          'block text-xs',
          !note && 'sr-only',
          note?.ok ? 'text-emerald' : 'text-rose',
        )}
      >
        {note?.text ?? ''}
      </output>
    </div>
  );
}
