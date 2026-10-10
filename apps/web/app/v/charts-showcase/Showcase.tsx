'use client';

import { AreaChart } from '@/components/charts/AreaChart';
import { BarChart } from '@/components/charts/BarChart';
import { ChartEmpty } from '@/components/charts/ChartEmpty';
import { DeltaPill } from '@/components/charts/DeltaPill';
import { ProgressRing } from '@/components/charts/ProgressRing';
import { RankBars } from '@/components/charts/RankBars';
import { SegmentBar } from '@/components/charts/SegmentBar';
import { Sparkline } from '@/components/charts/Sparkline';
import { CHART_COLOR, STATUS_TONE } from '@/components/charts/colors';
import { deltaRatio, formatCompact } from '@/components/charts/scales';
import { CashFlowChart } from '@/components/finance/CashFlowChart';
import { applyTheme } from '@/components/nav/ThemeToggle';
import { Panel } from '@/components/ui/panel';
import type { ChartWeek } from '@/lib/finance/dashboard-shape';
import { type ReactNode, useEffect, useState } from 'react';

const money = (n: number) => formatCompact(n, { money: true });

// ---- Datos inventados -------------------------------------------------------

const DAYS = Array.from({ length: 14 }, (_, i) => `${i + 1} oct`);
const SALES = [
  31.2, 28.4, 35.1, 39.8, 42.5, 38.1, 21.3, 24.6, 33.9, 41.2, 45.8, 47.3, 44.1, 48.2,
].map((v) => v * 1_000_000);
const SALES_PREV = [
  27.1, 29.9, 30.2, 33.4, 36.8, 35.5, 19.9, 22.2, 28.8, 34.6, 37.3, 40.1, 41.7, 42.9,
].map((v) => v * 1_000_000);

const FC_LABELS = [
  '2 sep',
  '9 sep',
  '16 sep',
  '23 sep',
  '30 sep',
  '7 oct',
  '14 oct',
  '21 oct',
  '28 oct',
  '4 nov',
  '11 nov',
  '18 nov',
];
const FC_VALUES = [92, 88, 95, 81, 74, 69, 63, 58, 51, 44, 36, 29].map((v) => v * 1_000_000);
const FC_BAND = {
  lo: FC_VALUES.map((v, i) => (i >= 6 ? v - (i - 5) * 4_200_000 : v)),
  hi: FC_VALUES.map((v, i) => (i >= 6 ? v + (i - 5) * 4_200_000 : v)),
  label: 'Rango probable',
};

const DELIVERY_WEEKS = ['S36', 'S37', 'S38', 'S39', 'S40', 'S41', 'S42', 'S43'];

const WEEKS: ChartWeek[] = Array.from({ length: 13 }, (_, i) => {
  const inflows = [58, 64, 41, 72, 55, 49, 83, 61, 47, 66, 52, 70, 44][i] ?? 0;
  const outflows = [49, 71, 63, 58, 77, 52, 60, 69, 74, 55, 62, 58, 71][i] ?? 0;
  const closing = [96, 89, 67, 81, 59, 56, 79, 71, 44, 55, 45, 57, 30][i] ?? 0;
  const day = new Date(Date.UTC(2026, 9, 5 + i * 7));
  return {
    start: day.toISOString().slice(0, 10),
    label: `${day.getUTCDate()} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][day.getUTCMonth()]}`,
    inflows: inflows * 1_000_000,
    outflows: outflows * 1_000_000,
    closing: closing * 1_000_000,
    scenarioClosing: i >= 3 ? (closing - (i - 2) * 2.5) * 1_000_000 : null,
    lowest: i === 12,
    scenarioLowest: i === 12,
    belowMinimum: closing * 1_000_000 < 50_000_000,
  };
});

// ---- Página -------------------------------------------------------------------

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Panel className="p-5">
      <h2 className="text-sm font-bold text-ink">{title}</h2>
      {note && <p className="mb-3 mt-0.5 text-xs text-ink-muted">{note}</p>}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </Panel>
  );
}

function Kpi({
  title,
  value,
  values,
  tone,
  prev,
  goodWhenUp = true,
}: {
  title: string;
  value: string;
  values: number[];
  tone: 'primary' | 'emerald' | 'rose' | 'sky';
  prev?: number;
  goodWhenUp?: boolean;
}) {
  const ratio = prev !== undefined ? deltaRatio(values[values.length - 1] ?? 0, prev) : null;
  return (
    <Panel className="p-4">
      <p className="text-xs font-semibold text-ink-muted">{title}</p>
      <p className="tabular mt-2 tabular-nums text-2xl font-semibold text-ink">{value}</p>
      {prev !== undefined && (
        <div className="mt-2">
          <DeltaPill
            ratio={ratio}
            good={ratio === null ? null : ratio >= 0 === goodWhenUp}
            label="vs. mes pasado"
          />
        </div>
      )}
      <Sparkline
        className="mt-3"
        values={values}
        color={CHART_COLOR[tone]}
        name={title}
        labels={values.map((_, i) => `Sem ${i + 1}`)}
        showLabels
      />
    </Panel>
  );
}

export function ChartsShowcase({ dark: initial }: { dark: boolean }) {
  const [dark, setDark] = useState(initial);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    applyTheme(dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-extrabold text-ink">Kit de gráficos</h1>
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className="rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted"
          >
            Tema: {dark ? 'oscuro' : 'claro'}
          </button>
        </div>

        <section
          aria-label="Tarjetas de cifra"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Kpi
            title="Ventas del mes"
            value="$ 48,2 M"
            values={[31, 28, 35, 40, 42, 38, 45, 48]}
            tone="primary"
            prev={38}
          />
          <Kpi
            title="Devoluciones"
            value="$ 3,1 M"
            values={[2, 2.4, 2.1, 2.8, 3.4, 3.0, 3.3, 3.1]}
            tone="rose"
            prev={2.6}
            goodWhenUp={false}
          />
          <Kpi title="Clientes nuevos" value="0" values={[0, 0, 0, 0]} tone="emerald" />
          <Kpi title="Cotizaciones" value="12" values={[12]} tone="sky" />
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <Block
            title="Área con comparación"
            note="Ventas diarias y la semana pasada, punteada y apagada. Pasa el puntero o usa las flechas."
          >
            <AreaChart
              labels={DAYS}
              lines={[
                {
                  id: 'cur',
                  label: 'Esta semana',
                  color: CHART_COLOR.primary,
                  area: true,
                  values: SALES,
                },
                {
                  id: 'prev',
                  label: 'Semana pasada',
                  color: CHART_COLOR.ink,
                  comparison: true,
                  dashed: true,
                  values: SALES_PREV,
                },
              ]}
              nowIndex={13}
              formatAxis={money}
              formatValue={(n) => `$ ${formatCompact(n)}`}
              height={260}
            />
          </Block>

          <Block
            title="Caja con proyección, rango y mínima"
            note="Lo real en sólido, lo proyectado punteado con su rango probable; la caja mínima con su franja; eventos con fichas."
          >
            <AreaChart
              labels={FC_LABELS}
              lines={[
                {
                  id: 'cash',
                  label: 'Caja',
                  color: CHART_COLOR.primary,
                  area: true,
                  values: FC_VALUES,
                  projectedFrom: 5,
                  band: FC_BAND,
                },
              ]}
              threshold={{ value: 40_000_000, label: 'Caja mínima' }}
              markers={[
                { index: 4, label: 'Pago de nómina', color: CHART_COLOR.amber },
                { index: 9, label: 'IVA bimestral', color: CHART_COLOR.sky },
              ]}
              nowIndex={5}
              formatAxis={money}
              formatValue={money}
              height={280}
            />
          </Block>

          <Block
            title="Barras apiladas por estado"
            note="Entregas por semana. Color por significado: verde hecho, ámbar atrasado, rosa en riesgo, índigo planeado."
          >
            <BarChart
              labels={DELIVERY_WEEKS}
              bars={[
                {
                  id: 'done',
                  label: 'Hecho',
                  color: CHART_COLOR[STATUS_TONE.done],
                  values: [14, 16, 12, 18, 15, 9, 0, 0],
                },
                {
                  id: 'delayed',
                  label: 'Atrasado',
                  color: CHART_COLOR[STATUS_TONE.delayed],
                  values: [2, 1, 3, 2, 4, 3, 1, 0],
                },
                {
                  id: 'risk',
                  label: 'En riesgo',
                  color: CHART_COLOR[STATUS_TONE.risk],
                  values: [0, 1, 0, 1, 2, 4, 2, 1],
                },
                {
                  id: 'planned',
                  label: 'Planeado',
                  color: CHART_COLOR[STATUS_TONE.planned],
                  values: [0, 0, 0, 0, 0, 6, 15, 17],
                },
              ]}
              nowIndex={5}
              height={260}
            />
          </Block>

          <Block
            title="Barras agrupadas con negativos"
            note="Ventas y utilidad neta; la utilidad bajo cero va en rosa y hacia abajo."
          >
            <BarChart
              barMode="grouped"
              labels={['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep']}
              bars={[
                {
                  id: 's',
                  label: 'Ventas',
                  color: CHART_COLOR.emerald,
                  values: [42, 38, 51, 47, 55, 49, 58, 61, 64].map((v) => v * 1e6),
                },
                {
                  id: 'n',
                  label: 'Utilidad neta',
                  color: CHART_COLOR.primary,
                  negativeColor: CHART_COLOR.rose,
                  values: [6, -3, 9, 4, 11, -2, 12, 14, 15].map((v) => v * 1e6),
                },
              ]}
              formatAxis={money}
              formatValue={money}
              height={260}
            />
          </Block>

          <Block
            title="Flujo de caja (13 semanas)"
            note="El componente real de Finanzas: entra/sale, caja al cierre, escenario, mínima y la semana más baja. Toca una semana."
          >
            <CashFlowChart
              weeks={WEEKS}
              currency="COP"
              minimumCash={50_000_000}
              scenarioLabel="Sin el contrato nuevo"
              selected={picked}
              onSelect={setPicked}
            />
          </Block>

          <div className="space-y-5">
            <Block
              title="Antigüedad de cartera"
              note="Una barra segmentada con 2 px entre tramos y la leyenda con montos."
            >
              <SegmentBar
                total="$ 184,6 M"
                totalLabel="Por cobrar"
                items={[
                  {
                    key: 'c',
                    label: 'Al día',
                    value: 96.2,
                    display: '$ 96,2 M',
                    color: CHART_COLOR.emerald,
                  },
                  {
                    key: '1',
                    label: '1–30 días',
                    value: 41.5,
                    display: '$ 41,5 M',
                    color: CHART_COLOR.sky,
                  },
                  {
                    key: '2',
                    label: '31–60 días',
                    value: 27.3,
                    display: '$ 27,3 M',
                    color: CHART_COLOR.amber,
                  },
                  {
                    key: '3',
                    label: '61–90 días',
                    value: 14.8,
                    display: '$ 14,8 M',
                    color: CHART_COLOR.rose,
                  },
                  {
                    key: '4',
                    label: 'Más de 90',
                    value: 4.8,
                    display: '$ 4,8 M',
                    color: 'rgb(var(--ink-muted))',
                  },
                ]}
              />
            </Block>
            <Block title="Ranking horizontal">
              <RankBars
                name="Ventas por cliente"
                color={CHART_COLOR.primary}
                items={[
                  { label: 'Almacenes Éxito S.A.', value: 64, display: '$ 64,0 M' },
                  { label: 'Servientrega S.A.', value: 41, display: '$ 41,0 M' },
                  { label: 'Frigoandes Ltda.', value: 23, display: '$ 23,0 M' },
                  { label: 'Distribuciones El Paisa', value: 9, display: '$ 9,0 M' },
                ]}
              />
            </Block>
            <Block title="Anillo de avance">
              <div className="flex items-center gap-4">
                <ProgressRing percent={42} />
                <ProgressRing percent={100} />
                <ProgressRing percent={0} />
              </div>
            </Block>
          </div>
        </div>

        <h2 className="pt-2 text-sm font-bold text-ink">Estados vacíos (que no se vean rotos)</h2>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          <Block title="Sin datos">
            <AreaChart
              labels={[]}
              lines={[{ id: 'a', label: 'Ventas', color: CHART_COLOR.primary, values: [] }]}
              height={160}
            />
          </Block>
          <Block title="Un solo punto">
            <AreaChart
              labels={['1 oct']}
              lines={[
                {
                  id: 'a',
                  label: 'Ventas',
                  color: CHART_COLOR.primary,
                  area: true,
                  values: [12_000_000],
                },
              ]}
              formatAxis={money}
              formatValue={money}
              height={160}
            />
          </Block>
          <Block title="Todo en cero">
            <AreaChart
              labels={['L', 'M', 'X', 'J', 'V']}
              lines={[
                {
                  id: 'a',
                  label: 'Ventas',
                  color: CHART_COLOR.primary,
                  area: true,
                  values: [0, 0, 0, 0, 0],
                },
              ]}
              height={160}
            />
          </Block>
          <Block title="Barras en cero">
            <BarChart
              labels={['S1', 'S2', 'S3', 'S4']}
              bars={[
                { id: 'a', label: 'Cerrados', color: CHART_COLOR.emerald, values: [0, 0, 0, 0] },
              ]}
              emptyNote="Nada cerrado en estas semanas"
              height={160}
            />
          </Block>
          <Block title="Barra segmentada vacía">
            <SegmentBar
              items={[
                { key: 'a', label: 'Al día', value: 0, display: '$ 0', color: CHART_COLOR.emerald },
              ]}
            />
          </Block>
          <Block title="Línea plana (cifra constante)">
            <Sparkline
              values={[5, 5, 5, 5, 5]}
              color={CHART_COLOR.sky}
              name="Constante"
              showLabels
            />
          </Block>
          <Block title="Aviso suelto">
            <ChartEmpty height={110} />
          </Block>
        </div>
      </main>
    </div>
  );
}
