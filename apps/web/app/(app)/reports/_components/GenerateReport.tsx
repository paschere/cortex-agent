'use client';

import { Button } from '@/components/ui/button';
import {
  REPORT_KINDS,
  REPORT_KIND_ICON,
  REPORT_KIND_LABEL,
  REPORT_KIND_PITCH,
  type ReportKind,
} from '@/lib/reports-shape';
import { clsx } from 'clsx';
import { Building2, CalendarClock, Loader2, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { generateReportAction } from '../actions';

/**
 * The three questions this company asks every month, as three cards.
 *
 * This is the hero of the screen and it is deliberately not a headline: the
 * most characteristic thing about a reporting surface for a postal and customs
 * operator is WHICH THREE reports exist. Showing them as the first thing says
 * more about the product than any sentence would, and it doubles as the empty
 * state — a screen with no saved reports is already an invitation to act.
 *
 * Nothing here imports `@cortex/agent-tools`: the vocabulary comes from
 * `lib/reports-shape.ts`, because the barrel drags `node:dns` into a client
 * bundle and breaks the production build without failing typecheck or tests.
 */

const ICONS: Record<string, typeof CalendarClock> = {
  CalendarClock,
  Truck,
  Building2,
};

/**
 * Windows people actually ask for out loud. A free number field would be more
 * flexible and would also make somebody decide, every time, what "this month"
 * means — the whole value of a preset is that two people generating the same
 * report get the same report.
 */
const HORIZON: Array<{ value: number; label: string }> = [
  { value: 30, label: 'este mes' },
  { value: 60, label: '60 días' },
  { value: 90, label: 'el trimestre' },
];

const MONTHS: Array<{ value: number; label: string }> = [
  { value: 3, label: '3 meses' },
  { value: 6, label: '6 meses' },
  { value: 12, label: 'un año' },
];

const TONE: Record<ReportKind, { chip: string; icon: string }> = {
  expiries: { chip: 'bg-amber-soft', icon: 'text-amber' },
  fleet: { chip: 'bg-emerald-soft', icon: 'text-emerald' },
  client_activity: { chip: 'bg-primary-soft', icon: 'text-primary' },
};

export function GenerateReport() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyKind, setBusyKind] = useState<ReportKind | null>(null);
  const [span, setSpan] = useState<Record<ReportKind, number>>({
    expiries: 30,
    fleet: 90,
    client_activity: 6,
  });
  const [error, setError] = useState<string | null>(null);

  const run = (kind: ReportKind) => {
    setError(null);
    setBusyKind(kind);
    startTransition(async () => {
      const result = await generateReportAction({
        kind,
        horizonDays: kind === 'client_activity' ? undefined : span[kind],
        months: kind === 'client_activity' ? span[kind] : undefined,
      });
      setBusyKind(null);
      if (!result.ok || !result.reportId) {
        setError(result.error ?? 'No se pudo generar el informe.');
        return;
      }
      router.push(`/reports/${result.reportId}`);
    });
  };

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORT_KINDS.map((kind) => {
          const Icon = ICONS[REPORT_KIND_ICON[kind]] ?? CalendarClock;
          const tone = TONE[kind];
          const options = kind === 'client_activity' ? MONTHS : HORIZON;
          const busy = pending && busyKind === kind;
          return (
            <div
              key={kind}
              className="flex flex-col rounded-card border border-border bg-surface p-5 shadow-card"
            >
              <div className="flex items-start gap-3">
                <span
                  className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-sm', tone.chip, tone.icon)}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold leading-tight text-ink">
                    {REPORT_KIND_LABEL[kind]}
                  </h3>
                  <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
                    {REPORT_KIND_PITCH[kind]}
                  </p>
                </div>
              </div>

              <fieldset className="mt-4">
                <legend className="field-label mb-2">
                  {kind === 'client_activity' ? 'Historia' : 'Ventana'}
                </legend>
                <div className="flex flex-wrap gap-1.5" role="radiogroup">
                  {options.map((o) => {
                    const active = span[kind] === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setSpan((s) => ({ ...s, [kind]: o.value }))}
                        className={clsx(
                          'rounded-pill px-3 py-1 text-[12px] font-medium transition-colors duration-150',
                          active
                            ? 'bg-ink text-white'
                            : 'border border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-auto pt-4">
                <Button
                  type="button"
                  onClick={() => run(kind)}
                  disabled={pending}
                  className="w-full"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Generando…
                    </>
                  ) : (
                    'Generar'
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-rose/20 bg-rose-soft px-4 py-2.5 text-[12.5px] text-rose"
        >
          {error}
        </p>
      )}
    </div>
  );
}
