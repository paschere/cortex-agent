'use client';

import { MetricChart } from '@/components/charts/MetricChart';
import { RankBars } from '@/components/charts/RankBars';
import { CHART_COLOR } from '@/components/charts/colors';
import type { MetricModel } from '@/components/charts/metric-types';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { CircleDollarSign, Loader2, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';

/**
 * COSTO DE CORTEX EN /admin/usage (0228): lo que gasta el modelo, en pesos, por
 * día (con rangos, zoom y comparación contra el período anterior), por persona
 * y por superficie, y las diez conversaciones más caras. Todo llega calculado
 * (lib/usage-cost.ts); aquí sólo se pinta. La tasa USD→COP es de la empresa y
 * la cambia quien administra.
 */

export interface UsageCostData {
  rate: number;
  customRate: boolean;
  /** Ventana de las listas, en días. */
  days: number;
  today: string;
  totals: { cop: number; tokens: number; turns: number; unpriced: number; conversations: number };
  /** Pesos por día (más días que la ventana, para el rango y la comparación). */
  daily: Array<{ date: string; value: number }>;
  perUser: Array<{ label: string; cop: number; tokens: number; turns: number }>;
  perSurface: Array<{ label: string; cop: number; tokens: number; turns: number }>;
  topConversations: Array<{
    id: string;
    title: string;
    person: string;
    cop: number;
    tokens: number;
    turns: number;
    href: string | null;
  }>;
  topTasks: Array<{ id: string; title: string; cop: number; tokens: number; href: string | null }>;
  truncated: boolean;
  canEditRate: boolean;
}

const pesos = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const count = (n: number) => Math.round(n).toLocaleString('es-CO');

function RateForm({
  rate,
  custom,
  onSave,
}: {
  rate: number;
  custom: boolean;
  onSave: (rate: string) => Promise<{ ok: boolean; note: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(rate));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2 text-micro text-ink-muted">
      <span className="tabular font-mono">
        1 USD = {pesos(rate)}
        {custom ? '' : ' (por defecto)'}
      </span>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-pill bg-surface-2 px-2.5 py-1 font-semibold text-ink transition-colors hover:bg-border"
        >
          Cambiar tasa
        </button>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await onSave(value);
              setNote({ ok: r.ok, text: r.note });
              if (r.ok) setOpen(false);
            });
          }}
        >
          <input
            aria-label="Pesos por dólar"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="tabular h-7 w-24 rounded-sm border border-border-strong bg-surface px-2 font-mono text-xs text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-7 items-center gap-1 rounded-pill bg-primary px-3 text-xs font-semibold text-white disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            Guardar
          </button>
        </form>
      )}
      {note && <output className={note.ok ? 'text-emerald' : 'text-rose'}>{note.text}</output>}
    </div>
  );
}

export function UsageCostSection({
  data,
  saveRate,
}: {
  data: UsageCostData;
  saveRate?: (rate: string) => Promise<{ ok: boolean; note: string }>;
}) {
  const metric: MetricModel = {
    id: 'costo-cortex',
    label: 'Costo de Cortex',
    hint: 'Lo que gasta el modelo por día, en pesos',
    fmt: 'money',
    currency: 'COP',
    kind: 'flow',
    tone: 'primary',
    goodWhenUp: false,
    daily: data.daily,
  };
  const empty = data.totals.turns === 0;
  const avg = data.totals.conversations > 0 ? data.totals.cop / data.totals.conversations : 0;
  const tiles = [
    { label: `Costo · últimos ${data.days} días`, value: pesos(data.totals.cop), strong: true },
    { label: 'Tokens', value: count(data.totals.tokens) },
    { label: 'Turnos y tandas', value: count(data.totals.turns) },
    { label: 'Por conversación (promedio)', value: pesos(avg) },
  ];
  return (
    <Panel className="p-4" aria-label="Costo de Cortex en pesos">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CircleDollarSign className="h-3.5 w-3.5 text-emerald" aria-hidden />
          <span className="field-label">Costo de Cortex · en pesos</span>
        </div>
        {data.canEditRate && saveRate ? (
          <RateForm rate={data.rate} custom={data.customRate} onSave={saveRate} />
        ) : (
          <span className="tabular font-mono text-micro text-ink-muted">
            1 USD = {pesos(data.rate)}
          </span>
        )}
      </div>

      {empty ? (
        <div className="flex h-20 items-center justify-center rounded-sm border border-border bg-surface-2 px-4 text-center text-xs text-ink-muted">
          Todavía no hay consumo registrado en esta ventana. Se anota desde la próxima respuesta de
          Cortex.
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((s) => (
              <div key={s.label} className="rounded-sm border border-border bg-surface-2 p-3">
                <div
                  className={clsx(
                    'stat-num tabular truncate text-lg leading-tight',
                    s.strong ? 'text-emerald' : 'text-ink',
                  )}
                  title={s.value}
                >
                  {s.value}
                </div>
                <div className="field-label mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          <MetricChart
            metric={metric}
            today={data.today}
            defaultRange={data.days <= 7 ? '7d' : '30d'}
            height={230}
          />

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div>
              <div className="field-label mb-3">Por persona</div>
              <RankBars
                name="Costo por persona"
                color={CHART_COLOR.primary}
                items={data.perUser.slice(0, 8).map((u) => ({
                  label: u.label,
                  value: u.cop,
                  display: `${pesos(u.cop)} · ${count(u.tokens)} tokens`,
                }))}
              />
            </div>
            <div>
              <div className="field-label mb-3">Por superficie</div>
              <RankBars
                name="Costo por superficie"
                color={CHART_COLOR.sky}
                items={data.perSurface.map((u) => ({
                  label: u.label,
                  value: u.cop,
                  display: `${pesos(u.cop)} · ${count(u.turns)} ${u.turns === 1 ? 'turno' : 'turnos'}`,
                }))}
              />
            </div>
          </div>

          <div className="mt-5">
            <div className="field-label mb-2">Las 10 conversaciones más caras</div>
            {data.topConversations.length === 0 ? (
              <p className="text-xs text-ink-muted">Ninguna conversación con consumo registrado.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead className="text-micro text-ink-faint">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Conversación</th>
                      <th className="py-1.5 pr-3 font-medium">Persona</th>
                      <th className="tabular py-1.5 pr-3 text-right font-medium">Turnos</th>
                      <th className="tabular py-1.5 pr-3 text-right font-medium">Tokens</th>
                      <th className="tabular py-1.5 text-right font-medium">Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topConversations.map((c, i) => (
                      <tr key={c.id} className="border-t border-border">
                        <td className="max-w-[320px] py-2 pr-3">
                          <span className="tabular mr-2 text-ink-faint">{i + 1}</span>
                          {c.href ? (
                            <Link
                              href={c.href}
                              className="inline-flex items-center gap-1 font-medium text-ink hover:text-primary"
                            >
                              <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
                              <span className="truncate">{c.title}</span>
                            </Link>
                          ) : (
                            <span className="font-medium text-ink">{c.title}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted">{c.person}</td>
                        <td className="tabular py-2 pr-3 text-right font-mono">{count(c.turns)}</td>
                        <td className="tabular py-2 pr-3 text-right font-mono">
                          {count(c.tokens)}
                        </td>
                        <td className="tabular py-2 text-right font-mono font-semibold text-ink">
                          {pesos(c.cop)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.topTasks.length > 0 && (
            <div className="mt-5">
              <div className="field-label mb-2">Tareas en segundo plano más caras</div>
              <ul className="divide-y divide-border text-xs">
                {data.topTasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-1.5">
                    {t.href ? (
                      <Link
                        href={t.href}
                        className="min-w-0 truncate font-medium hover:text-primary"
                      >
                        {t.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate font-medium">{t.title}</span>
                    )}
                    <span className="tabular shrink-0 font-mono text-ink-muted">
                      {pesos(t.cop)} · {count(t.tokens)} tokens
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <p className="mt-4 text-micro leading-relaxed text-ink-faint">
        Estimado con el precio de lista del modelo de cada turno (entrada, salida y caché por
        separado) y la tasa de arriba.{' '}
        {data.totals.unpriced > 0 &&
          `${count(data.totals.unpriced)} turnos son de un modelo sin tarifa conocida: cuentan sus tokens pero no su precio. `}
        {data.truncated &&
          'La ventana trae más consumo del que se lee de una vez: las cifras son un piso. '}
        La factura real de Anthropic puede diferir por descuentos.
      </p>
    </Panel>
  );
}
