import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import {
  FUEL_ANOMALY_LABEL,
  FUEL_TYPES,
  FUEL_TYPE_LABEL,
  type FleetOverview,
  type FleetVehicleView,
  MAINTENANCE_KINDS,
  MAINTENANCE_KIND_LABEL,
  MAINTENANCE_STATUS_LABEL,
  type MaintenanceStatus,
  TRIP_STATUSES,
  TRIP_STATUS_LABEL,
  TRIP_STATUS_TONE,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABEL,
  formatFleetCop,
  formatFleetKm,
} from '@cortex/agent-tools';
import { shortDay } from '../projects/views';
import type {
  AnomalyView,
  EventRowView,
  FleetChoices,
  FuelRowView,
  FuelSummaryView,
  Option,
  PlanRowView,
  Tile,
  Tone,
  VehicleCardView,
} from './shape';

/**
 * DE LOS HECHOS A LO QUE SE DIBUJA EN /flota (migración 0196). Sólo servidor.
 */

const cop = formatFleetCop;
const km = formatFleetKm;

const STATUS_TONE: Record<MaintenanceStatus, Tone> = {
  vencido: 'rose',
  pronto: 'amber',
  al_dia: 'emerald',
  sin_base: 'neutral',
};

const DOC_LABEL: Record<string, string> = {
  soat: 'SOAT',
  tecnomecanica: 'Tecnomecánica',
  poliza: 'Póliza',
  licencia: 'Licencia',
  permiso: 'Permiso',
  habilitacion: 'Habilitación',
};

function simitPrompt(plate: string): string {
  return `/chat?prompt=${encodeURIComponent(
    `Consulta los comparendos de la placa ${plate} en el SIMIT (vehicles.check_simit). Si el servicio de consulta no está conectado, usa el trámite aprendido del SIMIT (browser.list_flows) y dime qué encontraste.`,
  )}`;
}

function vehicleName(v: FleetVehicleView): string {
  return v.row.label ? `${v.row.plate} · ${v.row.label}` : v.row.plate;
}

export function vehicleCards(o: FleetOverview): VehicleCardView[] {
  return o.vehicles.map((v) => {
    const r = v.row;
    return {
      id: r.id,
      plate: r.plate,
      label: r.label,
      model: [r.brand, r.line, r.model_year].filter(Boolean).join(' ') || null,
      typeLabel: r.vehicle_type ? VEHICLE_TYPE_LABEL[r.vehicle_type] : null,
      fuelLabel: r.fuel_type ? FUEL_TYPE_LABEL[r.fuel_type] : null,
      driver: v.driver,
      odometer: v.odometerKm !== null ? km(v.odometerKm) : null,
      odometerOn: shortDay(r.odometer_on),
      docs: v.documents.map((d) => ({
        label: DOC_LABEL[d.kind] ?? d.kind,
        value:
          d.expiry.status === 'unknown'
            ? 'sin dato'
            : d.expiry.status === 'expired'
              ? `vencido ${shortDay(d.expiresOn)}`
              : `${d.expiry.status === 'expiring' ? 'vence' : 'hasta'} ${shortDay(d.expiresOn)}`,
        tone:
          d.expiry.status === 'expired'
            ? 'rose'
            : d.expiry.status === 'expiring'
              ? 'amber'
              : d.expiry.status === 'valid'
                ? 'emerald'
                : 'neutral',
      })),
      attention: v.attention,
      kmPerGallon:
        v.fuel.kmPerGallon !== null ? `${v.fuel.kmPerGallon.toLocaleString('es-CO')} km/gal` : null,
      costPerKm: v.cost.perKm !== null ? `${cop(v.cost.perKm)}/km` : null,
      km90: km(v.cost.km),
      utilization:
        v.utilization.pct !== null ? `${v.utilization.pct.toLocaleString('es-CO')} %` : null,
      pendingFines: Number(r.total_pending_cop) > 0 ? cop(Number(r.total_pending_cop)) : null,
      simitHref: simitPrompt(r.plate),
      plans: v.plans.map((p) => ({ value: p.id, label: p.task })),
      edit: {
        vehicleType: r.vehicle_type ?? '',
        fuelType: r.fuel_type ?? '',
        tankGallons: r.tank_gallons !== null ? String(r.tank_gallons) : '',
        driverUserId: r.driver_user_id ?? '',
        driverName: r.driver_user_id ? '' : (r.driver_name ?? ''),
        odometerKm: r.odometer_km !== null ? String(r.odometer_km) : '',
        label: r.label ?? '',
      },
    };
  });
}

export function fleetTiles(o: FleetOverview): Tile[] {
  const docsBad = o.vehicles.flatMap((v) =>
    v.documents.filter((d) => d.expiry.status === 'expired' || d.expiry.status === 'expiring'),
  );
  const expired = docsBad.filter((d) => d.expiry.status === 'expired').length;
  const plans = o.vehicles.flatMap((v) => v.plans);
  const overdue = plans.filter((p) => p.due.status === 'vencido').length;
  const soon = plans.filter((p) => p.due.status === 'pronto').length;
  const anomalies = o.vehicles.reduce((s, v) => s + v.fuel.anomalies.length, 0);
  const totalKm = o.vehicles.reduce((s, v) => s + v.cost.km, 0);
  const totalCost = o.vehicles.reduce((s, v) => s + (v.cost.perKm !== null ? v.cost.total : 0), 0);
  const kmWithCost = o.vehicles.reduce((s, v) => s + (v.cost.perKm !== null ? v.cost.km : 0), 0);
  return [
    {
      label: 'Vehículos',
      value: String(o.vehicles.length),
      note: `${km(totalKm)} en 90 días`,
      tone: 'primary',
    },
    {
      label: 'Documentos',
      value: docsBad.length ? String(docsBad.length) : 'Al día',
      note: docsBad.length
        ? `${expired} vencidos, ${docsBad.length - expired} por vencer`
        : 'SOAT, tecnomecánica y pólizas',
      tone: expired ? 'rose' : docsBad.length ? 'amber' : 'emerald',
    },
    {
      label: 'Mantenimiento',
      value: overdue + soon ? String(overdue + soon) : 'Al día',
      note: overdue + soon ? `${overdue} vencidos, ${soon} pronto` : 'Nada toca todavía',
      tone: overdue ? 'rose' : soon ? 'amber' : 'emerald',
    },
    {
      label: 'Consumo raro',
      value: String(anomalies),
      note: anomalies ? 'Tanqueos fuera de lo normal' : 'Rendimiento normal',
      tone: anomalies ? 'amber' : 'neutral',
    },
    {
      label: 'Costo por km',
      value: kmWithCost > 0 ? cop(totalCost / kmWithCost) : '—',
      note:
        kmWithCost > 0 ? 'Combustible + mantenimiento + peajes' : 'Faltan tanqueos con kilometraje',
      tone: 'neutral',
    },
  ];
}

export function planRows(o: FleetOverview): PlanRowView[] {
  const rank: Record<MaintenanceStatus, number> = { vencido: 0, pronto: 1, sin_base: 2, al_dia: 3 };
  return o.vehicles
    .flatMap((v) =>
      v.plans.map((p) => ({
        id: p.id,
        vehicleId: v.row.id,
        plate: vehicleName(v),
        task: p.task,
        every: [
          p.everyKm ? `cada ${km(p.everyKm)}` : null,
          p.everyDays ? `cada ${p.everyDays} días` : null,
        ]
          .filter(Boolean)
          .join(' o '),
        last:
          [
            p.lastDoneOn ? shortDay(p.lastDoneOn) : null,
            p.lastDoneKm !== null ? km(p.lastDoneKm) : null,
          ]
            .filter(Boolean)
            .join(' · ') || '—',
        status: MAINTENANCE_STATUS_LABEL[p.due.status],
        statusTone: STATUS_TONE[p.due.status],
        reason: p.due.reason,
        rank: rank[p.due.status],
      })),
    )
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...rest }) => rest);
}

export function eventRows(o: FleetOverview): EventRowView[] {
  return o.vehicles
    .flatMap((v) =>
      v.events.map((e) => ({
        id: e.id,
        plate: v.row.plate,
        date: String(e.done_on),
        kind: MAINTENANCE_KIND_LABEL[e.kind],
        description: e.description,
        km: e.odometer_km !== null ? km(Number(e.odometer_km)) : null,
        cost: cop(Number(e.cost)),
        vendor: e.vendor,
      })),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40)
    .map((e) => ({ ...e, date: shortDay(e.date) ?? e.date }));
}

export function fuelRows(o: FleetOverview): FuelRowView[] {
  return o.vehicles
    .flatMap((v) => {
      const seg = new Map(v.fuel.segments.map((s) => [s.logId, s]));
      const bad = new Map(v.fuel.anomalies.map((a) => [a.logId, a]));
      return v.fuelLogs.map((f) => ({
        id: f.id,
        plate: v.row.plate,
        sortDate: String(f.filled_on),
        date: shortDay(String(f.filled_on)) ?? String(f.filled_on),
        gallons: Number(f.gallons).toLocaleString('es-CO', { maximumFractionDigits: 2 }),
        amount: cop(Number(f.amount)),
        km: f.odometer_km !== null ? km(Number(f.odometer_km)) : null,
        kmPerGallon: seg.get(f.id) ? `${seg.get(f.id)?.kmPerGallon.toLocaleString('es-CO')}` : null,
        full: f.full_tank,
        anomaly: bad.get(f.id)
          ? FUEL_ANOMALY_LABEL[bad.get(f.id)?.kind ?? 'rendimiento_bajo']
          : null,
      }));
    })
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
    .slice(0, 60)
    .map(({ sortDate: _s, ...rest }) => rest);
}

export function fuelSummaries(o: FleetOverview): FuelSummaryView[] {
  return o.vehicles.map((v) => ({
    plate: vehicleName(v),
    kmPerGallon:
      v.fuel.kmPerGallon !== null ? `${v.fuel.kmPerGallon.toLocaleString('es-CO')} km/gal` : null,
    median:
      v.fuel.medianKmPerGallon !== null
        ? `${v.fuel.medianKmPerGallon.toLocaleString('es-CO')} km/gal`
        : null,
    costPerKm: v.cost.perKm !== null ? `${cop(v.cost.perKm)}/km` : null,
    anomalies: v.fuel.anomalies.length,
    withoutOdometer: v.fuel.withoutOdometer,
  }));
}

export function anomalyViews(o: FleetOverview): AnomalyView[] {
  return o.vehicles
    .flatMap((v) =>
      v.fuel.anomalies.map((a) => ({
        plate: v.row.plate,
        date: a.filledOn,
        label: FUEL_ANOMALY_LABEL[a.kind],
        message: a.message,
      })),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map((a) => ({ ...a, date: shortDay(a.date) ?? a.date }));
}

// ---------------------------------------------------------------------------
// Recorridos (DataGrid)
// ---------------------------------------------------------------------------

export function tripColumns(o: FleetOverview): GridColumn[] {
  return [
    { key: 'fecha', label: 'Fecha', type: 'date', width: 132, editable: true },
    { key: 'ruta', label: 'Ruta', type: 'text', width: 300, primary: true, pinned: true },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      editable: true,
      width: 130,
      options: TRIP_STATUSES.map((s) => ({
        value: s,
        label: TRIP_STATUS_LABEL[s],
        tone: TRIP_STATUS_TONE[s],
      })),
    },
    {
      key: 'vehiculo',
      label: 'Vehículo',
      type: 'select',
      width: 120,
      options: o.vehicles.map((v) => ({ value: v.row.id, label: v.row.plate })),
    },
    { key: 'conductor', label: 'Conductor', type: 'text', width: 150 },
    {
      key: 'km',
      label: 'Km',
      type: 'number',
      editable: true,
      width: 90,
      description: 'Reales; sin ellos, los del odómetro o los planeados.',
    },
    { key: 'planeados', label: 'Km planeados', type: 'number', width: 120 },
    { key: 'peajes', label: 'Peajes', type: 'money', editable: true, width: 120 },
    { key: 'viaticos', label: 'Viáticos', type: 'money', editable: true, width: 120 },
    {
      key: 'costo',
      label: 'Costo',
      type: 'money',
      width: 130,
      description: 'Km × costo por km del vehículo + peajes y viáticos.',
    },
    { key: 'guias', label: 'Guías', type: 'text', width: 160 },
  ];
}

export function tripRows(o: FleetOverview): GridRow[] {
  return o.trips.map((t) => {
    const places = [t.origin, ...(t.stops ?? []).map((s) => s.place), t.destination].filter(
      Boolean,
    );
    return {
      id: t.id,
      values: {
        fecha: String(t.trip_on).slice(0, 10),
        ruta: places.length ? places.join(' → ') : 'Sin ruta',
        estado: t.status,
        vehiculo: t.vehicle_id,
        conductor: t.driver,
        km:
          t.km !== null
            ? Number(t.km)
            : t.start_km !== null && t.end_km !== null
              ? Number(t.end_km) - Number(t.start_km)
              : null,
        planeados: t.planned_km !== null ? Number(t.planned_km) : null,
        peajes: Number(t.tolls) || null,
        viaticos: Number(t.other_costs) || null,
        costo: t.cost.total,
        guias: (t.guide_refs ?? []).join(', ') || null,
      },
    };
  });
}

export function tripPresets(): Array<{ id: string; label: string; view: Partial<GridView> }> {
  return [
    {
      id: 'lista',
      label: 'Lista',
      view: { layout: 'table', filters: [], sort: [{ key: 'fecha', dir: 'desc' }] },
    },
    {
      id: 'pendientes',
      label: 'Planeados y en ruta',
      view: {
        layout: 'table',
        filters: [{ key: 'estado', op: 'in', value: ['planeado', 'en_ruta'] }],
        sort: [{ key: 'fecha', dir: 'asc' }],
      },
    },
    {
      id: 'calendario',
      label: 'Calendario',
      view: { layout: 'calendar', layoutKey: 'fecha', filters: [], sort: [] },
    },
  ];
}

export function fleetChoices(o: FleetOverview, routeProvider: boolean): FleetChoices {
  const opt = (value: string, label: string): Option => ({ value, label });
  return {
    vehicles: o.vehicles.map((v) => opt(v.row.id, vehicleName(v))),
    people: Object.entries(o.names).map(([id, name]) => opt(id, name)),
    vehicleTypes: VEHICLE_TYPES.map((t) => opt(t, VEHICLE_TYPE_LABEL[t])),
    fuelTypes: FUEL_TYPES.map((t) => opt(t, FUEL_TYPE_LABEL[t])),
    maintenanceKinds: MAINTENANCE_KINDS.map((k) => opt(k, MAINTENANCE_KIND_LABEL[k])),
    routeProvider,
  };
}
