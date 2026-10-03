'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import {
  Empty,
  FIELD,
  Feedback,
  Modal,
  NUMBER_FIELD,
  TONE_TEXT,
  Tiles,
  readNumber,
} from '@/components/inventory/parts';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import type {
  ActionResult,
  AnomalyView,
  EventRowView,
  FleetChoices,
  FleetTab,
  FuelInputView,
  FuelRowView,
  FuelSummaryView,
  MaintenanceInputView,
  NewVehicleInput,
  PlanInputView,
  PlanRowView,
  RouteEstimateView,
  Tile,
  TripInputView,
  VehicleCardView,
} from '@/lib/fleet/shape';
import { FLEET_TABS } from '@/lib/fleet/shape';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Calculator,
  Fuel,
  Gauge,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Route,
  ShieldAlert,
  Truck,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * /flota: vehículos, mantenimiento, combustible y recorridos (migración 0196).
 * Todo llega armado del servidor (lib/fleet/views.ts); las acciones llegan
 * como funciones para que el escaparate de desarrollo pinte la misma pantalla.
 */

export interface FleetHandlers {
  addVehicle: (input: NewVehicleInput) => Promise<ActionResult>;
  updateVehicle: (
    id: string,
    input: Omit<NewVehicleInput, 'plate' | 'defaultPlans'> & { inFleet?: boolean },
  ) => Promise<ActionResult>;
  logFuel: (input: FuelInputView) => Promise<ActionResult>;
  logMaintenance: (input: MaintenanceInputView) => Promise<ActionResult>;
  savePlan: (input: PlanInputView) => Promise<ActionResult>;
  estimateRoute: (stops: string[]) => Promise<RouteEstimateView>;
  createTrip: (input: TripInputView) => Promise<ActionResult>;
  onEditTrip?: (rowId: string, key: string, value: unknown) => Promise<void>;
}

export interface FleetScreenProps {
  tab: FleetTab;
  today: string;
  tiles: Tile[];
  vehicles: VehicleCardView[];
  plans: PlanRowView[];
  events: EventRowView[];
  fuel: FuelRowView[];
  fuelSummary: FuelSummaryView[];
  anomalies: AnomalyView[];
  tripColumns: GridColumn[];
  tripRows: GridRow[];
  tripPresets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  choices: FleetChoices;
  handlers: FleetHandlers;
  tabHref?: (tab: FleetTab) => string;
}

type Dialog =
  | { kind: 'vehicle' }
  | { kind: 'edit'; vehicle: VehicleCardView }
  | { kind: 'fuel'; vehicleId?: string }
  | { kind: 'maintenance'; vehicleId?: string }
  | { kind: 'plan'; vehicleId?: string }
  | { kind: 'trip' }
  | null;

export function FleetScreen(props: FleetScreenProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const href =
    props.tabHref ?? ((t: FleetTab) => (t === 'vehiculos' ? '/flota' : `/flota?tab=${t}`));
  const hasVehicles = props.vehicles.length > 0;
  const primary: Record<FleetTab, { label: string; icon: typeof Plus; open: Dialog }> = {
    vehiculos: { label: 'Agregar vehículo', icon: Plus, open: { kind: 'vehicle' } },
    mantenimiento: {
      label: 'Registrar mantenimiento',
      icon: Wrench,
      open: { kind: 'maintenance' },
    },
    combustible: { label: 'Registrar tanqueo', icon: Fuel, open: { kind: 'fuel' } },
    recorridos: { label: 'Planear recorrido', icon: Route, open: { kind: 'trip' } },
  };
  const action = primary[props.tab];
  const Icon = action.icon;
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Flota y rutas"
        subtitle="Cada vehículo con sus papeles al día, el mantenimiento que toca, lo que gasta en combustible, sus recorridos y lo que cuesta cada kilómetro."
        icon={<Truck className="h-5 w-5" aria-hidden />}
        actions={
          <div className="flex flex-wrap gap-2">
            {props.tab !== 'combustible' && hasVehicles && (
              <Button variant="outline" onClick={() => setDialog({ kind: 'fuel' })}>
                <Fuel className="h-4 w-4" aria-hidden />
                Tanqueo
              </Button>
            )}
            <Button
              onClick={() => setDialog(action.open)}
              disabled={props.tab !== 'vehiculos' && !hasVehicles}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {action.label}
            </Button>
          </div>
        }
      />
      <Tiles tiles={props.tiles} />

      <nav
        className="mb-5 mt-7 flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones de flota"
      >
        {FLEET_TABS.map((t) => (
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
          </Link>
        ))}
      </nav>

      {!hasVehicles && props.tab !== 'recorridos' ? (
        <Empty
          title="Todavía no hay vehículos en la flota"
          body="Agrega cada vehículo con su placa, tipo, combustible, kilometraje y conductor. Cortex le pone un plan de mantenimiento, lee el SOAT y la tecnomecánica y te avisa cuando algo toque o un tanqueo rinda raro."
          action={
            <Button onClick={() => setDialog({ kind: 'vehicle' })}>
              <Plus className="h-4 w-4" aria-hidden />
              Agregar vehículo
            </Button>
          }
        />
      ) : (
        <>
          {props.tab === 'vehiculos' && <VehiclesTab vehicles={props.vehicles} open={setDialog} />}
          {props.tab === 'mantenimiento' && (
            <MaintenanceTab plans={props.plans} events={props.events} open={setDialog} />
          )}
          {props.tab === 'combustible' && (
            <FuelTab rows={props.fuel} summary={props.fuelSummary} anomalies={props.anomalies} />
          )}
          {props.tab === 'recorridos' && (
            <TripsTab {...props} onNew={() => setDialog({ kind: 'trip' })} />
          )}
        </>
      )}

      {dialog?.kind === 'vehicle' && (
        <VehicleDialog
          choices={props.choices}
          onClose={() => setDialog(null)}
          save={props.handlers.addVehicle}
        />
      )}
      {dialog?.kind === 'edit' && (
        <VehicleDialog
          choices={props.choices}
          vehicle={dialog.vehicle}
          onClose={() => setDialog(null)}
          update={props.handlers.updateVehicle}
        />
      )}
      {dialog?.kind === 'fuel' && (
        <FuelDialog
          choices={props.choices}
          vehicleId={dialog.vehicleId}
          today={props.today}
          onClose={() => setDialog(null)}
          save={props.handlers.logFuel}
        />
      )}
      {dialog?.kind === 'maintenance' && (
        <MaintenanceDialog
          choices={props.choices}
          vehicles={props.vehicles}
          vehicleId={dialog.vehicleId}
          today={props.today}
          onClose={() => setDialog(null)}
          save={props.handlers.logMaintenance}
        />
      )}
      {dialog?.kind === 'plan' && (
        <PlanDialog
          choices={props.choices}
          vehicleId={dialog.vehicleId}
          onClose={() => setDialog(null)}
          save={props.handlers.savePlan}
        />
      )}
      {dialog?.kind === 'trip' && (
        <TripDialog
          choices={props.choices}
          today={props.today}
          onClose={() => setDialog(null)}
          save={props.handlers.createTrip}
          estimate={props.handlers.estimateRoute}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vehículos
// ---------------------------------------------------------------------------

function VehiclesTab({
  vehicles,
  open,
}: { vehicles: VehicleCardView[]; open: (d: Dialog) => void }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {vehicles.map((v) => (
        <li
          key={v.id}
          className="flex flex-col rounded-card border border-border bg-surface shadow-card"
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <div className="min-w-0">
              <span className="inline-block rounded-[6px] border-2 border-ink bg-amber-soft px-2 py-0.5 font-mono text-base font-extrabold tracking-[0.12em] text-ink">
                {v.plate}
              </span>
              <p className="mt-2 truncate text-sm font-semibold text-ink">
                {v.label ?? v.model ?? v.typeLabel ?? 'Vehículo'}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {[v.typeLabel, v.fuelLabel, v.model && v.label ? v.model : null]
                  .filter(Boolean)
                  .join(' · ') || 'Completa tipo y combustible'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => open({ kind: 'edit', vehicle: v })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
              aria-label={`Editar ${v.plate}`}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 px-5 text-xs">
            <div className="flex items-center gap-1.5 text-ink-muted">
              <UserRound className="h-3.5 w-3.5" aria-hidden />
              <dd className="truncate font-semibold text-ink">{v.driver ?? 'Sin conductor'}</dd>
            </div>
            <div className="flex items-center gap-1.5 text-ink-muted">
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              <dd className="truncate font-semibold tabular text-ink">{v.odometer ?? 'Sin km'}</dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap gap-1.5 px-5">
            {v.docs.map((d) => (
              <span key={d.label} className={chipClass(d.tone)}>
                {d.label}: {d.value}
              </span>
            ))}
            {v.pendingFines && (
              <span className={chipClass('rose')}>Comparendos {v.pendingFines}</span>
            )}
          </div>

          {v.attention.length > 0 && (
            <ul className="mx-5 mt-3 space-y-1 rounded-sm bg-amber-soft/60 px-3 py-2 text-xs text-ink">
              {v.attention.slice(0, 4).map((a) => (
                <li key={a} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber" aria-hidden />
                  {a}
                </li>
              ))}
            </ul>
          )}

          <dl className="mt-4 grid grid-cols-3 border-t border-border text-center">
            {[
              ['Rendimiento', v.kmPerGallon ?? '—'],
              ['Costo', v.costPerKm ?? '—'],
              ['Uso (30 d)', v.utilization ?? '—'],
            ].map(([k, val]) => (
              <div key={k} className="border-r border-border px-2 py-3 last:border-r-0">
                <dt className="text-micro font-semibold text-ink-faint">{k}</dt>
                <dd className="mt-0.5 text-xs font-bold tabular text-ink">{val}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border px-4 py-2.5">
            <button
              type="button"
              onClick={() => open({ kind: 'fuel', vehicleId: v.id })}
              className={clsx(chipClass('neutral'), CHIP_INTERACTIVE, 'min-h-7 px-3')}
            >
              <Fuel className="h-3 w-3" aria-hidden /> Tanqueo
            </button>
            <button
              type="button"
              onClick={() => open({ kind: 'maintenance', vehicleId: v.id })}
              className={clsx(chipClass('neutral'), CHIP_INTERACTIVE, 'min-h-7 px-3')}
            >
              <Wrench className="h-3 w-3" aria-hidden /> Mantenimiento
            </button>
            <Link
              href={v.simitHref}
              className={clsx(chipClass('neutral'), CHIP_INTERACTIVE, 'min-h-7 px-3')}
            >
              <ShieldAlert className="h-3 w-3" aria-hidden /> SIMIT
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Mantenimiento
// ---------------------------------------------------------------------------

function MaintenanceTab({
  plans,
  events,
  open,
}: { plans: PlanRowView[]; events: EventRowView[]; open: (d: Dialog) => void }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section className="rounded-card border border-border bg-surface shadow-card">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-bold text-ink">Plan de mantenimiento</h2>
          <Button variant="ghost" onClick={() => open({ kind: 'plan' })}>
            <Plus className="h-4 w-4" aria-hidden />
            Agregar plan
          </Button>
        </header>
        {plans.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-muted">
            Ningún vehículo tiene plan todavía. Agrégale uno con cada cuántos km o días toca.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-ink-muted">
                  <th className="px-5 py-2.5">Vehículo</th>
                  <th className="px-3 py-2.5">Qué</th>
                  <th className="px-3 py-2.5">Cada</th>
                  <th className="px-3 py-2.5">Última vez</th>
                  <th className="px-5 py-2.5">Estado</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} className="border-t border-border/60 align-top">
                    <td className="px-5 py-2.5 font-semibold text-ink">{p.plate}</td>
                    <td className="px-3 py-2.5 text-ink">{p.task}</td>
                    <td className="px-3 py-2.5 text-ink-muted">{p.every}</td>
                    <td className="px-3 py-2.5 text-ink-muted">{p.last}</td>
                    <td className="px-5 py-2.5">
                      <span className={chipClass(p.statusTone)}>{p.status}</span>
                      <span className="mt-1 block text-xs text-ink-faint">{p.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="rounded-card border border-border bg-surface shadow-card">
        <header className="border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-bold text-ink">Lo que se ha hecho</h2>
        </header>
        {events.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-muted">Sin mantenimientos registrados.</p>
        ) : (
          <ul className="divide-y divide-border/60 text-sm">
            {events.map((e) => (
              <li key={e.id} className="px-5 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-semibold text-ink">{e.description}</span>
                  <span className="tabular text-ink">{e.cost}</span>
                </div>
                <p className="text-xs text-ink-faint">
                  {e.plate} · {e.kind} · {e.date}
                  {e.km ? ` · ${e.km}` : ''}
                  {e.vendor ? ` · ${e.vendor}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combustible
// ---------------------------------------------------------------------------

function FuelTab({
  rows,
  summary,
  anomalies,
}: { rows: FuelRowView[]; summary: FuelSummaryView[]; anomalies: AnomalyView[] }) {
  return (
    <div className="space-y-5">
      {anomalies.length > 0 && (
        <section
          className="rounded-card border border-amber/30 bg-amber-soft/50 px-5 py-4"
          aria-label="Consumo raro"
        >
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
            <AlertTriangle className="h-4 w-4 text-amber" aria-hidden />
            Tanqueos fuera de lo normal
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {anomalies.map((a, i) => (
              <li key={`${a.plate}-${a.date}-${i}`}>
                <span className="font-semibold text-ink">
                  {a.plate} · {a.date} · {a.label}.
                </span>{' '}
                <span className="text-ink-muted">{a.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.map((s) => (
          <li
            key={s.plate}
            className="rounded-card border border-border bg-surface px-4 py-3.5 shadow-card"
          >
            <p className="truncate text-xs font-semibold text-ink-muted">{s.plate}</p>
            <p className="stat-num mt-2 text-lg leading-none text-ink">{s.kmPerGallon ?? '—'}</p>
            <p className="mt-1.5 text-xs text-ink-faint">
              {s.median ? `Normal: ${s.median}` : 'Faltan tanques llenos con km'}
              {s.costPerKm ? ` · ${s.costPerKm}` : ''}
            </p>
            {s.anomalies > 0 && (
              <p className={clsx('mt-1 text-xs font-semibold', TONE_TEXT.amber)}>
                {s.anomalies} raro(s)
              </p>
            )}
          </li>
        ))}
      </ul>
      <section className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-ink-muted">
              <th className="px-5 py-2.5">Día</th>
              <th className="px-3 py-2.5">Vehículo</th>
              <th className="px-3 py-2.5 text-right">Galones</th>
              <th className="px-3 py-2.5 text-right">Valor</th>
              <th className="px-3 py-2.5 text-right">Kilometraje</th>
              <th className="px-3 py-2.5 text-right">km/gal</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-8 text-center text-ink-muted">
                  Sin tanqueos en los últimos 90 días.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/60">
                <td className="px-5 py-2.5 text-ink-muted">{r.date}</td>
                <td className="px-3 py-2.5 font-semibold text-ink">{r.plate}</td>
                <td className="px-3 py-2.5 text-right tabular">
                  {r.gallons}
                  {!r.full && <span className="ml-1 text-xs text-ink-faint">(parcial)</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular">{r.amount}</td>
                <td className="px-3 py-2.5 text-right tabular text-ink-muted">{r.km ?? '—'}</td>
                <td className="px-3 py-2.5 text-right tabular font-semibold">
                  {r.kmPerGallon ?? '—'}
                </td>
                <td className="px-5 py-2.5 text-right">
                  {r.anomaly && <span className={chipClass('amber')}>{r.anomaly}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recorridos
// ---------------------------------------------------------------------------

function TripsTab(props: FleetScreenProps & { onNew: () => void }) {
  const [preset, setPreset] = useState(props.tripPresets[0]?.id ?? 'lista');
  const current = props.tripPresets.find((p) => p.id === preset) ?? props.tripPresets[0];
  if (!props.tripRows.length)
    return (
      <Empty
        title="Sin recorridos todavía"
        body="Planea un recorrido con sus paradas en orden, el vehículo, el conductor y las guías que lleva. Al completarlo con los km, Cortex lo costea con lo que le cuesta cada km a ese vehículo."
        action={
          <Button onClick={props.onNew}>
            <Route className="h-4 w-4" aria-hidden />
            Planear recorrido
          </Button>
        }
      />
    );
  return (
    <div className="space-y-4">
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">Vistas</legend>
        {props.tripPresets.map((p) => (
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
        columns={props.tripColumns}
        rows={props.tripRows}
        initialView={current?.view}
        onEdit={props.handlers.onEditTrip}
        noun={{ one: 'recorrido', many: 'recorridos', gender: 'm' }}
        exportName="recorridos"
        urlParam={false}
        askCortexContext="los recorridos de la flota"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diálogos
// ---------------------------------------------------------------------------

function useSave() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, onClose?: () => void) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        router.refresh();
        onClose?.();
      }
    });
  return { result, pending, run, setResult };
}

function Field({
  label,
  children,
  wide,
}: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega como `children`, dentro de la etiqueta.
    <label className={clsx('block text-xs font-semibold text-ink-muted', wide && 'sm:col-span-2')}>
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Footer({
  onClose,
  pending,
  label,
  onSave,
  result,
}: {
  onClose: () => void;
  pending: boolean;
  label: string;
  onSave: () => void;
  result: ActionResult | null;
}) {
  return (
    <div className="mt-4 space-y-3">
      <Feedback result={result} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={onSave} disabled={pending}>
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
          {label}
        </Button>
      </div>
    </div>
  );
}

function VehicleDialog({
  choices,
  vehicle,
  onClose,
  save,
  update,
}: {
  choices: FleetChoices;
  vehicle?: VehicleCardView;
  onClose: () => void;
  save?: FleetHandlers['addVehicle'];
  update?: FleetHandlers['updateVehicle'];
}) {
  const s = useSave();
  const e = vehicle?.edit;
  const [plate, setPlate] = useState('');
  const [label, setLabel] = useState(e?.label ?? '');
  const [type, setType] = useState(e?.vehicleType ?? '');
  const [fuel, setFuel] = useState(e?.fuelType ?? '');
  const [odo, setOdo] = useState(e?.odometerKm ?? '');
  const [tank, setTank] = useState(e?.tankGallons ?? '');
  const [driverId, setDriverId] = useState(e?.driverUserId ?? '');
  const [driverName, setDriverName] = useState(e?.driverName ?? '');
  const [plans, setPlans] = useState(true);
  const body = {
    label: label.trim() || null,
    vehicleType: type || null,
    fuelType: fuel || null,
    odometerKm: readNumber(odo),
    tankGallons: readNumber(tank),
    driverUserId: driverId || null,
    driverName: driverName.trim() || null,
  };
  return (
    <Modal
      title={vehicle ? `Editar ${vehicle.plate}` : 'Agregar vehículo'}
      subtitle={
        vehicle
          ? 'El kilometraje sólo avanza: uno menor no lo baja.'
          : 'Si la placa ya estaba registrada para vigilar el RUNT, se pasa a la flota con estos datos.'
      }
      onClose={onClose}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!vehicle && (
          <Field label="Placa">
            <input
              className={`${FIELD} font-mono uppercase tracking-wider`}
              value={plate}
              placeholder="ABC123"
              maxLength={12}
              onChange={(ev) => setPlate(ev.target.value)}
            />
          </Field>
        )}
        <Field label="Cómo le dicen">
          <input
            className={FIELD}
            value={label}
            placeholder="El NQR blanco"
            onChange={(ev) => setLabel(ev.target.value)}
          />
        </Field>
        <Field label="Tipo">
          <select className={FIELD} value={type} onChange={(ev) => setType(ev.target.value)}>
            <option value="">—</option>
            {choices.vehicleTypes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Combustible">
          <select className={FIELD} value={fuel} onChange={(ev) => setFuel(ev.target.value)}>
            <option value="">—</option>
            {choices.fuelTypes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kilometraje actual">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={odo}
            placeholder="84.320"
            onChange={(ev) => setOdo(ev.target.value)}
          />
        </Field>
        <Field label="Tanque (galones)">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={tank}
            placeholder="25"
            onChange={(ev) => setTank(ev.target.value)}
          />
        </Field>
        <Field label="Conductor del equipo">
          <select
            className={FIELD}
            value={driverId}
            onChange={(ev) => setDriverId(ev.target.value)}
          >
            <option value="">Ninguno / sin cuenta</option>
            {choices.people.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {!driverId && (
          <Field label="…o su nombre">
            <input
              className={FIELD}
              value={driverName}
              placeholder="Pedro Gómez"
              onChange={(ev) => setDriverName(ev.target.value)}
            />
          </Field>
        )}
        {!vehicle && (
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={plans}
              onChange={(ev) => setPlans(ev.target.checked)}
            />
            Ponerle el plan de mantenimiento básico (aceite, frenos, llantas, revisión general)
          </label>
        )}
      </div>
      {vehicle && update && (
        <button
          type="button"
          className="mt-4 text-xs font-semibold text-rose hover:underline"
          onClick={() => s.run(() => update(vehicle.id, { ...body, inFleet: false }), onClose)}
        >
          Sacar de la flota (no borra su historia)
        </button>
      )}
      <Footer
        onClose={onClose}
        pending={s.pending}
        result={s.result}
        label={vehicle ? 'Guardar' : 'Agregar'}
        onSave={() =>
          vehicle && update
            ? s.run(() => update(vehicle.id, body), onClose)
            : save && s.run(() => save({ ...body, plate, defaultPlans: plans }), onClose)
        }
      />
    </Modal>
  );
}

function VehicleSelect({
  choices,
  value,
  onChange,
}: { choices: FleetChoices; value: string; onChange: (v: string) => void }) {
  return (
    <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
      {choices.vehicles.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FuelDialog({
  choices,
  vehicleId,
  today,
  onClose,
  save,
}: {
  choices: FleetChoices;
  vehicleId?: string;
  today: string;
  onClose: () => void;
  save: FleetHandlers['logFuel'];
}) {
  const s = useSave();
  const [vid, setVid] = useState(vehicleId ?? choices.vehicles[0]?.value ?? '');
  const [date, setDate] = useState(today);
  const [gallons, setGallons] = useState('');
  const [amount, setAmount] = useState('');
  const [odo, setOdo] = useState('');
  const [full, setFull] = useState(true);
  const [station, setStation] = useState('');
  return (
    <Modal
      title="Registrar tanqueo"
      subtitle="Con el kilometraje y tanque lleno se mide el rendimiento y se detecta el consumo raro."
      onClose={onClose}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vehículo" wide>
          <VehicleSelect choices={choices} value={vid} onChange={setVid} />
        </Field>
        <Field label="Galones">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={gallons}
            onChange={(e) => setGallons(e.target.value)}
            placeholder="18"
          />
        </Field>
        <Field label="Valor pagado">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="290.000"
          />
        </Field>
        <Field label="Kilometraje">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={odo}
            onChange={(e) => setOdo(e.target.value)}
            placeholder="84.320"
          />
        </Field>
        <Field label="Día">
          <input
            className={FIELD}
            type="date"
            max={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Estación (opcional)" wide>
          <input className={FIELD} value={station} onChange={(e) => setStation(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
          />
          Tanque lleno
        </label>
      </div>
      <Footer
        onClose={onClose}
        pending={s.pending}
        result={s.result}
        label="Registrar"
        onSave={() => {
          const g = readNumber(gallons);
          const a = readNumber(amount);
          if (!vid || g === null || a === null)
            return s.setResult({ ok: false, error: 'Vehículo, galones y valor.' });
          s.run(
            () =>
              save({
                vehicleId: vid,
                date,
                gallons: g,
                amount: a,
                odometerKm: readNumber(odo),
                fullTank: full,
                station: station.trim() || null,
              }),
            onClose,
          );
        }}
      />
    </Modal>
  );
}

function MaintenanceDialog({
  choices,
  vehicles,
  vehicleId,
  today,
  onClose,
  save,
}: {
  choices: FleetChoices;
  vehicles: VehicleCardView[];
  vehicleId?: string;
  today: string;
  onClose: () => void;
  save: FleetHandlers['logMaintenance'];
}) {
  const s = useSave();
  const [vid, setVid] = useState(vehicleId ?? choices.vehicles[0]?.value ?? '');
  const [date, setDate] = useState(today);
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState('');
  const [odo, setOdo] = useState('');
  const [cost, setCost] = useState('');
  const [vendor, setVendor] = useState('');
  const [plan, setPlan] = useState('');
  const plans = vehicles.find((v) => v.id === vid)?.plans ?? [];
  return (
    <Modal
      title="Registrar mantenimiento"
      subtitle="Si cumple un plan, su cuenta vuelve a empezar desde hoy y este kilometraje."
      onClose={onClose}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vehículo">
          <VehicleSelect
            choices={choices}
            value={vid}
            onChange={(v) => {
              setVid(v);
              setPlan('');
            }}
          />
        </Field>
        <Field label="Cumple el plan">
          <select className={FIELD} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">Ninguno / adivinar por la descripción</option>
            {plans.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Qué se le hizo" wide>
          <input
            className={FIELD}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Cambio de aceite y filtros"
          />
        </Field>
        <Field label="Tipo">
          <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Según el plan</option>
            {choices.maintenanceKinds.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Día">
          <input
            className={FIELD}
            type="date"
            max={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Kilometraje">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={odo}
            onChange={(e) => setOdo(e.target.value)}
          />
        </Field>
        <Field label="Costo">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
        <Field label="Taller (opcional)" wide>
          <input className={FIELD} value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
      </div>
      <Footer
        onClose={onClose}
        pending={s.pending}
        result={s.result}
        label="Registrar"
        onSave={() => {
          if (!vid || !desc.trim())
            return s.setResult({ ok: false, error: 'Vehículo y qué se le hizo.' });
          s.run(
            () =>
              save({
                vehicleId: vid,
                date,
                description: desc,
                kind,
                odometerKm: readNumber(odo),
                cost: readNumber(cost) ?? 0,
                vendor: vendor.trim() || null,
                plan: plan || null,
              }),
            onClose,
          );
        }}
      />
    </Modal>
  );
}

function PlanDialog({
  choices,
  vehicleId,
  onClose,
  save,
}: {
  choices: FleetChoices;
  vehicleId?: string;
  onClose: () => void;
  save: FleetHandlers['savePlan'];
}) {
  const s = useSave();
  const [vid, setVid] = useState(vehicleId ?? choices.vehicles[0]?.value ?? '');
  const [task, setTask] = useState('');
  const [everyKm, setEveryKm] = useState('');
  const [everyDays, setEveryDays] = useState('');
  const [lastKm, setLastKm] = useState('');
  const [lastOn, setLastOn] = useState('');
  return (
    <Modal
      title="Plan de mantenimiento"
      subtitle="Cada cuántos km, cada cuántos días, o lo que llegue primero."
      onClose={onClose}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vehículo" wide>
          <VehicleSelect choices={choices} value={vid} onChange={setVid} />
        </Field>
        <Field label="Qué" wide>
          <input
            className={FIELD}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Cambio de aceite y filtros"
          />
        </Field>
        <Field label="Cada cuántos km">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={everyKm}
            onChange={(e) => setEveryKm(e.target.value)}
            placeholder="5.000"
          />
        </Field>
        <Field label="Cada cuántos días">
          <input
            className={NUMBER_FIELD}
            inputMode="numeric"
            value={everyDays}
            onChange={(e) => setEveryDays(e.target.value)}
            placeholder="180"
          />
        </Field>
        <Field label="Última vez (km)">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={lastKm}
            onChange={(e) => setLastKm(e.target.value)}
          />
        </Field>
        <Field label="Última vez (día)">
          <input
            className={FIELD}
            type="date"
            value={lastOn}
            onChange={(e) => setLastOn(e.target.value)}
          />
        </Field>
      </div>
      <Footer
        onClose={onClose}
        pending={s.pending}
        result={s.result}
        label="Guardar"
        onSave={() => {
          const km = readNumber(everyKm);
          const days = readNumber(everyDays);
          s.run(
            () =>
              save({
                vehicleId: vid,
                task,
                everyKm: km ? Math.round(km) : null,
                everyDays: days ? Math.round(days) : null,
                lastDoneKm: readNumber(lastKm),
                lastDoneOn: lastOn || null,
              }),
            onClose,
          );
        }}
      />
    </Modal>
  );
}

function TripDialog({
  choices,
  today,
  onClose,
  save,
  estimate,
}: {
  choices: FleetChoices;
  today: string;
  onClose: () => void;
  save: FleetHandlers['createTrip'];
  estimate: FleetHandlers['estimateRoute'];
}) {
  const s = useSave();
  const [vid, setVid] = useState(choices.vehicles[0]?.value ?? '');
  const [date, setDate] = useState(today);
  const [driverId, setDriverId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [stops, setStops] = useState<string[]>(['', '']);
  const [planned, setPlanned] = useState('');
  const [plannedSource, setPlannedSource] = useState<'manual' | 'proveedor' | null>(null);
  const [guides, setGuides] = useState('');
  const [tolls, setTolls] = useState('');
  const [status, setStatus] = useState<'planeado' | 'en_ruta' | 'completado'>('planeado');
  const [kmReal, setKmReal] = useState('');
  const [estimating, startEstimate] = useTransition();
  const [estimateNote, setEstimateNote] = useState<string | null>(null);

  const move = (i: number, d: -1 | 1) =>
    setStops((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j] as string, next[i] as string];
      return next;
    });
  const filled = stops.map((x) => x.trim()).filter(Boolean);

  return (
    <Modal
      title="Planear recorrido"
      subtitle="Las paradas en el orden en que se hacen. El primero es el origen y el último, el destino."
      onClose={onClose}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vehículo">
          <select className={FIELD} value={vid} onChange={(e) => setVid(e.target.value)}>
            <option value="">Sin vehículo de la flota</option>
            {choices.vehicles.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Día">
          <input
            className={FIELD}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Conductor">
          <select className={FIELD} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Sin cuenta / escribir nombre</option>
            {choices.people.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {!driverId && (
          <Field label="Nombre del conductor">
            <input
              className={FIELD}
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
            />
          </Field>
        )}
      </div>

      <fieldset className="mt-5 rounded-sm border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-ink-muted">Paradas en orden</legend>
        <ol className="space-y-2">
          {stops.map((stop, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: el orden ES la identidad de una parada.
            <li key={i} className="flex items-center gap-2">
              <span
                className={clsx(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full text-micro font-bold',
                  i === 0
                    ? 'bg-primary text-white'
                    : i === stops.length - 1
                      ? 'bg-ink text-surface'
                      : 'bg-surface-2 text-ink-muted',
                )}
              >
                {i === 0 ? <MapPin className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              <input
                className={FIELD}
                value={stop}
                placeholder={
                  i === 0
                    ? 'Origen: Bodega, Cra 68 # 13-45, Bogotá'
                    : i === stops.length - 1
                      ? 'Destino'
                      : 'Parada'
                }
                onChange={(e) => setStops((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={`Parada ${i + 1}`}
              />
              <button
                type="button"
                className="rounded-pill p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
                onClick={() => move(i, -1)}
                aria-label="Subir"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded-pill p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
                onClick={() => move(i, 1)}
                aria-label="Bajar"
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </button>
              {stops.length > 2 && (
                <button
                  type="button"
                  className="rounded-pill p-1.5 text-ink-faint hover:bg-surface-2 hover:text-rose"
                  onClick={() => setStops((l) => l.filter((_, j) => j !== i))}
                  aria-label="Quitar"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setStops((l) => [...l.slice(0, -1), '', l[l.length - 1] ?? ''])}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Parada intermedia
          </Button>
          {choices.routeProvider ? (
            <Button
              variant="outline"
              disabled={filled.length < 2 || estimating}
              onClick={() =>
                startEstimate(async () => {
                  const r = await estimate(filled);
                  if (r.ok) {
                    setPlanned(String(r.km));
                    setPlannedSource('proveedor');
                    setEstimateNote(
                      `${r.km.toLocaleString('es-CO')} km${r.minutes ? ` · unas ${Math.round(r.minutes / 6) / 10} h` : ''}`,
                    );
                  } else setEstimateNote(r.error);
                })
              }
            >
              {estimating ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Calculator className="h-4 w-4" aria-hidden />
              )}
              Calcular km
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">
              Sin proveedor de rutas configurado: escribe los km.
            </span>
          )}
          {estimateNote && <span className="text-xs text-ink-muted">{estimateNote}</span>}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Km planeados">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={planned}
            onChange={(e) => {
              setPlanned(e.target.value);
              setPlannedSource('manual');
            }}
          />
        </Field>
        <Field label="Peajes">
          <input
            className={NUMBER_FIELD}
            inputMode="decimal"
            value={tolls}
            onChange={(e) => setTolls(e.target.value)}
          />
        </Field>
        <Field label="Estado">
          <select
            className={FIELD}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="planeado">Planeado</option>
            <option value="en_ruta">En ruta</option>
            <option value="completado">Completado</option>
          </select>
        </Field>
        {status === 'completado' && (
          <Field label="Km reales">
            <input
              className={NUMBER_FIELD}
              inputMode="decimal"
              value={kmReal}
              onChange={(e) => setKmReal(e.target.value)}
            />
          </Field>
        )}
        <Field label="Guías que lleva (separadas por coma)" wide>
          <input
            className={FIELD}
            value={guides}
            onChange={(e) => setGuides(e.target.value)}
            placeholder="1023, 1024"
          />
        </Field>
      </div>

      <Footer
        onClose={onClose}
        pending={s.pending}
        result={s.result}
        label="Guardar recorrido"
        onSave={() => {
          if (filled.length < 1)
            return s.setResult({ ok: false, error: 'Escribe al menos el origen o el destino.' });
          const p = readNumber(planned);
          s.run(
            () =>
              save({
                vehicleId: vid || null,
                date,
                driverUserId: driverId || null,
                driverName: driverName.trim() || null,
                origin: filled[0] ?? null,
                stops: filled.slice(1, -1),
                destination: filled.length > 1 ? (filled[filled.length - 1] ?? null) : null,
                plannedKm: p,
                plannedSource: p !== null ? (plannedSource ?? 'manual') : null,
                guides: guides
                  .split(',')
                  .map((g) => g.trim())
                  .filter(Boolean),
                tolls: readNumber(tolls) ?? 0,
                otherCosts: 0,
                status,
                km: status === 'completado' ? readNumber(kmReal) : null,
                note: null,
              }),
            onClose,
          );
        }}
      />
    </Modal>
  );
}
