import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { findProject } from '../projects/store';
import { resolveSalesDocument } from '../sales/tools';
import type { ToolContext } from '../types';
import { normalizePlate, plateField } from '../vehicles/shape';
import { resolvePerson } from '../work/shape';
import { workDirectory } from '../work/store';
import { FUEL_ANOMALY_LABEL, MAINTENANCE_STATUS_LABEL, tripCost } from './math';
import { estimateRouteKm, routeProviderConfigured } from './routes';
import {
  MAINTENANCE_KINDS,
  TRIP_STATUSES,
  TRIP_STATUS_LABEL,
  formatCop,
  formatKm,
  num,
} from './shape';
import {
  FleetInputError,
  createTrip,
  loadFleetOverview,
  logFuel,
  logMaintenance,
  requireFleetVehicle,
  tripFacts,
} from './store';

/**
 * LAS HERRAMIENTAS DE LA FLOTA (migración 0196).
 *
 *   fleet.status           cada vehículo: documentos (SOAT, tecnomecánica,
 *                          póliza), mantenimiento que toca, rendimiento y
 *                          consumo raro, costo por km, utilización. Sólo lee.
 *   fleet.log_fuel         un tanqueo. Confirma.
 *   fleet.log_maintenance  un mantenimiento hecho (reinicia su plan). Confirma.
 *   fleet.log_trip         un recorrido con sus paradas en orden. Confirma.
 *
 * Las placas, el RUNT y el SIMIT siguen siendo vehicles.*: el SIMIT se
 * consulta con vehicles.check_simit (o con el trámite aprendido del portal).
 */

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function inputError(err: unknown): never {
  if (err instanceof FleetInputError) throw new Error(err.message);
  throw err;
}

async function driverFor(
  ctx: ToolContext,
  raw: string | undefined,
): Promise<{ driverUserId: string | null; driverName: string | null }> {
  if (!raw) return { driverUserId: null, driverName: null };
  const m = resolvePerson(await workDirectory(ctx.db), raw);
  if (m.kind === 'found') return { driverUserId: m.id, driverName: null };
  if (m.kind === 'ambiguous')
    throw new Error(`«${raw}» puede ser ${m.candidates.map((c) => c.label).join(' o ')}. ¿Quién?`);
  // Un conductor sin cuenta en Cortex: queda su nombre.
  return { driverUserId: null, driverName: raw.trim().slice(0, 160) };
}

// ---------------------------------------------------------------------------

export const fleetStatus = registerTool({
  id: 'fleet.status',
  description:
    'Cómo está la flota de la empresa: por vehículo, el conductor, el kilometraje, los documentos (SOAT, tecnomecánica, póliza: vigentes, por vencer o vencidos), el mantenimiento que toca o ya se pasó (por km o por tiempo), el rendimiento de combustible (km/gal) con los tanqueos raros, el costo por km y la utilización del último mes, y los comparendos pendientes que dejó el SIMIT. «¿qué carro necesita mantenimiento?», «¿cuánto nos cuesta el km del NQR?», «¿quién está gastando mucho combustible?». Sólo lee lo guardado.',
  inputSchema: z.object({
    plate: plateField.optional().describe('Un vehículo; sin ella, toda la flota.'),
  }),
  outputSchema: z.object({
    vehicles: z.array(
      z.object({
        plate: z.string(),
        label: z.string().nullable(),
        driver: z.string().nullable(),
        odometerKm: z.number().nullable(),
        documents: z.array(
          z.object({
            kind: z.string(),
            expiresOn: z.string().nullable(),
            status: z.string(),
            daysLeft: z.number().nullable(),
          }),
        ),
        maintenance: z.array(
          z.object({ task: z.string(), status: z.string(), reason: z.string() }),
        ),
        kmPerGallon: z.number().nullable(),
        fuelAnomalies: z.array(z.string()),
        costPerKm: z.number().nullable(),
        kmLast90Days: z.number(),
        utilizationPct: z.number().nullable(),
        pendingFinesCop: z.number(),
        attention: z.array(z.string()),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const overview = await loadFleetOverview(ctx.db, today);
    let views = overview.vehicles;
    if (input.plate) {
      const plate = normalizePlate(input.plate);
      views = views.filter((v) => v.row.plate === plate);
      if (!views.length)
        throw new Error(
          `${plate} no está en la flota. Se agrega en /flota (o regístralo con vehicles.register y anótale un tanqueo).`,
        );
    }
    const vehicles = views.map((v) => ({
      plate: v.row.plate,
      label: v.row.label,
      driver: v.driver,
      odometerKm: v.odometerKm,
      documents: v.documents.map((d) => ({
        kind: d.kind,
        expiresOn: d.expiresOn,
        status:
          d.expiry.status === 'unknown'
            ? 'sin dato'
            : d.expiry.status === 'expired'
              ? 'vencido'
              : d.expiry.status === 'expiring'
                ? 'por vencer'
                : 'vigente',
        daysLeft: d.expiry.daysLeft,
      })),
      maintenance: v.plans.map((p) => ({
        task: p.task,
        status: MAINTENANCE_STATUS_LABEL[p.due.status],
        reason: p.due.reason,
      })),
      kmPerGallon: v.fuel.kmPerGallon,
      fuelAnomalies: v.fuel.anomalies
        .slice(0, 5)
        .map((a) => `${a.filledOn} · ${FUEL_ANOMALY_LABEL[a.kind]}: ${a.message}`),
      costPerKm: v.cost.perKm,
      kmLast90Days: v.cost.km,
      utilizationPct: v.utilization.pct,
      pendingFinesCop: num(v.row.total_pending_cop),
      attention: v.attention,
    }));
    const urgent = vehicles.filter((v) => v.attention.length);
    return {
      vehicles,
      guidance: !vehicles.length
        ? 'No hay vehículos en la flota todavía. Se agregan en /flota con placa, tipo, combustible, kilometraje y conductor.'
        : `${vehicles.length} ${vehicles.length === 1 ? 'vehículo' : 'vehículos'}. ${urgent.length ? `Piden atención: ${urgent.map((v) => `${v.plate} (${v.attention.slice(0, 2).join(', ')})`).join('; ')}.` : 'Nada vencido ni raro.'} Los documentos son lo último que se supo del RUNT o de los documentos leídos; para comparendos frescos usa vehicles.check_simit.`,
    };
  },
});

// ---------------------------------------------------------------------------

export const fleetLogFuel = registerTool({
  id: 'fleet.log_fuel',
  description:
    'Registrar un tanqueo de un vehículo de la flota: galones, valor, kilometraje del odómetro y si fue tanque lleno («el NQR tanqueó 18 galones por $290.000 a los 84.320 km»). Con el kilometraje se mide el rendimiento y se avisa si el consumo es raro. Pide confirmación.',
  inputSchema: z.object({
    plate: plateField,
    gallons: z.number().positive().max(500),
    amount: z.number().min(0).describe('Valor pagado, en pesos.'),
    odometerKm: z.number().min(0).optional(),
    date: isoDay.optional(),
    fullTank: z.boolean().optional().describe('Por defecto, tanque lleno.'),
    station: z.string().max(200).optional(),
    driver: z.string().max(160).optional(),
  }),
  outputSchema: z.object({
    plate: z.string(),
    kmPerGallon: z.number().nullable(),
    anomaly: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const v = await requireFleetVehicle(ctx.db, input.plate).catch(inputError);
    const driver = await driverFor(ctx, input.driver);
    const log = await logFuel(
      ctx.db,
      {
        vehicleId: v.id,
        filledOn: input.date ?? today,
        odometerKm: input.odometerKm ?? null,
        gallons: input.gallons,
        amount: input.amount,
        fullTank: input.fullTank ?? true,
        station: input.station ?? null,
        ...driver,
      },
      { userId: ctx.userId },
    ).catch(inputError);
    const after = (await loadFleetOverview(ctx.db, today, { vehicleIds: [v.id] })).vehicles[0];
    const seg = after?.fuel.segments.find((s) => s.logId === log.id);
    const anomaly = after?.fuel.anomalies.find((a) => a.logId === log.id) ?? null;
    const notes = [
      `Registré ${input.gallons} galones por ${formatCop(input.amount)} en ${v.plate}.`,
    ];
    if (seg) notes.push(`Rindió ${seg.kmPerGallon} km/gal desde el último tanque lleno.`);
    else if (input.odometerKm === undefined)
      notes.push('Sin kilometraje no puedo medir el rendimiento de este tanqueo.');
    if (anomaly) notes.push(`Ojo: ${anomaly.message}`);
    return {
      plate: v.plate,
      kmPerGallon: seg?.kmPerGallon ?? null,
      anomaly: anomaly?.message ?? null,
      guidance: notes.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const fleetLogMaintenance = registerTool({
  id: 'fleet.log_maintenance',
  description:
    'Registrar un mantenimiento hecho a un vehículo de la flota: qué se le hizo, cuándo, a qué kilometraje, cuánto costó y en qué taller («al FRT-482 le cambiaron el aceite hoy a los 61.200 km, $380.000 en Lubricentro El Sol»). Si corresponde a un plan (cambio de aceite, frenos, llantas…), reinicia la cuenta de ese plan. Pide confirmación.',
  inputSchema: z.object({
    plate: plateField,
    description: z.string().min(2).max(300),
    kind: z.enum(MAINTENANCE_KINDS).optional(),
    date: isoDay.optional(),
    odometerKm: z.number().min(0).optional(),
    cost: z.number().min(0).optional(),
    vendor: z.string().max(200).optional(),
    plan: z
      .string()
      .max(120)
      .optional()
      .describe('El plan que cumple, si no se deduce de la descripción.'),
  }),
  outputSchema: z.object({
    plate: z.string(),
    plan: z.string().nullable(),
    nextDue: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const v = await requireFleetVehicle(ctx.db, input.plate).catch(inputError);
    const { plan } = await logMaintenance(
      ctx.db,
      {
        vehicleId: v.id,
        kind: input.kind,
        description: input.description,
        doneOn: input.date ?? today,
        odometerKm: input.odometerKm ?? null,
        cost: input.cost ?? 0,
        vendor: input.vendor ?? null,
        plan: input.plan ?? null,
      },
      { userId: ctx.userId },
    ).catch(inputError);
    const after = (await loadFleetOverview(ctx.db, today, { vehicleIds: [v.id] })).vehicles[0];
    const due = plan ? after?.plans.find((p) => p.id === plan.id)?.due : null;
    const notes = [
      `Registré «${input.description}» en ${v.plate}${input.cost ? ` por ${formatCop(input.cost)}` : ''}.`,
    ];
    if (plan && due)
      notes.push(
        `Reinicié el plan «${plan.task}»: la próxima ${due.nextKm ? `a los ${formatKm(due.nextKm)}` : ''}${due.nextKm && due.nextOn ? ' o ' : ''}${due.nextOn ? `el ${due.nextOn}` : ''}.`,
      );
    else if (input.plan)
      notes.push(
        `No encontré un plan «${input.plan}» en ${v.plate}; quedó como mantenimiento suelto.`,
      );
    return {
      plate: v.plate,
      plan: plan?.task ?? null,
      nextDue: due?.reason ?? null,
      guidance: notes.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const fleetLogTrip = registerTool({
  id: 'fleet.log_trip',
  description:
    'Registrar o planear un recorrido: vehículo, conductor, origen, paradas en orden y destino, km (si no los dicen y hay proveedor de rutas configurado, se calculan; si no, quedan sin km), kilometraje de salida y llegada, peajes y viáticos, las guías o el pedido que lleva y su estado (planeado, en ruta, completado). «El NQR sale mañana con Pedro: Bogotá → Fusagasugá → Girardot, guías 1023 y 1024». Devuelve lo que costó con el costo por km del vehículo. Pide confirmación.',
  inputSchema: z.object({
    plate: plateField.optional(),
    date: isoDay.optional(),
    driver: z.string().max(160).optional(),
    origin: z.string().max(300).optional(),
    stops: z
      .array(z.string().min(1).max(300))
      .max(30)
      .optional()
      .describe('Paradas intermedias en orden.'),
    destination: z.string().max(300).optional(),
    km: z.number().min(0).optional().describe('Km recorridos (reales).'),
    plannedKm: z.number().min(0).optional(),
    startKm: z.number().min(0).optional(),
    endKm: z.number().min(0).optional(),
    tolls: z.number().min(0).optional(),
    otherCosts: z.number().min(0).optional().describe('Viáticos, parqueaderos, cargue.'),
    status: z.enum(TRIP_STATUSES).optional(),
    guides: z
      .array(z.string().min(1).max(60))
      .max(200)
      .optional()
      .describe('Números de guía que lleva.'),
    salesDocument: z.string().max(60).optional().describe('Pedido o factura que entrega: «PED-3».'),
    project: z.string().max(200).optional().describe('Orden de servicio o proyecto: «OS-0007».'),
    note: z.string().max(1000).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.string(),
    km: z.number().nullable(),
    kmSource: z.string(),
    cost: z.number().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const v = input.plate ? await requireFleetVehicle(ctx.db, input.plate).catch(inputError) : null;
    const driver = await driverFor(ctx, input.driver);
    const status =
      input.status ??
      (input.km !== undefined || input.endKm !== undefined ? 'completado' : 'planeado');
    let plannedKm = input.plannedKm ?? null;
    let plannedSource: 'manual' | 'proveedor' | null = plannedKm !== null ? 'manual' : null;
    let routeNote: string | null = null;
    const places = [input.origin, ...(input.stops ?? []), input.destination].filter(
      (p): p is string => !!p?.trim(),
    );
    if (plannedKm === null && input.km === undefined && places.length >= 2) {
      const est = await estimateRouteKm(places, ctx.signal);
      if (est.ok) {
        plannedKm = est.km;
        plannedSource = 'proveedor';
        routeNote = `La ruta calculada da ${formatKm(est.km)}${est.minutes ? ` (unos ${Math.round(est.minutes / 6) / 10} h)` : ''}.`;
      } else if (routeProviderConfigured()) routeNote = est.reason;
    }
    let salesDocumentId: string | null = null;
    if (input.salesDocument)
      salesDocumentId = (await resolveSalesDocument(ctx.db, input.salesDocument)).id;
    let projectId: string | null = null;
    if (input.project) {
      const { project } = await findProject(ctx.db, input.project);
      if (!project) throw new Error(`No encontré el proyecto «${input.project}».`);
      projectId = project.id;
    }
    const trip = await createTrip(
      ctx.db,
      {
        vehicleId: v?.id ?? null,
        tripOn: input.date ?? today,
        ...driver,
        origin: input.origin ?? null,
        destination: input.destination ?? null,
        stops: (input.stops ?? []).map((place) => ({ place })),
        plannedKm,
        plannedSource,
        startKm: input.startKm ?? null,
        endKm: input.endKm ?? null,
        km: input.km ?? null,
        tolls: input.tolls ?? 0,
        otherCosts: input.otherCosts ?? 0,
        status,
        guideRefs: input.guides ?? [],
        salesDocumentId,
        projectId,
        note: input.note ?? null,
      },
      { userId: ctx.userId },
    ).catch(inputError);
    const perKm = v
      ? ((await loadFleetOverview(ctx.db, today, { vehicleIds: [v.id] })).vehicles[0]?.cost.perKm ??
        null)
      : null;
    const facts = tripFacts(trip);
    const cost = tripCost(facts, perKm);
    const kmSource = facts.km
      ? 'real'
      : facts.startKm !== null && facts.endKm !== null
        ? 'odometro'
        : facts.plannedKm
          ? `planeado (${trip.planned_source ?? 'manual'})`
          : 'ninguno';
    const route = places.length ? places.join(' → ') : 'sin ruta';
    const notes = [`${TRIP_STATUS_LABEL[trip.status]}: ${route}${v ? ` en ${v.plate}` : ''}.`];
    if (routeNote) notes.push(routeNote);
    if (cost.km === null)
      notes.push(
        'Sin km: dime cuántos fueron (o el kilometraje de salida y llegada) para costearlo.',
      );
    else if (cost.total !== null)
      notes.push(
        `Costo estimado: ${formatCop(cost.total)} (${formatKm(cost.km)} a ${formatCop(perKm ?? 0)}/km + ${formatCop(cost.direct)} de peajes y viáticos).`,
      );
    else
      notes.push(
        'Todavía no hay costo por km del vehículo (faltan tanqueos o mantenimientos con kilometraje).',
      );
    return {
      id: trip.id,
      status: TRIP_STATUS_LABEL[trip.status],
      km: cost.km,
      kmSource,
      cost: cost.total,
      guidance: notes.join(' '),
    };
  },
});
