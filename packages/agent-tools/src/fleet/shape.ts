/**
 * EL VOCABULARIO DE LA FLOTA (migración 0196).
 *
 * Los vehículos son los de `vehicles` (0054) con las columnas de flota; las
 * placas, el RUNT y el SIMIT siguen en ../vehicles. Aquí: tipos, combustibles,
 * mantenimientos, recorridos y las filas que se leen.
 */

export const VEHICLE_TYPES = [
  'carro',
  'camioneta',
  'camion',
  'tractomula',
  'moto',
  'furgon',
  'bus',
  'otro',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = {
  carro: 'Carro',
  camioneta: 'Camioneta',
  camion: 'Camión',
  tractomula: 'Tractomula',
  moto: 'Moto',
  furgon: 'Furgón',
  bus: 'Bus',
  otro: 'Otro',
};

export const FUEL_TYPES = ['gasolina', 'diesel', 'gas', 'electrico', 'hibrido'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const FUEL_TYPE_LABEL: Record<FuelType, string> = {
  gasolina: 'Gasolina',
  diesel: 'ACPM (diésel)',
  gas: 'Gas natural',
  electrico: 'Eléctrico',
  hibrido: 'Híbrido',
};

export const MAINTENANCE_KINDS = [
  'preventivo',
  'correctivo',
  'llantas',
  'revision',
  'otro',
] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_KIND_LABEL: Record<MaintenanceKind, string> = {
  preventivo: 'Preventivo',
  correctivo: 'Correctivo',
  llantas: 'Llantas',
  revision: 'Revisión',
  otro: 'Otro',
};

export const TRIP_STATUSES = ['planeado', 'en_ruta', 'completado', 'cancelado'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TRIP_STATUS_LABEL: Record<TripStatus, string> = {
  planeado: 'Planeado',
  en_ruta: 'En ruta',
  completado: 'Completado',
  cancelado: 'Cancelado',
};

export type FleetTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export const TRIP_STATUS_TONE: Record<TripStatus, FleetTone> = {
  planeado: 'neutral',
  en_ruta: 'primary',
  completado: 'emerald',
  cancelado: 'rose',
};

/** Planes de mantenimiento que se ofrecen al agregar un vehículo. */
export const DEFAULT_PLANS: Array<{
  task: string;
  everyKm: number | null;
  everyDays: number | null;
}> = [
  { task: 'Cambio de aceite y filtros', everyKm: 5000, everyDays: 180 },
  { task: 'Revisión de frenos', everyKm: 20_000, everyDays: 365 },
  { task: 'Rotación y revisión de llantas', everyKm: 10_000, everyDays: null },
  { task: 'Revisión general', everyKm: null, everyDays: 365 },
];

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export const FLEET_VEHICLE_COLUMNS =
  'id, user_id, plate, label, brand, line, model_year, notes, runt_estado, soat_expires_at, rtm_expires_at, last_runt_sync, last_simit_sync, total_pending_cop, archived, in_fleet, vehicle_type, fuel_type, odometer_km, odometer_on, tank_gallons, driver_user_id, driver_name, created_at';

export interface FleetVehicleRow {
  id: string;
  user_id: string;
  plate: string;
  label: string | null;
  brand: string | null;
  line: string | null;
  model_year: number | null;
  notes: string | null;
  runt_estado: string | null;
  soat_expires_at: string | null;
  rtm_expires_at: string | null;
  last_runt_sync: string | null;
  last_simit_sync: string | null;
  total_pending_cop: number | string | null;
  archived: boolean | null;
  in_fleet: boolean;
  vehicle_type: VehicleType | null;
  fuel_type: FuelType | null;
  odometer_km: number | string | null;
  odometer_on: string | null;
  tank_gallons: number | string | null;
  driver_user_id: string | null;
  driver_name: string | null;
  created_at: string;
}

export const PLAN_COLUMNS =
  'id, vehicle_id, task, every_km, every_days, last_done_km, last_done_on, active';

export interface MaintenancePlanRow {
  id: string;
  vehicle_id: string;
  task: string;
  every_km: number | null;
  every_days: number | null;
  last_done_km: number | string | null;
  last_done_on: string | null;
  active: boolean;
}

export const EVENT_COLUMNS =
  'id, vehicle_id, plan_id, kind, description, done_on, odometer_km, cost, vendor, created_at';

export interface MaintenanceEventRow {
  id: string;
  vehicle_id: string;
  plan_id: string | null;
  kind: MaintenanceKind;
  description: string;
  done_on: string;
  odometer_km: number | string | null;
  cost: number | string;
  vendor: string | null;
  created_at: string;
}

export const FUEL_COLUMNS =
  'id, vehicle_id, filled_on, odometer_km, gallons, amount, full_tank, station, driver_user_id, driver_name, created_at';

export interface FuelLogRow {
  id: string;
  vehicle_id: string;
  filled_on: string;
  odometer_km: number | string | null;
  gallons: number | string;
  amount: number | string;
  full_tank: boolean;
  station: string | null;
  driver_user_id: string | null;
  driver_name: string | null;
  created_at: string;
}

export const TRIP_COLUMNS =
  'id, vehicle_id, trip_on, driver_user_id, driver_name, origin, destination, stops, planned_km, planned_source, start_km, end_km, km, tolls, other_costs, status, guide_refs, sales_document_id, project_id, note, created_at';

export interface TripRow {
  id: string;
  vehicle_id: string | null;
  trip_on: string;
  driver_user_id: string | null;
  driver_name: string | null;
  origin: string | null;
  destination: string | null;
  stops: Array<{ place: string; note?: string | null }> | null;
  planned_km: number | string | null;
  planned_source: 'manual' | 'proveedor' | null;
  start_km: number | string | null;
  end_km: number | string | null;
  km: number | string | null;
  tolls: number | string;
  other_costs: number | string;
  status: TripStatus;
  guide_refs: string[] | null;
  sales_document_id: string | null;
  project_id: string | null;
  note: string | null;
  created_at: string;
}

export function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('es-CO')} km`;
}

export function formatCop(amount: number): string {
  return `$ ${Math.round(amount).toLocaleString('es-CO')}`;
}
