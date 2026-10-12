'use client';

import { MetricChart } from '@/components/charts/MetricChart';
import { RankBars } from '@/components/charts/RankBars';
import { CHART_COLOR } from '@/components/charts/colors';
import type { MetricModel } from '@/components/charts/metric-types';
import { clsx } from 'clsx';
import { BarChart3 } from 'lucide-react';
import { type AppEditorData, CARD } from './shared';

/**
 * «USO» (0225): quién usa la app y dónde se queda, en los últimos 30 días.
 * Activos (7 y 30 días) y por rol, registros creados por día (con rangos y
 * zoom), pantallas más usadas y —sólo si se miden— tiempo mediano para
 * completar un formulario y formularios empezados que nunca se enviaron. Lo
 * que no se mide no se inventa: la tarjeta explica por qué falta.
 */

function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={clsx(CARD, 'min-w-0')}>
      <div className="text-xs font-semibold text-ink-muted">{label}</div>
      <div className="stat-display mt-1 truncate text-[2rem] leading-none text-ink">{value}</div>
      {hint && <div className="mt-1.5 text-micro text-ink-faint">{hint}</div>}
    </div>
  );
}

export function UsageTab({ data }: { data: AppEditorData }) {
  const u = data.usage;
  if (!u)
    return (
      <p className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-sm text-ink-muted">
        No se pudo leer el uso de esta app todavía.
      </p>
    );
  if (!u.hasData)
    return (
      <div className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-12 text-center text-sm text-ink-muted">
        <BarChart3 className="mx-auto mb-2 h-6 w-6 text-ink-faint" aria-hidden />
        Todavía no hay uso en los últimos 30 días. Aparecerá cuando alguien abra pantallas o envíe
        formularios.
      </div>
    );
  const today = u.created.daily.at(-1)?.date ?? u.generatedAt.slice(0, 10);
  const metric: MetricModel = {
    id: 'registros',
    label: 'Registros creados',
    fmt: 'count',
    currency: 'COP',
    unit: 'registros',
    kind: 'flow',
    tone: 'primary',
    goodWhenUp: true,
    daily: u.created.daily,
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Activos en 7 días"
          value={String(u.active.d7)}
          hint={`${u.active.d30} en 30 días`}
        />
        <Stat label="Registros en 30 días" value={u.created.total.toLocaleString('es-CO')} />
        <Stat
          label="Tiempo para completar un formulario"
          value={u.medianSeconds === null ? '—' : duration(u.medianSeconds)}
          hint={
            u.medianSeconds === null
              ? 'Aún no hay formularios medidos de principio a fin'
              : `Mediana de ${u.measured} formularios`
          }
        />
        <Stat
          label="Empezados y no enviados"
          value={u.dropoffs ? `${Math.round(u.dropoffs.rate * 100)} %` : '—'}
          hint={
            u.dropoffs
              ? `${u.dropoffs.abandoned} de ${u.dropoffs.started} empezados`
              : 'Se mide desde que alguien escribe en un formulario'
          }
        />
      </div>

      <section className={CARD} aria-label="Registros creados por día">
        <h3 className="mb-3 text-sm font-semibold text-ink-muted">Registros creados por día</h3>
        <MetricChart metric={metric} today={today} defaultRange="30d" height={220} />
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section className={CARD}>
          <h3 className="mb-3 text-sm font-semibold text-ink-muted">Pantallas más usadas</h3>
          {u.topScreens.length === 0 ? (
            <p className="text-sm text-ink-muted">Aún no se registran aperturas de pantalla.</p>
          ) : (
            <RankBars
              name="Pantallas más usadas"
              color={CHART_COLOR.primary}
              items={u.topScreens.map((s) => ({
                label: s.title,
                value: s.opens,
                display: `${s.opens.toLocaleString('es-CO')} · ${s.people} ${s.people === 1 ? 'persona' : 'personas'}`,
              }))}
            />
          )}
        </section>
        <section className={CARD}>
          <h3 className="mb-3 text-sm font-semibold text-ink-muted">Por rol</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-faint">
                <tr>
                  <th className="py-1.5 pr-2 font-semibold">Rol</th>
                  <th className="px-2 font-semibold">Activos 7 d</th>
                  <th className="px-2 font-semibold">30 d</th>
                  <th className="px-2 font-semibold">Registros</th>
                  <th className="pl-2 font-semibold">Aperturas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums text-ink">
                {u.byRole.map((r) => (
                  <tr key={r.roleKey}>
                    <td className="py-1.5 pr-2 font-semibold">{r.name}</td>
                    <td className="px-2">{r.active7}</td>
                    <td className="px-2">{r.active30}</td>
                    <td className="px-2">{r.submissions}</td>
                    <td className="pl-2">{r.opens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {u.dropoffs && u.dropoffs.byForm.length > 0 && (
        <section className={CARD}>
          <h3 className="mb-3 text-sm font-semibold text-ink-muted">Dónde se quedan sin enviar</h3>
          <RankBars
            name="Formularios abandonados"
            color={CHART_COLOR.amber}
            showShare={false}
            items={u.dropoffs.byForm.map((f) => ({
              label: f.title,
              value: f.abandoned,
              display: `${f.abandoned} de ${f.started}`,
            }))}
          />
        </section>
      )}
    </div>
  );
}
