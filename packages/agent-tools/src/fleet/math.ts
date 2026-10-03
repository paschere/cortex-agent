/**
 * LA CUENTA DE LA FLOTA (migración 0196) — motor puro.
 *
 * Mantenimiento que toca por km o por tiempo, rendimiento de combustible con
 * su consumo raro, costo por km de cada vehículo, costo de un recorrido y
 * utilización. Nada de base de datos ni de reloj: `today` llega de afuera
 * (día de Bogotá) y cada cifra se explica con los hechos que la dieron.
 */

const DAY_MS = 86_400_000;

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      DAY_MS,
  );
}

function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// ---------------------------------------------------------------------------
// Mantenimiento
// ---------------------------------------------------------------------------

export type MaintenanceStatus = 'vencido' | 'pronto' | 'al_dia' | 'sin_base';

export const MAINTENANCE_STATUS_LABEL: Record<MaintenanceStatus, string> = {
  vencido: 'Vencido',
  pronto: 'Toca pronto',
  al_dia: 'Al día',
  sin_base: 'Sin último registro',
};

export interface MaintenancePlanFacts {
  task: string;
  everyKm: number | null;
  everyDays: number | null;
  lastDoneKm: number | null;
  lastDoneOn: string | null;
}

export interface MaintenanceDue {
  status: MaintenanceStatus;
  nextKm: number | null;
  nextOn: string | null;
  /** Negativo cuando ya se pasó. */
  kmLeft: number | null;
  daysLeft: number | null;
  /** En palabras: «faltan 320 km», «se pasó hace 12 días». */
  reason: string;
}

/** Aviso por km: el 10 % del intervalo, entre 300 y 1.000 km. */
export function soonKmFor(everyKm: number): number {
  return Math.min(1000, Math.max(300, everyKm * 0.1));
}

/** Aviso por tiempo: el 10 % del intervalo, entre 7 y 30 días. */
export function soonDaysFor(everyDays: number): number {
  return Math.min(30, Math.max(7, Math.round(everyDays * 0.1)));
}

const RANK: Record<MaintenanceStatus, number> = { vencido: 0, pronto: 1, al_dia: 2, sin_base: 3 };

/**
 * Lo que toca de un plan con el odómetro de hoy. Manda la regla que vence
 * primero: un aceite a los 5.000 km o a los 6 meses vence a lo que llegue antes.
 */
export function maintenanceDue(
  plan: MaintenancePlanFacts,
  odometerKm: number | null,
  today: string,
): MaintenanceDue {
  let byKm: { status: MaintenanceStatus; nextKm: number; kmLeft: number } | null = null;
  if (plan.everyKm && plan.lastDoneKm !== null && odometerKm !== null) {
    const nextKm = plan.lastDoneKm + plan.everyKm;
    const kmLeft = round(nextKm - odometerKm, 1);
    byKm = {
      nextKm,
      kmLeft,
      status: kmLeft <= 0 ? 'vencido' : kmLeft <= soonKmFor(plan.everyKm) ? 'pronto' : 'al_dia',
    };
  }
  let byTime: { status: MaintenanceStatus; nextOn: string; daysLeft: number } | null = null;
  if (plan.everyDays && plan.lastDoneOn) {
    const nextOn = addDaysIso(plan.lastDoneOn, plan.everyDays);
    const daysLeft = daysBetween(today, nextOn);
    byTime = {
      nextOn,
      daysLeft,
      status:
        daysLeft < 0 ? 'vencido' : daysLeft <= soonDaysFor(plan.everyDays) ? 'pronto' : 'al_dia',
    };
  }
  if (!byKm && !byTime) {
    return {
      status: 'sin_base',
      nextKm: null,
      nextOn: null,
      kmLeft: null,
      daysLeft: null,
      reason:
        plan.everyKm && odometerKm === null && plan.lastDoneKm !== null
          ? 'Falta el kilometraje actual del vehículo.'
          : 'No se sabe cuándo se hizo por última vez.',
    };
  }
  const worst =
    byKm && byTime
      ? RANK[byKm.status] <= RANK[byTime.status]
        ? 'km'
        : 'time'
      : byKm
        ? 'km'
        : 'time';
  const status =
    worst === 'km' ? (byKm?.status as MaintenanceStatus) : (byTime?.status as MaintenanceStatus);
  const fmtKm = (n: number) => `${Math.round(Math.abs(n)).toLocaleString('es-CO')} km`;
  const reason =
    worst === 'km' && byKm
      ? byKm.kmLeft <= 0
        ? `Se pasó por ${fmtKm(byKm.kmLeft)} (tocaba a los ${fmtKm(byKm.nextKm)}).`
        : `Faltan ${fmtKm(byKm.kmLeft)} (a los ${fmtKm(byKm.nextKm)}).`
      : byTime
        ? byTime.daysLeft < 0
          ? `Se pasó hace ${-byTime.daysLeft} días (tocaba el ${byTime.nextOn}).`
          : byTime.daysLeft === 0
            ? 'Toca hoy.'
            : `Faltan ${byTime.daysLeft} días (el ${byTime.nextOn}).`
        : '';
  return {
    status,
    nextKm: byKm?.nextKm ?? null,
    nextOn: byTime?.nextOn ?? null,
    kmLeft: byKm?.kmLeft ?? null,
    daysLeft: byTime?.daysLeft ?? null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Combustible
// ---------------------------------------------------------------------------

export interface FuelLogFacts {
  id: string;
  filledOn: string;
  odometerKm: number | null;
  gallons: number;
  amount: number;
  fullTank: boolean;
}

export interface FuelSegment {
  /** El tanqueo que cierra el tramo. */
  logId: string;
  filledOn: string;
  fromKm: number;
  toKm: number;
  km: number;
  gallons: number;
  amount: number;
  kmPerGallon: number;
  costPerKm: number;
}

export type FuelAnomalyKind = 'rendimiento_bajo' | 'odometro_atras' | 'excede_tanque';

export const FUEL_ANOMALY_LABEL: Record<FuelAnomalyKind, string> = {
  rendimiento_bajo: 'Rendimiento bajo',
  odometro_atras: 'Odómetro hacia atrás',
  excede_tanque: 'Más galones que el tanque',
};

export interface FuelAnomaly {
  logId: string;
  filledOn: string;
  kind: FuelAnomalyKind;
  message: string;
}

export interface FuelReport {
  segments: FuelSegment[];
  medianKmPerGallon: number | null;
  /** Rendimiento del período: km de los tramos / galones de los tramos. */
  kmPerGallon: number | null;
  anomalies: FuelAnomaly[];
  /** Tanqueos sin odómetro: no entran a ningún tramo. */
  withoutOdometer: number;
}

/** Bajo la mediana del mismo vehículo por más de esto (25 %) = consumo raro. */
export const FUEL_ANOMALY_DROP = 0.25;
/** Tramos mínimos para tener mediana con qué comparar. */
export const FUEL_MIN_SEGMENTS = 3;

/**
 * Rendimiento entre tanques llenos y lo que se sale de lo normal.
 *
 * Un tramo va de un tanque lleno al siguiente: km recorridos / galones echados
 * después del primero (incluido el que cierra). Un tanqueo parcial suma sus
 * galones al tramo en que cae. Se compara cada tramo con la mediana del MISMO
 * vehículo — no con una tabla de fábrica — porque una tractomula cargada y un
 * carro de mensajería no tienen nada que comparar entre sí.
 */
export function fuelReport(
  logs: readonly FuelLogFacts[],
  opts: { tankGallons?: number | null } = {},
): FuelReport {
  const anomalies: FuelAnomaly[] = [];
  const withKm = logs.filter((l) => l.odometerKm !== null);
  const ordered = [...withKm].sort(
    (a, b) => a.filledOn.localeCompare(b.filledOn) || (a.odometerKm ?? 0) - (b.odometerKm ?? 0),
  );
  if (opts.tankGallons) {
    for (const l of logs) {
      if (l.gallons > opts.tankGallons * 1.05)
        anomalies.push({
          logId: l.id,
          filledOn: l.filledOn,
          kind: 'excede_tanque',
          message: `Se registraron ${round(l.gallons, 1)} galones en un tanque de ${opts.tankGallons}.`,
        });
    }
  }

  const segments: FuelSegment[] = [];
  let lastFull: FuelLogFacts | null = null;
  let pendingGallons = 0;
  let pendingAmount = 0;
  let lastKm: number | null = null;
  for (const l of ordered) {
    const km = l.odometerKm as number;
    if (lastKm !== null && km < lastKm) {
      anomalies.push({
        logId: l.id,
        filledOn: l.filledOn,
        kind: 'odometro_atras',
        message: `El odómetro dice ${Math.round(km).toLocaleString('es-CO')} km, menos que el tanqueo anterior (${Math.round(lastKm).toLocaleString('es-CO')} km).`,
      });
      // Un odómetro que retrocede invalida el tramo: se empieza de nuevo aquí.
      lastFull = l.fullTank ? l : null;
      pendingGallons = 0;
      pendingAmount = 0;
      lastKm = km;
      continue;
    }
    lastKm = km;
    if (lastFull) {
      pendingGallons += l.gallons;
      pendingAmount += l.amount;
    }
    if (!l.fullTank) continue;
    if (lastFull && pendingGallons > 0) {
      const dist = km - (lastFull.odometerKm as number);
      if (dist > 0)
        segments.push({
          logId: l.id,
          filledOn: l.filledOn,
          fromKm: lastFull.odometerKm as number,
          toKm: km,
          km: round(dist, 1),
          gallons: round(pendingGallons, 3),
          amount: round(pendingAmount, 2),
          kmPerGallon: round(dist / pendingGallons, 2),
          costPerKm: round(pendingAmount / dist, 2),
        });
    }
    lastFull = l;
    pendingGallons = 0;
    pendingAmount = 0;
  }

  const med = median(segments.map((s) => s.kmPerGallon));
  if (med !== null && segments.length >= FUEL_MIN_SEGMENTS) {
    for (const s of segments) {
      // La mediana sin el propio tramo: un tramo raro no se excusa a sí mismo.
      const others = median(segments.filter((o) => o !== s).map((o) => o.kmPerGallon)) ?? med;
      if (s.kmPerGallon < others * (1 - FUEL_ANOMALY_DROP)) {
        const drop = Math.round((1 - s.kmPerGallon / others) * 100);
        anomalies.push({
          logId: s.logId,
          filledOn: s.filledOn,
          kind: 'rendimiento_bajo',
          message: `Rindió ${s.kmPerGallon.toLocaleString('es-CO')} km/gal entre los ${Math.round(s.fromKm).toLocaleString('es-CO')} y los ${Math.round(s.toKm).toLocaleString('es-CO')} km: ${drop} % menos que lo normal de este vehículo (${round(others, 1).toLocaleString('es-CO')} km/gal).`,
        });
      }
    }
  }
  const totKm = segments.reduce((s, x) => s + x.km, 0);
  const totGal = segments.reduce((s, x) => s + x.gallons, 0);
  return {
    segments,
    medianKmPerGallon: med === null ? null : round(med, 2),
    kmPerGallon: totGal > 0 ? round(totKm / totGal, 2) : null,
    anomalies: anomalies.sort((a, b) => b.filledOn.localeCompare(a.filledOn)),
    withoutOdometer: logs.length - withKm.length,
  };
}

// ---------------------------------------------------------------------------
// Costo por km y recorridos
// ---------------------------------------------------------------------------

export interface TripFacts {
  tripOn: string;
  vehicleId: string | null;
  status: 'planeado' | 'en_ruta' | 'completado' | 'cancelado';
  km: number | null;
  startKm: number | null;
  endKm: number | null;
  plannedKm: number | null;
  tolls: number;
  otherCosts: number;
}

/** Los km de un recorrido: los reales, o el odómetro, o los planeados. */
export function tripKm(t: Pick<TripFacts, 'km' | 'startKm' | 'endKm' | 'plannedKm'>): {
  km: number | null;
  from: 'real' | 'odometro' | 'planeado' | 'ninguno';
} {
  if (t.km !== null && t.km > 0) return { km: t.km, from: 'real' };
  if (t.startKm !== null && t.endKm !== null && t.endKm > t.startKm)
    return { km: round(t.endKm - t.startKm, 1), from: 'odometro' };
  if (t.plannedKm !== null && t.plannedKm > 0) return { km: t.plannedKm, from: 'planeado' };
  return { km: null, from: 'ninguno' };
}

export interface CostPerKm {
  km: number;
  fuel: number;
  maintenance: number;
  trips: number;
  total: number;
  /** Nulo sin km recorridos. */
  perKm: number | null;
  kmFrom: 'recorridos' | 'odometro' | 'ninguno';
}

/**
 * Costo por km de un vehículo en un período: combustible + mantenimiento +
 * peajes y viáticos de sus recorridos, sobre los km: el mayor entre lo que
 * suman los recorridos completados y lo que avanzó el odómetro (mayor − menor
 * lectura de tanqueos y mantenimientos).
 */
export function vehicleCostPerKm(input: {
  fuelAmount: number;
  maintenanceAmount: number;
  trips: readonly TripFacts[];
  odometerReadings: readonly number[];
}): CostPerKm {
  const done = input.trips.filter((t) => t.status === 'completado');
  const tripCosts = done.reduce((s, t) => s + t.tolls + t.otherCosts, 0);
  const tripKmSum = done.reduce((s, t) => s + (tripKm(t).km ?? 0), 0);
  // Los km del período: el mayor entre lo que suman los recorridos registrados
  // y lo que avanzó el odómetro. Si sólo se registró un recorrido de 30 km pero
  // el combustible cubre 1.000, dividir por 30 inflaría el costo por km.
  const span =
    input.odometerReadings.length >= 2
      ? round(Math.max(...input.odometerReadings) - Math.min(...input.odometerReadings), 1)
      : 0;
  const fromTrips = round(tripKmSum, 1);
  const km = Math.max(fromTrips, span);
  const kmFrom: CostPerKm['kmFrom'] =
    km <= 0 ? 'ninguno' : fromTrips >= span ? 'recorridos' : 'odometro';
  const total = round(input.fuelAmount + input.maintenanceAmount + tripCosts, 2);
  return {
    km,
    fuel: round(input.fuelAmount, 2),
    maintenance: round(input.maintenanceAmount, 2),
    trips: round(tripCosts, 2),
    total,
    perKm: km > 0 ? round(total / km, 2) : null,
    kmFrom,
  };
}

/** Lo que costó un recorrido: sus km al costo por km del vehículo + peajes y viáticos. */
export function tripCost(
  trip: Pick<TripFacts, 'km' | 'startKm' | 'endKm' | 'plannedKm' | 'tolls' | 'otherCosts'>,
  perKm: number | null,
): { km: number | null; running: number | null; direct: number; total: number | null } {
  const { km } = tripKm(trip);
  const direct = round(trip.tolls + trip.otherCosts, 2);
  const running = km !== null && perKm !== null ? round(km * perKm, 2) : null;
  return { km, running, direct, total: running === null ? null : round(running + direct, 2) };
}

/**
 * Utilización: días con al menos un recorrido (no cancelado) sobre los días
 * hábiles del período, de lunes a sábado.
 */
export function utilization(
  tripDays: readonly string[],
  from: string,
  to: string,
): { daysUsed: number; workingDays: number; pct: number | null } {
  let workingDays = 0;
  const span = daysBetween(from, to);
  const working = new Set<string>();
  for (let i = 0; i <= span; i++) {
    const d = addDaysIso(from, i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) {
      workingDays++;
      working.add(d);
    }
  }
  const used = new Set(tripDays.map((d) => d.slice(0, 10)).filter((d) => working.has(d)));
  return {
    daysUsed: used.size,
    workingDays,
    pct: workingDays ? round((used.size / workingDays) * 100, 1) : null,
  };
}
