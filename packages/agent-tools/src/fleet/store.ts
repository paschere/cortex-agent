import type { SupabaseClient } from '@supabase/supabase-js';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import { DEFAULT_WARN_DAYS, expiryOf, normalizePlate } from '../vehicles/shape';
import type { Expiry } from '../vehicles/shape';
import {
  type CostPerKm,
  type FuelReport,
  type MaintenanceDue,
  type TripFacts,
  fuelReport,
  maintenanceDue,
  round,
  tripCost,
  utilization,
  vehicleCostPerKm,
} from './math';
import {
  DEFAULT_PLANS,
  EVENT_COLUMNS,
  FLEET_VEHICLE_COLUMNS,
  FUEL_COLUMNS,
  type FleetVehicleRow,
  type FuelLogRow,
  type FuelType,
  type MaintenanceEventRow,
  type MaintenanceKind,
  type MaintenancePlanRow,
  PLAN_COLUMNS,
  TRIP_COLUMNS,
  type TripRow,
  type TripStatus,
  type VehicleType,
  num,
  numOrNull,
} from './shape';

/**
 * EL ALMACÉN DE LA FLOTA (migración 0196).
 *
 * `db` es siempre un handle con alcance de empresa. La flota es de la EMPRESA:
 * se leen los vehículos de todos con `in_fleet`, a diferencia de vehicles.*
 * (RUNT/SIMIT), que son las placas que cada persona vigila para sí. Agregar a
 * la flota una placa que alguien ya vigilaba no la duplica: marca esa fila.
 */

export class FleetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetInputError';
  }
}

const IN_CHUNK = 100;
const DAY_MS = 86_400_000;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Vehículos
// ---------------------------------------------------------------------------

export async function listFleetVehicles(db: SupabaseClient): Promise<FleetVehicleRow[]> {
  const { data, error } = await db
    .from('vehicles')
    .select(FLEET_VEHICLE_COLUMNS)
    .eq('in_fleet', true)
    .eq('archived', false)
    .order('plate', { ascending: true });
  if (error) throw error;
  // Dos personas pueden vigilar la misma placa: la flota la muestra una vez.
  const seen = new Set<string>();
  return ((data ?? []) as unknown as FleetVehicleRow[]).filter((v) => {
    if (seen.has(v.plate)) return false;
    seen.add(v.plate);
    return true;
  });
}

/** La placa en la empresa: la de la flota si la hay, si no la de cualquiera. */
export async function findFleetVehicle(
  db: SupabaseClient,
  plateRaw: string,
): Promise<FleetVehicleRow | null> {
  const plate = normalizePlate(plateRaw);
  if (!plate) return null;
  const { data, error } = await db
    .from('vehicles')
    .select(FLEET_VEHICLE_COLUMNS)
    .eq('plate', plate)
    .order('in_fleet', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as unknown as FleetVehicleRow | undefined) ?? null;
}

/**
 * El vehículo de un registro (tanqueo, mantenimiento, recorrido). Una placa
 * que la empresa ya tiene registrada (vehicles.register) y a la que se le
 * anota un tanqueo es, por eso mismo, de la flota: entra a ella.
 */
export async function requireFleetVehicle(
  db: SupabaseClient,
  plate: string,
): Promise<FleetVehicleRow> {
  const v = await findFleetVehicle(db, plate);
  if (!v)
    throw new FleetInputError(
      `${normalizePlate(plate) || plate} no está registrado. Agrégalo en /flota (o regístralo con su placa) y lo sigo con mantenimiento, tanqueos y recorridos.`,
    );
  if (!v.in_fleet) {
    const { error } = await db.from('vehicles').update({ in_fleet: true }).eq('id', v.id);
    if (error) throw error;
    return { ...v, in_fleet: true };
  }
  return v;
}

export interface FleetVehicleInput {
  plate: string;
  label?: string | null;
  vehicleType?: VehicleType | null;
  fuelType?: FuelType | null;
  odometerKm?: number | null;
  tankGallons?: number | null;
  driverUserId?: string | null;
  driverName?: string | null;
  brand?: string | null;
  line?: string | null;
  modelYear?: number | null;
  /** Crear los planes de mantenimiento por defecto. */
  defaultPlans?: boolean;
}

export async function addFleetVehicle(
  db: SupabaseClient,
  input: FleetVehicleInput,
  opts: { userId: string; today: string },
): Promise<{ vehicle: FleetVehicleRow; created: boolean }> {
  const plate = normalizePlate(input.plate);
  if (plate.length < 5 || plate.length > 12)
    throw new FleetInputError('Esa placa no parece válida.');
  const patch: Record<string, unknown> = {
    in_fleet: true,
    archived: false,
    updated_at: new Date().toISOString(),
  };
  if (input.label !== undefined) patch.label = input.label;
  if (input.vehicleType !== undefined) patch.vehicle_type = input.vehicleType;
  if (input.fuelType !== undefined) patch.fuel_type = input.fuelType;
  if (input.tankGallons !== undefined) patch.tank_gallons = input.tankGallons;
  if (input.driverUserId !== undefined) patch.driver_user_id = input.driverUserId;
  if (input.driverName !== undefined) patch.driver_name = input.driverName;
  if (input.brand) patch.brand = input.brand;
  if (input.line) patch.line = input.line;
  if (input.modelYear) patch.model_year = input.modelYear;
  if (input.odometerKm !== undefined && input.odometerKm !== null) {
    patch.odometer_km = input.odometerKm;
    patch.odometer_on = opts.today;
  }
  const existing = await findFleetVehicle(db, plate);
  let vehicle: FleetVehicleRow;
  if (existing) {
    const { data, error } = await db
      .from('vehicles')
      .update(patch)
      .eq('id', existing.id)
      .select(FLEET_VEHICLE_COLUMNS)
      .single();
    if (error) throw error;
    vehicle = data as unknown as FleetVehicleRow;
  } else {
    const { data, error } = await db
      .from('vehicles')
      .insert({ user_id: opts.userId, plate, ...patch })
      .select(FLEET_VEHICLE_COLUMNS)
      .single();
    if (error) throw error;
    vehicle = data as unknown as FleetVehicleRow;
  }
  if (input.defaultPlans) {
    const plans = await listPlans(db, [vehicle.id]);
    if (!plans.length)
      for (const p of DEFAULT_PLANS)
        await savePlan(db, {
          vehicleId: vehicle.id,
          task: p.task,
          everyKm: p.everyKm,
          everyDays: p.everyDays,
          lastDoneKm: numOrNull(vehicle.odometer_km),
          lastDoneOn: opts.today,
        });
  }
  return { vehicle, created: !existing };
}

export async function updateFleetVehicle(
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<FleetVehicleInput, 'plate' | 'defaultPlans'>> & { inFleet?: boolean },
  today: string,
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) row.label = patch.label;
  if (patch.vehicleType !== undefined) row.vehicle_type = patch.vehicleType;
  if (patch.fuelType !== undefined) row.fuel_type = patch.fuelType;
  if (patch.tankGallons !== undefined) row.tank_gallons = patch.tankGallons;
  if (patch.driverUserId !== undefined) row.driver_user_id = patch.driverUserId;
  if (patch.driverName !== undefined) row.driver_name = patch.driverName;
  if (patch.inFleet !== undefined) row.in_fleet = patch.inFleet;
  if (patch.odometerKm !== undefined && patch.odometerKm !== null) {
    row.odometer_km = patch.odometerKm;
    row.odometer_on = today;
  }
  const { error } = await db.from('vehicles').update(row).eq('id', id);
  if (error) throw error;
}

/** El odómetro sólo avanza: una lectura menor (un error de digitación) no lo baja. */
export async function bumpOdometer(
  db: SupabaseClient,
  vehicle: Pick<FleetVehicleRow, 'id' | 'odometer_km'>,
  km: number | null | undefined,
  day: string,
): Promise<void> {
  if (km === null || km === undefined) return;
  const current = numOrNull(vehicle.odometer_km);
  if (current !== null && km <= current) return;
  const { error } = await db
    .from('vehicles')
    .update({ odometer_km: km, odometer_on: day })
    .eq('id', vehicle.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Mantenimiento
// ---------------------------------------------------------------------------

export async function listPlans(
  db: SupabaseClient,
  vehicleIds: readonly string[],
): Promise<MaintenancePlanRow[]> {
  const out: MaintenancePlanRow[] = [];
  for (const part of chunks(vehicleIds, IN_CHUNK)) {
    const { data, error } = await db
      .from('maintenance_plans')
      .select(PLAN_COLUMNS)
      .in('vehicle_id', part)
      .eq('active', true)
      .order('task');
    if (error) throw error;
    out.push(...((data ?? []) as unknown as MaintenancePlanRow[]));
  }
  return out;
}

export async function savePlan(
  db: SupabaseClient,
  input: {
    vehicleId: string;
    task: string;
    everyKm: number | null;
    everyDays: number | null;
    lastDoneKm?: number | null;
    lastDoneOn?: string | null;
  },
): Promise<MaintenancePlanRow> {
  const task = input.task.trim();
  if (!task) throw new FleetInputError('El mantenimiento necesita un nombre.');
  if (!input.everyKm && !input.everyDays)
    throw new FleetInputError('Dime cada cuántos km o cada cuántos días.');
  const { data: rows, error: readErr } = await db
    .from('maintenance_plans')
    .select(PLAN_COLUMNS)
    .eq('vehicle_id', input.vehicleId);
  if (readErr) throw readErr;
  const prior = ((rows ?? []) as unknown as MaintenancePlanRow[]).find(
    (p) => p.task.trim().toLowerCase() === task.toLowerCase(),
  );
  const row: Record<string, unknown> = {
    vehicle_id: input.vehicleId,
    task: task.slice(0, 120),
    every_km: input.everyKm,
    every_days: input.everyDays,
    active: true,
  };
  if (input.lastDoneKm !== undefined) row.last_done_km = input.lastDoneKm;
  if (input.lastDoneOn !== undefined) row.last_done_on = input.lastDoneOn;
  const res = prior
    ? await db
        .from('maintenance_plans')
        .update(row)
        .eq('id', prior.id)
        .select(PLAN_COLUMNS)
        .single()
    : await db.from('maintenance_plans').insert(row).select(PLAN_COLUMNS).single();
  if (res.error) throw res.error;
  return res.data as unknown as MaintenancePlanRow;
}

export async function deactivatePlan(db: SupabaseClient, planId: string): Promise<void> {
  const { error } = await db.from('maintenance_plans').update({ active: false }).eq('id', planId);
  if (error) throw error;
}

export interface MaintenanceInput {
  vehicleId: string;
  kind?: MaintenanceKind;
  description: string;
  doneOn: string;
  odometerKm?: number | null;
  cost?: number | null;
  vendor?: string | null;
  /** El plan que cumple (id o nombre de la tarea): se reinicia su cuenta. */
  plan?: string | null;
}

export async function logMaintenance(
  db: SupabaseClient,
  input: MaintenanceInput,
  opts: { userId: string | null },
): Promise<{ event: MaintenanceEventRow; plan: MaintenancePlanRow | null }> {
  if (!input.description.trim()) throw new FleetInputError('Describe qué se le hizo.');
  const { data: vrow, error: vErr } = await db
    .from('vehicles')
    .select('id, odometer_km')
    .eq('id', input.vehicleId)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!vrow) throw new FleetInputError('Ese vehículo ya no existe.');
  let plan: MaintenancePlanRow | null = null;
  const plans = await listPlans(db, [input.vehicleId]);
  if (input.plan) {
    const key = input.plan.trim().toLowerCase();
    plan =
      plans.find((p) => p.id === input.plan) ??
      plans.find((p) => p.task.toLowerCase() === key) ??
      plans.find((p) => p.task.toLowerCase().includes(key) || key.includes(p.task.toLowerCase())) ??
      null;
  } else {
    // «cambio de aceite» encuentra el plan «Cambio de aceite y filtros».
    const text = input.description.toLowerCase();
    const hits = plans.filter((p) => {
      const head =
        p.task
          .toLowerCase()
          .split(/\s+y\s+|,/)[0]
          ?.trim() ?? '';
      return head.length >= 5 && text.includes(head);
    });
    plan = hits.length === 1 ? (hits[0] as MaintenancePlanRow) : null;
  }
  const { data, error } = await db
    .from('maintenance_events')
    .insert({
      vehicle_id: input.vehicleId,
      plan_id: plan?.id ?? null,
      kind: input.kind ?? (plan ? 'preventivo' : 'correctivo'),
      description: input.description.trim().slice(0, 300),
      done_on: input.doneOn,
      odometer_km: input.odometerKm ?? null,
      cost: round(input.cost ?? 0, 2),
      vendor: input.vendor?.slice(0, 200) ?? null,
      recorded_by: opts.userId,
    })
    .select(EVENT_COLUMNS)
    .single();
  if (error) throw error;
  if (plan) {
    const upd = await db
      .from('maintenance_plans')
      .update({
        last_done_on: input.doneOn,
        last_done_km: input.odometerKm ?? numOrNull((vrow as { odometer_km: unknown }).odometer_km),
      })
      .eq('id', plan.id)
      .select(PLAN_COLUMNS)
      .single();
    if (upd.error) throw upd.error;
    plan = upd.data as unknown as MaintenancePlanRow;
  }
  await bumpOdometer(
    db,
    vrow as { id: string; odometer_km: number | null },
    input.odometerKm,
    input.doneOn,
  );
  return { event: data as unknown as MaintenanceEventRow, plan };
}

// ---------------------------------------------------------------------------
// Combustible
// ---------------------------------------------------------------------------

export interface FuelInput {
  vehicleId: string;
  filledOn: string;
  odometerKm?: number | null;
  gallons: number;
  amount: number;
  fullTank?: boolean;
  station?: string | null;
  driverUserId?: string | null;
  driverName?: string | null;
}

export async function logFuel(
  db: SupabaseClient,
  input: FuelInput,
  opts: { userId: string | null },
): Promise<FuelLogRow> {
  if (!(input.gallons > 0)) throw new FleetInputError('Los galones tienen que ser más que cero.');
  if (!(input.amount >= 0)) throw new FleetInputError('El valor no puede ser negativo.');
  const { data: vrow, error: vErr } = await db
    .from('vehicles')
    .select('id, odometer_km')
    .eq('id', input.vehicleId)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!vrow) throw new FleetInputError('Ese vehículo ya no existe.');
  const { data, error } = await db
    .from('fuel_logs')
    .insert({
      vehicle_id: input.vehicleId,
      filled_on: input.filledOn,
      odometer_km: input.odometerKm ?? null,
      gallons: round(input.gallons, 3),
      amount: round(input.amount, 2),
      full_tank: input.fullTank ?? true,
      station: input.station?.slice(0, 200) ?? null,
      driver_user_id: input.driverUserId ?? null,
      driver_name: input.driverUserId ? null : (input.driverName?.slice(0, 160) ?? null),
      recorded_by: opts.userId,
    })
    .select(FUEL_COLUMNS)
    .single();
  if (error) throw error;
  await bumpOdometer(
    db,
    vrow as { id: string; odometer_km: number | null },
    input.odometerKm,
    input.filledOn,
  );
  return data as unknown as FuelLogRow;
}

// ---------------------------------------------------------------------------
// Recorridos
// ---------------------------------------------------------------------------

export interface TripInput {
  vehicleId?: string | null;
  tripOn: string;
  driverUserId?: string | null;
  driverName?: string | null;
  origin?: string | null;
  destination?: string | null;
  stops?: Array<{ place: string; note?: string | null }>;
  plannedKm?: number | null;
  plannedSource?: 'manual' | 'proveedor' | null;
  startKm?: number | null;
  endKm?: number | null;
  km?: number | null;
  tolls?: number | null;
  otherCosts?: number | null;
  status?: TripStatus;
  guideRefs?: string[];
  salesDocumentId?: string | null;
  projectId?: string | null;
  note?: string | null;
}

function tripRow(input: TripInput): Record<string, unknown> {
  if (input.startKm != null && input.endKm != null && input.endKm < input.startKm)
    throw new FleetInputError('El kilometraje de llegada no puede ser menor que el de salida.');
  return {
    vehicle_id: input.vehicleId ?? null,
    trip_on: input.tripOn,
    driver_user_id: input.driverUserId ?? null,
    driver_name: input.driverUserId ? null : (input.driverName?.slice(0, 160) ?? null),
    origin: input.origin?.slice(0, 300) ?? null,
    destination: input.destination?.slice(0, 300) ?? null,
    stops: (input.stops ?? [])
      .filter((s) => s.place?.trim())
      .slice(0, 50)
      .map((s) => ({ place: s.place.trim().slice(0, 300), note: s.note?.slice(0, 300) ?? null })),
    planned_km: input.plannedKm ?? null,
    planned_source: input.plannedKm != null ? (input.plannedSource ?? 'manual') : null,
    start_km: input.startKm ?? null,
    end_km: input.endKm ?? null,
    km: input.km ?? null,
    tolls: round(input.tolls ?? 0, 2),
    other_costs: round(input.otherCosts ?? 0, 2),
    status: input.status ?? 'planeado',
    guide_refs: (input.guideRefs ?? [])
      .map((g) => g.trim())
      .filter(Boolean)
      .slice(0, 200),
    sales_document_id: input.salesDocumentId ?? null,
    project_id: input.projectId ?? null,
    note: input.note?.slice(0, 1000) ?? null,
  };
}

export async function createTrip(
  db: SupabaseClient,
  input: TripInput,
  opts: { userId: string | null },
): Promise<TripRow> {
  const { data, error } = await db
    .from('trips')
    .insert({ ...tripRow(input), recorded_by: opts.userId })
    .select(TRIP_COLUMNS)
    .single();
  if (error) throw error;
  const trip = data as unknown as TripRow;
  if (trip.vehicle_id && input.endKm != null) {
    const { data: v } = await db
      .from('vehicles')
      .select('id, odometer_km')
      .eq('id', trip.vehicle_id)
      .maybeSingle();
    if (v)
      await bumpOdometer(
        db,
        v as { id: string; odometer_km: number | null },
        input.endKm,
        input.tripOn,
      );
  }
  return trip;
}

export async function updateTrip(
  db: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<TripInput, 'status' | 'endKm' | 'startKm' | 'km' | 'tolls' | 'otherCosts' | 'note'>
  >,
): Promise<TripRow> {
  const row: Record<string, unknown> = {};
  if (patch.status) row.status = patch.status;
  if (patch.startKm !== undefined) row.start_km = patch.startKm;
  if (patch.endKm !== undefined) row.end_km = patch.endKm;
  if (patch.km !== undefined) row.km = patch.km;
  if (patch.tolls !== undefined) row.tolls = patch.tolls ?? 0;
  if (patch.otherCosts !== undefined) row.other_costs = patch.otherCosts ?? 0;
  if (patch.note !== undefined) row.note = patch.note;
  const { data, error } = await db
    .from('trips')
    .update(row)
    .eq('id', id)
    .select(TRIP_COLUMNS)
    .single();
  if (error) throw error;
  const trip = data as unknown as TripRow;
  if (trip.vehicle_id && patch.endKm != null) {
    const { data: v } = await db
      .from('vehicles')
      .select('id, odometer_km')
      .eq('id', trip.vehicle_id)
      .maybeSingle();
    if (v)
      await bumpOdometer(
        db,
        v as { id: string; odometer_km: number | null },
        patch.endKm,
        trip.trip_on,
      );
  }
  return trip;
}

export function tripFacts(t: TripRow): TripFacts {
  return {
    tripOn: String(t.trip_on).slice(0, 10),
    vehicleId: t.vehicle_id,
    status: t.status,
    km: numOrNull(t.km),
    startKm: numOrNull(t.start_km),
    endKm: numOrNull(t.end_km),
    plannedKm: numOrNull(t.planned_km),
    tolls: num(t.tolls),
    otherCosts: num(t.other_costs),
  };
}

// ---------------------------------------------------------------------------
// La foto de la flota
// ---------------------------------------------------------------------------

export interface FleetDocument {
  kind: string;
  expiresOn: string | null;
  status: string;
  needsReview: boolean;
  /** Del RUNT (columnas del vehículo) o de un documento leído (0184). */
  from: 'runt' | 'documento';
  expiry: Expiry;
}

export interface FleetPlanView {
  id: string;
  task: string;
  everyKm: number | null;
  everyDays: number | null;
  lastDoneKm: number | null;
  lastDoneOn: string | null;
  due: MaintenanceDue;
}

export interface FleetVehicleView {
  row: FleetVehicleRow;
  driver: string | null;
  odometerKm: number | null;
  documents: FleetDocument[];
  plans: FleetPlanView[];
  fuel: FuelReport;
  cost: CostPerKm;
  utilization: { daysUsed: number; workingDays: number; pct: number | null };
  fuelLogs: FuelLogRow[];
  events: MaintenanceEventRow[];
  /** Lo más urgente, en palabras, para la lista. */
  attention: string[];
}

export interface FleetOverview {
  vehicles: FleetVehicleView[];
  trips: Array<
    TripRow & { cost: ReturnType<typeof tripCost>; plate: string | null; driver: string | null }
  >;
  period: { from: string; to: string };
  names: Record<string, string>;
}

/** Días hacia atrás que cuentan para costo por km, rendimiento y utilización. */
export const FLEET_PERIOD_DAYS = 90;

export async function loadFleetOverview(
  db: SupabaseClient,
  today: string,
  opts: { periodDays?: number; vehicleIds?: readonly string[] } = {},
): Promise<FleetOverview> {
  const from = addDaysIso(today, -(opts.periodDays ?? FLEET_PERIOD_DAYS));
  let rows = await listFleetVehicles(db);
  if (opts.vehicleIds) rows = rows.filter((r) => opts.vehicleIds?.includes(r.id));
  const ids = rows.map((r) => r.id);
  const people = await listDirectory(db);
  const names = Object.fromEntries(people.map((p) => [p.id, personLabel(p)]));

  const plans = ids.length ? await listPlans(db, ids) : [];
  const fuel: FuelLogRow[] = [];
  const events: MaintenanceEventRow[] = [];
  const docs: Array<{
    vehicle_id: string | null;
    subject_key: string | null;
    kind: string;
    expires_on: string | null;
    status: string;
    needs_review: boolean;
  }> = [];
  for (const part of chunks(ids, IN_CHUNK)) {
    const [f, e] = await Promise.all([
      db
        .from('fuel_logs')
        .select(FUEL_COLUMNS)
        .in('vehicle_id', part)
        .gte('filled_on', from)
        .order('filled_on', { ascending: false }),
      db
        .from('maintenance_events')
        .select(EVENT_COLUMNS)
        .in('vehicle_id', part)
        .order('done_on', { ascending: false })
        .limit(500),
    ]);
    if (f.error) throw f.error;
    if (e.error) throw e.error;
    fuel.push(...((f.data ?? []) as unknown as FuelLogRow[]));
    events.push(...((e.data ?? []) as unknown as MaintenanceEventRow[]));
  }
  if (ids.length) {
    // Sin título ni cita: el espacio del Cerebro decide quién los ve (0184).
    const d = await db
      .from('document_expirations')
      .select('vehicle_id, subject_key, kind, expires_on, status, needs_review')
      .in('kind', ['soat', 'tecnomecanica', 'poliza', 'licencia', 'permiso', 'habilitacion'])
      .not('status', 'in', '(renovado,descartado)')
      .or('subject_kind.eq.vehiculo,vehicle_id.not.is.null')
      .limit(1000);
    if (d.error) throw d.error;
    docs.push(...((d.data ?? []) as typeof docs));
  }
  const tripsRes = await db
    .from('trips')
    .select(TRIP_COLUMNS)
    .or(`trip_on.gte.${from},status.in.(planeado,en_ruta)`)
    .order('trip_on', { ascending: false })
    .limit(500);
  if (tripsRes.error) throw tripsRes.error;
  const trips = (tripsRes.data ?? []) as unknown as TripRow[];

  const views: FleetVehicleView[] = rows.map((v) => {
    const odo = numOrNull(v.odometer_km);
    const vPlans = plans
      .filter((p) => p.vehicle_id === v.id)
      .map((p) => {
        const facts = {
          task: p.task,
          everyKm: p.every_km,
          everyDays: p.every_days,
          lastDoneKm: numOrNull(p.last_done_km),
          lastDoneOn: p.last_done_on,
        };
        return { id: p.id, ...facts, due: maintenanceDue(facts, odo, today) };
      });
    const vFuel = fuel.filter((f) => f.vehicle_id === v.id);
    const vEvents = events.filter((e) => e.vehicle_id === v.id);
    const report = fuelReport(
      vFuel.map((f) => ({
        id: f.id,
        filledOn: String(f.filled_on).slice(0, 10),
        odometerKm: numOrNull(f.odometer_km),
        gallons: num(f.gallons),
        amount: num(f.amount),
        fullTank: f.full_tank,
      })),
      { tankGallons: numOrNull(v.tank_gallons) },
    );
    const vTrips = trips.filter((t) => t.vehicle_id === v.id && String(t.trip_on) >= from);
    const readings = [
      ...vFuel.map((f) => numOrNull(f.odometer_km)),
      ...vEvents.filter((e) => String(e.done_on) >= from).map((e) => numOrNull(e.odometer_km)),
    ].filter((n): n is number => n !== null);
    const cost = vehicleCostPerKm({
      fuelAmount: vFuel.reduce((s, f) => s + num(f.amount), 0),
      maintenanceAmount: vEvents
        .filter((e) => String(e.done_on) >= from)
        .reduce((s, e) => s + num(e.cost), 0),
      trips: vTrips.map(tripFacts),
      odometerReadings: readings,
    });
    const use = utilization(
      vTrips.filter((t) => t.status !== 'cancelado').map((t) => String(t.trip_on)),
      addDaysIso(today, -29),
      today,
    );
    const plateKey = v.plate.toLowerCase();
    const documents: FleetDocument[] = [
      {
        kind: 'soat',
        expiresOn: v.soat_expires_at,
        status: '',
        needsReview: false,
        from: 'runt' as const,
        expiry: expiryOf(v.soat_expires_at, new Date(`${today}T12:00:00Z`), DEFAULT_WARN_DAYS),
      },
      {
        kind: 'tecnomecanica',
        expiresOn: v.rtm_expires_at,
        status: '',
        needsReview: false,
        from: 'runt' as const,
        expiry: expiryOf(v.rtm_expires_at, new Date(`${today}T12:00:00Z`), DEFAULT_WARN_DAYS),
      },
    ];
    for (const d of docs) {
      if (d.vehicle_id !== v.id && d.subject_key !== plateKey) continue;
      const exp = expiryOf(d.expires_on, new Date(`${today}T12:00:00Z`), DEFAULT_WARN_DAYS);
      const sameRunt = documents.find((x) => x.from === 'runt' && x.kind === d.kind);
      // Un documento leído con fecha confirmada completa (o corrige) lo del RUNT
      // cuando éste no tiene fecha.
      if (sameRunt && !sameRunt.expiresOn && d.expires_on && !d.needs_review) {
        Object.assign(sameRunt, {
          expiresOn: d.expires_on,
          from: 'documento',
          expiry: exp,
          status: d.status,
        });
        continue;
      }
      if (sameRunt?.expiresOn) continue;
      documents.push({
        kind: d.kind,
        expiresOn: d.expires_on,
        status: d.status,
        needsReview: d.needs_review,
        from: 'documento',
        expiry: exp,
      });
    }
    const attention: string[] = [];
    for (const d of documents) {
      const label =
        d.kind === 'soat'
          ? 'SOAT'
          : d.kind === 'tecnomecanica'
            ? 'Tecnomecánica'
            : d.kind === 'poliza'
              ? 'Póliza'
              : d.kind;
      if (d.expiry.status === 'expired') attention.push(`${label} vencido`);
      else if (d.expiry.status === 'expiring')
        attention.push(`${label} vence en ${d.expiry.daysLeft} días`);
    }
    for (const p of vPlans) {
      if (p.due.status === 'vencido') attention.push(`${p.task}: vencido`);
      else if (p.due.status === 'pronto') attention.push(`${p.task}: toca pronto`);
    }
    const recentAnomalies = report.anomalies.filter((a) => a.filledOn >= addDaysIso(today, -30));
    if (recentAnomalies.length) attention.push('Consumo de combustible raro');
    if (num(v.total_pending_cop) > 0) attention.push('Comparendos pendientes');
    return {
      row: v,
      driver: v.driver_user_id ? (names[v.driver_user_id] ?? v.driver_name) : v.driver_name,
      odometerKm: odo,
      documents,
      plans: vPlans,
      fuel: report,
      cost,
      utilization: use,
      fuelLogs: vFuel,
      events: vEvents,
      attention,
    };
  });

  const perKm = new Map(views.map((v) => [v.row.id, v.cost.perKm]));
  const plates = new Map(rows.map((r) => [r.id, r.plate]));
  return {
    vehicles: views,
    trips: trips.map((t) => ({
      ...t,
      cost: tripCost(tripFacts(t), t.vehicle_id ? (perKm.get(t.vehicle_id) ?? null) : null),
      plate: t.vehicle_id ? (plates.get(t.vehicle_id) ?? null) : null,
      driver: t.driver_user_id ? (names[t.driver_user_id] ?? t.driver_name) : t.driver_name,
    })),
    period: { from, to: today },
    names,
  };
}
