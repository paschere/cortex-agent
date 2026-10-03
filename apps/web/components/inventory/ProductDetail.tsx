'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import type { ActionResult, ProductDetailView } from '@/lib/inventory/shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ArrowLeft, BarChart3, History, Package, Settings2, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FIELD, Feedback, NUMBER_FIELD, TONE_TEXT, Tiles, readNumber } from './parts';

/**
 * La ficha de un producto: existencias y costo, consumo de las últimas 13
 * semanas, existencias por bodega, el libro de movimientos y lo que se puede
 * hacer a mano (entrada, salida, conteo) y ajustar (mínimo, cantidad a pedir,
 * días de entrega, precio).
 */

export interface ProductDetailHandlers {
  move: (input: {
    productId: string;
    kind: 'entrada' | 'salida' | 'ajuste';
    qty: number;
    unitCost?: number | null;
    locationId?: string | null;
    note?: string | null;
  }) => Promise<ActionResult>;
  saveSettings: (id: string, values: Record<string, unknown>) => Promise<ActionResult>;
}

export function ProductDetail({
  view,
  handlers,
}: { view: ProductDetailView; handlers: ProductDetailHandlers }) {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/inventario"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Inventario
      </Link>
      <div className="mt-4 flex flex-wrap items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-card bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
          <Package className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
              {view.name}
            </h1>
            <span className={chipClass(view.alertTone)}>{view.alertLabel}</span>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
            {view.sku && <span className="tabular font-semibold text-ink">{view.sku}</span>}
            {view.category && <span>{view.category}</span>}
            <span>Unidad: {view.unit}</span>
            <span>Origen: {view.sourceLabel}</span>
            <span>Proveedor: {view.supplierName ?? 'sin proveedor habitual'}</span>
          </p>
        </div>
      </div>

      <div className="mt-5">
        <Tiles tiles={view.tiles} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <ConsumptionChart view={view} />
          <Movements view={view} />
        </div>
        <div className="space-y-4">
          <MoveForm view={view} handlers={handlers} />
          <ByLocation view={view} />
          <SettingsForm view={view} handlers={handlers} />
        </div>
      </div>
    </div>
  );
}

function ConsumptionChart({ view }: { view: ProductDetailView }) {
  const W = 640;
  const H = 160;
  const pad = 24;
  const n = view.weekly.length || 1;
  const bw = (W - pad * 2) / n;
  return (
    <Panel>
      <PanelHead
        icon={<BarChart3 className="h-4 w-4" aria-hidden />}
        title="Consumo por semana"
        right={<span className="tabular">{view.dailyLabel}</span>}
      />
      <div className="px-6 pb-5 pt-3">
        <svg
          viewBox={`0 0 ${W} ${H + 22}`}
          className="h-auto w-full"
          role="img"
          aria-label="Salidas por semana, últimas 13 semanas"
        >
          <line x1={pad} x2={W - pad} y1={H} y2={H} className="stroke-border" strokeWidth={1} />
          {view.weekly.map((w, i) => {
            const h = (w.qty / view.weeklyMax) * (H - 16);
            const x = pad + i * bw + bw * 0.18;
            return (
              <g key={w.label}>
                <rect
                  x={x}
                  y={H - h}
                  width={bw * 0.64}
                  height={Math.max(h, w.qty > 0 ? 2 : 0)}
                  rx={3}
                  className={clsx(i === n - 1 ? 'fill-primary' : 'fill-primary/40')}
                >
                  <title>{`Semana del ${w.label}: ${w.qty.toLocaleString('es-CO')} ${view.unit}`}</title>
                </rect>
                {(i % 2 === 0 || i === n - 1) && (
                  <text
                    x={x + bw * 0.32}
                    y={H + 15}
                    textAnchor="middle"
                    className="fill-ink-faint text-micro"
                  >
                    {w.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {view.weekly.every((w) => w.qty === 0) && (
          <p className="text-xs text-ink-faint">Sin salidas en las últimas 13 semanas.</p>
        )}
      </div>
    </Panel>
  );
}

function Movements({ view }: { view: ProductDetailView }) {
  return (
    <Panel>
      <PanelHead
        icon={<History className="h-4 w-4" aria-hidden />}
        title="Movimientos"
        right={`${view.movements.length} recientes`}
      />
      {view.movements.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-sm text-ink-muted">Todavía no hay movimientos.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-t border-border">
          {view.movements.map((m) => (
            <li
              key={m.id}
              className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-start gap-3 px-6 py-2.5"
            >
              <span className="tabular pt-0.5 text-xs text-ink-faint">{m.dateLabel}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={chipClass(m.tone)}>{m.kindLabel}</span>
                  {m.href ? (
                    <Link
                      href={m.href}
                      className="truncate text-sm font-medium text-ink hover:text-primary"
                    >
                      {m.referenceLabel}
                    </Link>
                  ) : (
                    <span className="truncate text-sm text-ink">{m.referenceLabel}</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {m.locationName}
                  {m.costLabel ? ` · ${m.costLabel} c/u` : ''}
                  {m.note ? ` · ${m.note}` : ''}
                </p>
              </div>
              <span
                className={clsx(
                  'tabular pt-0.5 text-sm font-bold',
                  TONE_TEXT[
                    m.tone === 'rose' ? 'rose' : m.tone === 'emerald' ? 'emerald' : 'neutral'
                  ],
                )}
              >
                {m.qtyLabel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ByLocation({ view }: { view: ProductDetailView }) {
  return (
    <Panel>
      <PanelHead icon={<Warehouse className="h-4 w-4" aria-hidden />} title="Por bodega" />
      <ul className="space-y-3 px-6 pb-5 pt-3">
        {view.byLocation.length === 0 && (
          <li className="text-sm text-ink-muted">Sin existencias.</li>
        )}
        {view.byLocation.map((l) => (
          <li key={l.name}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink">{l.name}</span>
              <span className="tabular font-semibold text-ink">{l.qtyLabel}</span>
            </div>
            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-pill bg-surface-2">
              <span
                className="block h-full rounded-pill bg-primary"
                style={{ width: `${Math.round(l.share * 100)}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const KINDS = [
  { id: 'entrada', label: 'Entrada' },
  { id: 'salida', label: 'Salida' },
  { id: 'ajuste', label: 'Conteo' },
] as const;

function MoveForm({
  view,
  handlers,
}: { view: ProductDetailView; handlers: ProductDetailHandlers }) {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('entrada');
  const [amount, setAmount] = useState('');
  const [cost, setCost] = useState('');
  const [locationId, setLocationId] = useState(view.locations[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const n = readNumber(amount);
  return (
    <Panel>
      <PanelHead icon={<Package className="h-4 w-4" aria-hidden />} title="Registrar" />
      <form
        className="space-y-3 px-6 pb-5 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (n === null) return;
          start(async () => {
            const r = await handlers.move({
              productId: view.id,
              kind,
              qty: n,
              unitCost: kind === 'entrada' ? readNumber(cost) : null,
              locationId: locationId || null,
              note: note.trim() || null,
            });
            setResult(r);
            if (r.ok) {
              setAmount('');
              setCost('');
              setNote('');
              router.refresh();
            }
          });
        }}
      >
        <div className="grid grid-cols-3 gap-1 rounded-pill bg-surface-2 p-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={clsx(
                'min-h-8 rounded-pill text-xs font-bold transition-colors duration-150 motion-reduce:transition-none',
                kind === k.id ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        {view.stockFromAccounting && (
          <p className="text-xs leading-relaxed text-amber">
            Las existencias de este producto las manda el programa contable: lo que registres aquí
            se corrige en la próxima sincronización si allá no se registra igual.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {kind === 'ajuste' ? 'Contado' : 'Cantidad'}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={NUMBER_FIELD}
            />
          </label>
          {kind === 'entrada' ? (
            <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
              Costo c/u
              <input
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="opcional"
                className={NUMBER_FIELD}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
              Bodega
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className={FIELD}
              >
                {view.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nota o referencia (opcional)"
          aria-label="Nota"
          className={FIELD}
        />
        <Button type="submit" className="w-full" disabled={pending || n === null}>
          {kind === 'entrada'
            ? 'Registrar entrada'
            : kind === 'salida'
              ? 'Registrar salida'
              : 'Ajustar al conteo'}
        </Button>
        <Feedback result={result} />
      </form>
    </Panel>
  );
}

function SettingsForm({
  view,
  handlers,
}: { view: ProductDetailView; handlers: ProductDetailHandlers }) {
  const [values, setValues] = useState({
    minimo: view.settings.minStock?.toString() ?? '',
    reponer: view.settings.reorderQty?.toString() ?? '',
    entrega: view.settings.leadTimeDays?.toString() ?? '',
    precio: view.settings.price?.toString() ?? '',
  });
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const fields: Array<{ key: keyof typeof values; label: string }> = [
    { key: 'minimo', label: 'Mínimo' },
    { key: 'reponer', label: 'Cantidad a pedir' },
    { key: 'entrega', label: 'Días de entrega' },
    { key: 'precio', label: 'Precio de venta' },
  ];
  return (
    <Panel>
      <PanelHead icon={<Settings2 className="h-4 w-4" aria-hidden />} title="Reposición" />
      <form
        className="space-y-3 px-6 pb-5 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setResult(
              await handlers.saveSettings(
                view.id,
                Object.fromEntries(Object.entries(values).map(([k, v]) => [k, readNumber(v)])),
              ),
            );
          });
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
              {f.label}
              <input
                inputMode="decimal"
                value={values[f.key]}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className={NUMBER_FIELD}
              />
            </label>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-ink-faint">
          Bajo el mínimo, Cortex sugiere la cantidad a pedir; sin ella, lo que cubre los días de
          entrega al ritmo de consumo.
        </p>
        <Button type="submit" variant="outline" disabled={pending}>
          Guardar
        </Button>
        <Feedback result={result} />
      </form>
    </Panel>
  );
}
