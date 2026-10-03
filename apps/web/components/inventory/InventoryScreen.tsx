'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type {
  ActionResult,
  CountRowView,
  InventoryTab,
  InventoryTile,
  LocationView,
  PoListItem,
  ReorderGroupView,
} from '@/lib/inventory/shape';
import { INVENTORY_TABS } from '@/lib/inventory/shape';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ClipboardCheck,
  FileUp,
  LoaderCircle,
  Package,
  Plus,
  ShoppingCart,
  Store,
  Truck,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Empty, FIELD, Feedback, Modal, NUMBER_FIELD, TONE_BAR, Tiles, readNumber } from './parts';

/**
 * /inventario: existencias, reposición, órdenes de compra, bodegas y conteo
 * (migración 0183). Todo llega armado del servidor (lib/inventory/views.ts);
 * las acciones llegan como funciones para que el escaparate de desarrollo
 * pinte la misma pantalla sin sesión.
 */

export interface InventoryHandlers {
  onEdit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  onBulkEdit?: (rowIds: string[], key: string, value: unknown) => Promise<void>;
  onCreate?: (values: Record<string, unknown>) => Promise<GridRow>;
  importCsv: (text: string) => Promise<ActionResult>;
  createOrders: (productIds?: string[]) => Promise<ActionResult>;
  setSupplier: (productIds: string[], name: string) => Promise<ActionResult>;
  addLocation: (name: string) => Promise<ActionResult>;
  applyCount: (
    locationId: string,
    lines: Array<{ productId: string; counted: number }>,
    note: string | null,
  ) => Promise<ActionResult>;
}

export interface InventoryScreenProps {
  tab: InventoryTab;
  tiles: InventoryTile[];
  columns: GridColumn[];
  rows: GridRow[];
  presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  reorder: ReorderGroupView[];
  orders: PoListItem[];
  locations: LocationView[];
  count: CountRowView[];
  counts: Partial<Record<InventoryTab, number>>;
  handlers: InventoryHandlers;
  /** Para el escaparate: enlaces de pestaña que no navegan. */
  tabHref?: (tab: InventoryTab) => string;
}

export function InventoryScreen(props: InventoryScreenProps) {
  const [importing, setImporting] = useState(false);
  const href =
    props.tabHref ??
    ((t: InventoryTab) => (t === 'productos' ? '/inventario' : `/inventario?tab=${t}`));
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Inventario y compras"
        subtitle="Lo que hay en cada bodega y cuánto vale, lo que hay que pedir antes de que se acabe, y las órdenes de compra hasta que llega la mercancía y la factura."
        icon={<Package className="h-5 w-5" aria-hidden />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp className="h-4 w-4" aria-hidden />
              Importar hoja
            </Button>
            <Link
              href={href('reponer')}
              className="cortex-primary-button inline-flex min-h-10 items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
            >
              <ShoppingCart className="h-4 w-4" aria-hidden />
              Por reponer
              {props.counts.reponer ? (
                <span className="rounded-pill bg-white/20 px-1.5 text-xs tabular">
                  {props.counts.reponer}
                </span>
              ) : null}
            </Link>
          </div>
        }
      />

      <Tiles tiles={props.tiles} />

      <nav
        className="mb-5 mt-7 flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones de inventario"
      >
        {INVENTORY_TABS.map((t) => (
          <Link
            key={t.id}
            href={href(t.id)}
            aria-current={props.tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              props.tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {(props.counts[t.id] ?? 0) > 0 && (
              <span className={chipClass(t.id === 'reponer' ? 'amber' : 'neutral')}>
                {props.counts[t.id]}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {props.tab === 'productos' && <ProductsTab {...props} onImport={() => setImporting(true)} />}
      {props.tab === 'reponer' && <ReorderTab groups={props.reorder} handlers={props.handlers} />}
      {props.tab === 'ordenes' && <OrdersTab orders={props.orders} reorderHref={href('reponer')} />}
      {props.tab === 'bodegas' && (
        <LocationsTab locations={props.locations} handlers={props.handlers} />
      )}
      {props.tab === 'conteo' && (
        <CountTab rows={props.count} locations={props.locations} handlers={props.handlers} />
      )}

      {importing && (
        <ImportDialog onClose={() => setImporting(false)} importCsv={props.handlers.importCsv} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

function ProductsTab(props: InventoryScreenProps & { onImport: () => void }) {
  const [preset, setPreset] = useState(props.presets[0]?.id ?? 'todos');
  const current = props.presets.find((p) => p.id === preset) ?? props.presets[0];
  if (props.rows.length === 0)
    return (
      <Empty
        title="Todavía no hay productos"
        body="Llegan solos si conectas Siigo, Alegra o QuickBooks en Integraciones (con existencias cuando el programa las da), o súbelos desde tu hoja de inventario: código, nombre, existencias, mínimo, costo y proveedor."
        action={
          <Button onClick={props.onImport}>
            <FileUp className="h-4 w-4" aria-hidden />
            Importar hoja
          </Button>
        }
      />
    );
  return (
    <div className="space-y-4">
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">Vistas rápidas</legend>
        {props.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === preset}
            onClick={() => setPreset(p.id)}
            className={clsx(
              chipClass(p.id === preset ? 'primary' : 'neutral'),
              CHIP_INTERACTIVE,
              'min-h-8 px-3 text-xs',
            )}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      <DataGrid
        key={preset}
        columns={props.columns}
        rows={props.rows}
        initialView={current?.view}
        onEdit={props.handlers.onEdit}
        onBulkEdit={props.handlers.onBulkEdit}
        onCreate={props.handlers.onCreate}
        exportName="inventario"
        noun={{ one: 'producto', many: 'productos', gender: 'm' }}
        askCortexContext="mi inventario: existencias, mínimos, costo promedio y lo que hay que pedir"
        urlParam={false}
        height="calc(100vh - 360px)"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Por reponer
// ---------------------------------------------------------------------------

function ReorderTab({
  groups,
  handlers,
}: { groups: ReorderGroupView[]; handlers: InventoryHandlers }) {
  const router = useRouter();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const ready = groups.filter((g) => g.supplierId);
  const orphans = groups.find((g) => !g.supplierId);
  const selected = ready
    .flatMap((g) => g.lines.map((l) => l.productId))
    .filter((id) => !excluded.has(id));

  if (groups.length === 0)
    return (
      <Empty
        title="Nada por pedir"
        body="Todo está sobre su mínimo, o lo que falta ya viene en una orden de compra. Cortex vuelve a mirar cada mañana y te avisa en el piloto automático."
      />
    );

  function create(ids: string[]) {
    setResult(null);
    start(async () => {
      const r = await handlers.createOrders(ids);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">
            {ready.length
              ? `${selected.length} productos en ${ready.length} ${ready.length === 1 ? 'orden' : 'órdenes'} de compra, una por proveedor`
              : 'Falta el proveedor de lo que hay que pedir'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Las cantidades ya descuentan lo que viene pedido. Las órdenes quedan por aprobar en
            Aprobaciones —se aprueban todas de una vez— y al aprobarlas salen al proveedor con el
            PDF de la empresa.
          </p>
        </div>
        <Button disabled={pending || selected.length === 0} onClick={() => create(selected)}>
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <ShoppingCart className="h-4 w-4" aria-hidden />
          )}
          Crear órdenes de compra
        </Button>
      </Panel>
      <Feedback result={result} />

      <div className="grid gap-4 xl:grid-cols-2">
        {ready.map((g) => (
          <Panel key={g.key} className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Store className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">{g.supplierName}</p>
                  <p className="text-xs text-ink-faint">
                    {g.lines.length} {g.lines.length === 1 ? 'producto' : 'productos'}
                    {g.leadLabel ? ` · ${g.leadLabel}` : ''}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="stat-num text-base text-ink">{g.totalLabel}</p>
                {g.missingCost > 0 && (
                  <p className="text-xs text-amber">{g.missingCost} sin costo</p>
                )}
              </div>
            </div>
            <ReorderLines
              lines={g.lines}
              excluded={excluded}
              toggle={(id) =>
                setExcluded((prev) => {
                  const next = new Set(prev);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })
              }
            />
            <div className="flex justify-end border-t border-border bg-surface-2/40 px-5 py-3">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  create(g.lines.map((l) => l.productId).filter((id) => !excluded.has(id)))
                }
                className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:text-primary-strong disabled:opacity-50"
              >
                Sólo esta orden
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </Panel>
        ))}
      </div>

      {orphans && <OrphanPanel group={orphans} handlers={handlers} />}
    </div>
  );
}

function ReorderLines({
  lines,
  excluded,
  toggle,
}: {
  lines: ReorderGroupView['lines'];
  excluded?: Set<string>;
  toggle?: (id: string) => void;
}) {
  return (
    <ul className="mt-3 divide-y divide-border border-t border-border">
      {lines.map((l) => {
        const off = excluded?.has(l.productId) ?? false;
        return (
          <li
            key={l.productId}
            className={clsx('flex items-start gap-3 px-5 py-3', off && 'opacity-50')}
          >
            {toggle && (
              <input
                type="checkbox"
                checked={!off}
                onChange={() => toggle(l.productId)}
                aria-label={`Incluir ${l.name}`}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary,#4f46e5)]"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/inventario/${l.productId}`}
                  className="text-sm font-semibold text-ink hover:text-primary"
                >
                  {l.name}
                </Link>
                {l.sku && <span className="text-xs text-ink-faint">{l.sku}</span>}
                {l.urgent && (
                  <span className={chipClass('rose')}>
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    Agotado
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{l.why}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular text-sm font-bold text-ink">{l.qtyLabel}</p>
              <p className="tabular text-xs text-ink-faint">{l.totalLabel ?? 'sin costo'}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function OrphanPanel({
  group,
  handlers,
}: { group: ReorderGroupView; handlers: InventoryHandlers }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel className="overflow-hidden border-amber/30">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-sm bg-amber-soft text-amber">
            <AlertTriangle className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-bold text-ink">Sin proveedor habitual</p>
            <p className="text-xs text-ink-faint">
              Dime a quién se los compras y entran a una orden.
            </p>
          </div>
        </div>
      </div>
      <ReorderLines lines={group.lines} />
      <form
        className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/40 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await handlers.setSupplier(
              group.lines.map((l) => l.productId),
              name,
            );
            setResult(r);
            if (r.ok) {
              setName('');
              router.refresh();
            }
          });
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Proveedor (nombre o NIT)"
          aria-label="Proveedor habitual"
          className={clsx(FIELD, 'max-w-xs flex-1')}
        />
        <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
          Fijar proveedor
        </Button>
        <div className="w-full">
          <Feedback result={result} />
        </div>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Órdenes de compra
// ---------------------------------------------------------------------------

const ORDER_FILTERS = [
  { id: 'abiertas', label: 'Abiertas' },
  { id: 'aprobar', label: 'Por aprobar' },
  { id: 'camino', label: 'En camino' },
  { id: 'todas', label: 'Todas' },
] as const;

function OrdersTab({ orders, reorderHref }: { orders: PoListItem[]; reorderHref: string }) {
  const [filter, setFilter] = useState<(typeof ORDER_FILTERS)[number]['id']>('abiertas');
  const shown = useMemo(
    () =>
      orders.filter((o) =>
        filter === 'todas'
          ? true
          : filter === 'aprobar'
            ? o.statusLabel === 'Por aprobar' || o.statusLabel === 'Borrador'
            : filter === 'camino'
              ? ['Aprobada', 'Enviada', 'Recibida en parte'].includes(o.statusLabel)
              : !['Cerrada', 'Cancelada', 'Facturada'].includes(o.statusLabel),
      ),
    [orders, filter],
  );
  if (orders.length === 0)
    return (
      <Empty
        title="Todavía no hay órdenes de compra"
        body="Se crean desde «Por reponer» con un clic (una por proveedor), o pidiéndoselas a Cortex en el chat: «pídele a Ferretería Central 200 tornillos»."
        action={
          <Link
            href={reorderHref}
            className="text-sm font-bold text-primary hover:text-primary-strong"
          >
            Ver lo que hay por reponer
          </Link>
        }
      />
    );
  return (
    <div className="space-y-4">
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Filtrar órdenes</legend>
        {ORDER_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              chipClass(filter === f.id ? 'primary' : 'neutral'),
              CHIP_INTERACTIVE,
              'min-h-8 px-3 text-xs',
            )}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <Panel className="overflow-hidden">
        {shown.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-ink-muted">
            Ninguna orden en este filtro.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((o) => (
              <li key={o.id}>
                <Link
                  href={o.href}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-3.5 transition-colors duration-150 hover:bg-surface-2/50 sm:grid-cols-[110px_minmax(0,1fr)_140px_130px_120px] motion-reduce:transition-none"
                >
                  <span className="tabular text-sm font-bold text-ink">{o.label}</span>
                  <span className="min-w-0 sm:order-none">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {o.supplierName}
                    </span>
                    <span className="text-xs text-ink-faint">
                      {o.linesLabel} · creada {o.createdLabel}
                      {o.expectedLabel ? ` · llega ${o.expectedLabel}` : ''}
                    </span>
                  </span>
                  <span>
                    <span className={chipClass(o.tone)}>{o.statusLabel}</span>
                  </span>
                  <span className="hidden sm:block">
                    <span className="block h-1.5 overflow-hidden rounded-pill bg-surface-2">
                      <span
                        className={clsx('block h-full rounded-pill', TONE_BAR.emerald)}
                        style={{ width: `${Math.round(o.progress * 100)}%` }}
                      />
                    </span>
                    <span className="mt-1 block text-micro text-ink-faint">
                      {Math.round(o.progress * 100)}% recibido
                    </span>
                  </span>
                  <span className="stat-num text-right text-sm text-ink">{o.totalLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

function LocationsTab({
  locations,
  handlers,
}: { locations: LocationView[]; handlers: InventoryHandlers }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {locations.map((l) => (
          <Panel key={l.id} className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Warehouse className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <p className="text-sm font-bold text-ink">{l.name}</p>
                  <p className="text-xs text-ink-faint">
                    {l.isDefault ? 'Principal' : 'Bodega'}
                    {l.sourceLabel ? ` · de ${l.sourceLabel}` : ''}
                  </p>
                </div>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-ink-faint">Productos</dt>
                <dd className="stat-num mt-1 text-base text-ink">{l.products}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Unidades</dt>
                <dd className="stat-num mt-1 text-base text-ink">{l.units}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Valor</dt>
                <dd className="stat-num mt-1 text-base text-ink">{l.valueLabel}</dd>
              </div>
            </dl>
          </Panel>
        ))}
        <Panel className="border-dashed px-5 py-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await handlers.addLocation(name);
                setResult(r);
                if (r.ok) {
                  setName('');
                  router.refresh();
                }
              });
            }}
            className="space-y-3"
          >
            <p className="flex items-center gap-2 text-sm font-bold text-ink">
              <Plus className="h-4 w-4 text-ink-faint" aria-hidden />
              Nueva bodega
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej.: Bodega Cali, Punto de venta"
              aria-label="Nombre de la bodega"
              className={FIELD}
            />
            <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
              Crear bodega
            </Button>
            <Feedback result={result} />
          </form>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conteo
// ---------------------------------------------------------------------------

function CountTab({
  rows,
  locations,
  handlers,
}: {
  rows: CountRowView[];
  locations: LocationView[];
  handlers: InventoryHandlers;
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const visible = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q);
  });
  const entered = Object.entries(counted)
    .map(([productId, raw]) => ({ productId, counted: readNumber(raw) }))
    .filter(
      (l): l is { productId: string; counted: number } => l.counted !== null && l.counted >= 0,
    );
  const diffs = entered.filter((l) => {
    const sys = rows.find((r) => r.productId === l.productId)?.system[locationId] ?? 0;
    return Math.abs(l.counted - sys) > 1e-9;
  }).length;

  if (rows.length === 0)
    return (
      <Empty
        title="Nada que contar"
        body="Cuando haya productos con existencias, aquí se cuenta cada bodega y Cortex ajusta la diferencia."
      />
    );

  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-end gap-3 px-5 py-4">
        <label className="flex min-w-[180px] flex-col gap-1 text-xs font-semibold text-ink-muted">
          Bodega
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={FIELD}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-semibold text-ink-muted">
          Buscar
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nombre o código"
            className={FIELD}
          />
        </label>
        <div className="ml-auto text-right text-xs text-ink-muted">
          <p>
            <span className="font-bold text-ink">{entered.length}</span> contados ·{' '}
            <span className={clsx('font-bold', diffs ? 'text-amber' : 'text-ink')}>{diffs}</span>{' '}
            con diferencia
          </p>
        </div>
      </Panel>
      <Panel className="overflow-hidden">
        <div className="max-h-[56vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] bg-surface-2 text-left text-xs font-semibold text-ink-muted">
              <tr>
                <th className="px-5 py-2.5">Producto</th>
                <th className="px-3 py-2.5 text-right">Según el libro</th>
                <th className="w-40 px-3 py-2.5 text-right">Contado</th>
                <th className="px-5 py-2.5 text-right">Diferencia</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((r) => {
                const sys = r.system[locationId] ?? 0;
                const n = readNumber(counted[r.productId] ?? '');
                const diff = n === null ? null : n - sys;
                return (
                  <tr key={r.productId}>
                    <td className="px-5 py-2">
                      <span className="font-semibold text-ink">{r.name}</span>
                      {r.sku && <span className="ml-2 text-xs text-ink-faint">{r.sku}</span>}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-muted">
                      {sys.toLocaleString('es-CO')} {r.unit}
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        inputMode="decimal"
                        value={counted[r.productId] ?? ''}
                        onChange={(e) =>
                          setCounted((prev) => ({ ...prev, [r.productId]: e.target.value }))
                        }
                        aria-label={`Contado de ${r.name}`}
                        className={NUMBER_FIELD}
                      />
                    </td>
                    <td
                      className={clsx(
                        'tabular px-5 py-2 text-right font-semibold',
                        diff === null || Math.abs(diff) < 1e-9
                          ? 'text-ink-faint'
                          : diff < 0
                            ? 'text-rose'
                            : 'text-emerald',
                      )}
                    >
                      {diff === null
                        ? '—'
                        : `${diff > 0 ? '+' : ''}${diff.toLocaleString('es-CO')}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form
          className="flex flex-wrap items-center gap-3 border-t border-border bg-surface-2/40 px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await handlers.applyCount(locationId, entered, note.trim() || null);
              setResult(r);
              if (r.ok) {
                setCounted({});
                router.refresh();
              }
            });
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota del conteo (opcional)"
            aria-label="Nota del conteo"
            className={clsx(FIELD, 'max-w-sm flex-1')}
          />
          <Button type="submit" disabled={pending || entered.length === 0}>
            <ClipboardCheck className="h-4 w-4" aria-hidden />
            Guardar conteo
          </Button>
          <p className="text-xs text-ink-faint">Sólo se ajusta lo que escribiste y no cuadra.</p>
          <div className="w-full">
            <Feedback result={result} />
          </div>
        </form>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Importar hoja
// ---------------------------------------------------------------------------

function ImportDialog({
  onClose,
  importCsv,
}: { onClose: () => void; importCsv: (t: string) => Promise<ActionResult> }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Modal
      title="Importar productos desde una hoja"
      subtitle="Exporta tu hoja o Excel como CSV y súbelo, o pega las filas con sus encabezados. Las existencias de la hoja entran como un ajuste por la diferencia; lo que ya estaba se actualiza por código."
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded-sm border border-dashed border-border-strong px-4 py-3 text-sm text-ink-muted hover:bg-surface-2/50">
          <Boxes className="h-5 w-5 text-ink-faint" aria-hidden />
          <span>
            <span className="font-semibold text-ink">Elegir archivo CSV</span> · o pega abajo
          </span>
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setText);
            }}
          />
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={
            'Código;Producto;Existencias;Mínimo;Cantidad a pedir;Costo;Proveedor;Días de entrega\nT-10;Tornillo 10mm;120;50;200;300;Ferretería Central;5'
          }
          className={clsx(FIELD, 'min-h-40 py-2 font-mono text-xs')}
        />
        <p className="text-xs leading-relaxed text-ink-faint">
          Columnas que reconozco: código, producto, unidad, categoría, existencias, mínimo, cantidad
          a pedir, días de entrega, costo, precio, proveedor, NIT del proveedor y bodega.
        </p>
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            disabled={pending || !text.trim()}
            onClick={() =>
              start(async () => {
                const r = await importCsv(text);
                setResult(r);
                if (r.ok) router.refresh();
              })
            }
          >
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Truck className="h-4 w-4" aria-hidden />
            )}
            Importar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
