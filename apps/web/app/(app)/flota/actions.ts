'use server';

import type {
  ActionResult,
  FuelInputView,
  MaintenanceInputView,
  NewVehicleInput,
  PlanInputView,
  RouteEstimateView,
  TripInputView,
} from '@/lib/fleet/shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  FUEL_TYPES,
  type FuelType,
  MAINTENANCE_KINDS,
  type MaintenanceKind,
  TRIP_STATUSES,
  type TripStatus,
  VEHICLE_TYPES,
  type VehicleType,
  addFleetVehicle,
  bogotaToday,
  createTrip,
  estimateRouteKm,
  logFuel,
  logMaintenance,
  saveMaintenancePlan,
  updateFleetVehicle,
  updateTrip,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /flota (migración 0196). Todo con el handle de la
 * empresa de la sesión y el almacén del paquete, que valida placas, km y
 * montos. El odómetro sólo avanza; un plan de mantenimiento se reinicia al
 * registrar lo hecho.
 */

const PATH = '/flota';

function fail(err: unknown, fallback: string): ActionResult {
  const message = err instanceof Error ? err.message : '';
  return { ok: false, error: message && message.length < 240 ? message : fallback };
}

async function session() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id), today: bogotaToday() };
}

const vehicleType = (v: string | null): VehicleType | null =>
  v && (VEHICLE_TYPES as readonly string[]).includes(v) ? (v as VehicleType) : null;
const fuelType = (v: string | null): FuelType | null =>
  v && (FUEL_TYPES as readonly string[]).includes(v) ? (v as FuelType) : null;

export async function addVehicleAction(input: NewVehicleInput): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const { vehicle, created } = await addFleetVehicle(
      db,
      {
        plate: input.plate,
        label: input.label,
        vehicleType: vehicleType(input.vehicleType),
        fuelType: fuelType(input.fuelType),
        odometerKm: input.odometerKm,
        tankGallons: input.tankGallons,
        driverUserId: input.driverUserId,
        driverName: input.driverUserId ? null : input.driverName,
        defaultPlans: input.defaultPlans,
      },
      { userId: user.id, today },
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note: created
        ? `${vehicle.plate} quedó en la flota.`
        : `${vehicle.plate} ya estaba registrado: lo pasé a la flota con estos datos.`,
    };
  } catch (err) {
    return fail(err, 'No pude agregar el vehículo.');
  }
}

export async function updateVehicleAction(
  id: string,
  input: Omit<NewVehicleInput, 'plate' | 'defaultPlans'> & { inFleet?: boolean },
): Promise<ActionResult> {
  const { db, today } = await session();
  try {
    await updateFleetVehicle(
      db,
      id,
      {
        label: input.label,
        vehicleType: vehicleType(input.vehicleType),
        fuelType: fuelType(input.fuelType),
        tankGallons: input.tankGallons,
        driverUserId: input.driverUserId,
        driverName: input.driverUserId ? null : input.driverName,
        odometerKm: input.odometerKm,
        inFleet: input.inFleet,
      },
      today,
    );
    revalidatePath(PATH);
    return { ok: true, note: input.inFleet === false ? 'Salió de la flota.' : 'Guardado.' };
  } catch (err) {
    return fail(err, 'No pude guardar el vehículo.');
  }
}

export async function logFuelAction(input: FuelInputView): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    await logFuel(
      db,
      {
        vehicleId: input.vehicleId,
        filledOn: input.date,
        gallons: input.gallons,
        amount: input.amount,
        odometerKm: input.odometerKm,
        fullTank: input.fullTank,
        station: input.station,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Tanqueo registrado.' };
  } catch (err) {
    return fail(err, 'No pude registrar el tanqueo.');
  }
}

export async function logMaintenanceAction(input: MaintenanceInputView): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    const kind = (MAINTENANCE_KINDS as readonly string[]).includes(input.kind)
      ? (input.kind as MaintenanceKind)
      : undefined;
    const { plan } = await logMaintenance(
      db,
      {
        vehicleId: input.vehicleId,
        kind,
        description: input.description,
        doneOn: input.date,
        odometerKm: input.odometerKm,
        cost: input.cost,
        vendor: input.vendor,
        plan: input.plan,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: plan ? `Registrado; reinicié «${plan.task}».` : 'Registrado.' };
  } catch (err) {
    return fail(err, 'No pude registrar el mantenimiento.');
  }
}

export async function savePlanAction(input: PlanInputView): Promise<ActionResult> {
  const { db } = await session();
  try {
    await saveMaintenancePlan(db, input);
    revalidatePath(PATH);
    return { ok: true, note: 'Plan guardado.' };
  } catch (err) {
    return fail(err, 'No pude guardar el plan.');
  }
}

export async function estimateRouteAction(stops: string[]): Promise<RouteEstimateView> {
  await session();
  const r = await estimateRouteKm(stops);
  return r.ok ? { ok: true, km: r.km, minutes: r.minutes } : { ok: false, error: r.reason };
}

export async function createTripAction(input: TripInputView): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    await createTrip(
      db,
      {
        vehicleId: input.vehicleId,
        tripOn: input.date,
        driverUserId: input.driverUserId,
        driverName: input.driverUserId ? null : input.driverName,
        origin: input.origin,
        destination: input.destination,
        stops: input.stops.filter((s) => s.trim()).map((place) => ({ place })),
        plannedKm: input.plannedKm,
        plannedSource: input.plannedSource,
        km: input.km,
        tolls: input.tolls,
        otherCosts: input.otherCosts,
        status: input.status,
        guideRefs: input.guides,
        note: input.note,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Recorrido guardado.' };
  } catch (err) {
    return fail(err, 'No pude guardar el recorrido.');
  }
}

/** Celdas editables de la grilla de recorridos. */
export async function editTripCell(rowId: string, key: string, value: unknown): Promise<void> {
  const { db } = await session();
  const n = value === null || value === '' ? null : Number(value);
  switch (key) {
    case 'estado':
      if (!(TRIP_STATUSES as readonly string[]).includes(String(value)))
        throw new Error('Ese estado no existe.');
      await updateTrip(db, rowId, { status: value as TripStatus });
      break;
    case 'km':
      await updateTrip(db, rowId, { km: n });
      break;
    case 'peajes':
      await updateTrip(db, rowId, { tolls: n ?? 0 });
      break;
    case 'viaticos':
      await updateTrip(db, rowId, { otherCosts: n ?? 0 });
      break;
    case 'fecha': {
      const day = typeof value === 'string' ? value.slice(0, 10) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Fecha inválida.');
      const { error } = await db.from('trips').update({ trip_on: day }).eq('id', rowId);
      if (error) throw error;
      break;
    }
    default:
      throw new Error('Esa columna no se edita aquí.');
  }
  revalidatePath(PATH);
}
