'use client';

import { formatDay, formatMoney, probabilityText } from '@/lib/finance/dashboard-shape';
import { explainWeek } from '@cortex/agent-tools/src/ledger/forecast-explain';
import type { ForecastResult } from '@cortex/agent-tools/src/ledger/types';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ArrowDownLeft, ArrowUpRight, X } from 'lucide-react';
import { useMemo } from 'react';

/**
 * «¿POR QUÉ ESA SEMANA?»: la frase de la semana y, debajo, cada cobro y cada
 * pago que la mueve, del que más pesa al que menos, con su razón y con cuánto
 * se cuenta (un cobro de un cliente que suele pagar tarde no se cuenta
 * completo). Si hay un escenario abierto, explica la semana del escenario y
 * dice con cuánto cerraría sin él.
 */
export function WeekDrawer({
  result,
  base,
  week,
  onClose,
}: {
  /** Lo que se está mirando: el escenario si hay uno, si no la base. */
  result: ForecastResult;
  /** La base, para comparar cuando `result` es un escenario. */
  base: ForecastResult | null;
  week: string | null;
  onClose: () => void;
}) {
  const explanation = useMemo(() => (week ? explainWeek(result, week) : null), [result, week]);
  const baseWeek = week && base ? base.weeks.find((w) => w.start === week) : null;
  const fm = (n: number) => formatMoney(n, result.currency);
  return (
    <Dialog.Root open={Boolean(week)} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={clsx(
            'fixed z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-pop outline-none animate-veil',
            'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-card',
            'sm:inset-x-auto sm:inset-y-3 sm:right-3 sm:max-h-none sm:w-[min(28rem,calc(100vw-1.5rem))] sm:rounded-card',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold text-ink">
                {week ? `Semana del ${formatDay(week)}` : 'Semana'}
              </Dialog.Title>
              <Dialog.Description className="text-micro text-ink-faint">
                {result.scenario
                  ? `Con el escenario «${result.scenario.label}»`
                  : 'Proyección base'}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {explanation && (
              <>
                <p className="text-sm leading-relaxed text-ink">{explanation.summary}</p>
                {explanation.week && (
                  <dl className="mt-4 grid grid-cols-3 gap-2">
                    <Stat label="Entra" value={fm(explanation.week.inflows)} tone="in" />
                    <Stat label="Sale" value={fm(explanation.week.outflows)} />
                    <Stat
                      label="Cierra"
                      value={fm(explanation.week.closing)}
                      tone={explanation.week.closing < 0 ? 'neg' : undefined}
                    />
                  </dl>
                )}
                {result.scenario && baseWeek && (
                  <p className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
                    Sin el escenario cerraría con{' '}
                    <span className="tabular font-mono font-semibold">{fm(baseWeek.closing)}</span>.
                  </p>
                )}
                {explanation.items.length > 0 && (
                  <>
                    <h3 className="mt-5 text-xs font-semibold text-ink-muted">
                      Lo que mueve la semana, de lo que más pesa a lo que menos
                    </h3>
                    <ol className="mt-2 divide-y divide-border/70">
                      {explanation.items.map((item, i) => (
                        <li
                          key={`${item.movementId ?? item.recurringId ?? item.label}-${i}`}
                          className="py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2">
                              <span
                                className={clsx(
                                  'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-pill',
                                  item.direction === 'in'
                                    ? 'bg-emerald-soft text-emerald'
                                    : 'bg-surface-2 text-ink-muted',
                                )}
                                aria-hidden
                              >
                                {item.direction === 'in' ? (
                                  <ArrowDownLeft className="h-3.5 w-3.5" />
                                ) : (
                                  <ArrowUpRight className="h-3.5 w-3.5" />
                                )}
                              </span>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-ink">
                                  <span className="sr-only">
                                    {item.direction === 'in' ? 'Entra: ' : 'Sale: '}
                                  </span>
                                  {item.label}
                                </p>
                                <p className="mt-0.5 text-xs text-ink-muted">{item.reason}</p>
                                <p className="mt-1 text-micro text-ink-faint">
                                  {formatDay(item.expectedDate)} ·{' '}
                                  {probabilityText(item.probability)}
                                  {item.probability < 0.995 && (
                                    <>
                                      {' '}
                                      de{' '}
                                      <span className="tabular font-mono">{fm(item.amount)}</span>
                                    </>
                                  )}
                                </p>
                              </div>
                            </div>
                            <span
                              className={clsx(
                                'tabular shrink-0 font-mono text-sm font-semibold',
                                item.direction === 'in' ? 'text-emerald' : 'text-ink',
                              )}
                            >
                              {item.direction === 'in' ? '+' : '−'}
                              {fm(item.expectedAmount)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'in' | 'neg' }) {
  return (
    <div className="rounded-sm bg-surface-2 px-3 py-2">
      <dt className="text-micro text-ink-faint">{label}</dt>
      <dd
        className={clsx(
          'tabular mt-0.5 font-mono text-sm font-semibold',
          tone === 'in' ? 'text-emerald' : tone === 'neg' ? 'text-rose' : 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
