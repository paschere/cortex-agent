import { parseFleetTab } from '@/lib/fleet/shape';
import {
  anomalyViews,
  eventRows,
  fleetChoices,
  fleetTiles,
  fuelRows,
  fuelSummaries,
  planRows,
  tripColumns,
  tripPresets,
  tripRows,
  vehicleCards,
} from '@/lib/fleet/views';
import { parseProjectsTab } from '@/lib/projects/shape';
import {
  detailView,
  projectColumns,
  projectPresets,
  projectRow,
  projectTiles,
  rateViews,
  timesheetView,
  wonOpportunityViews,
} from '@/lib/projects/views';
import {
  type FleetOverview,
  type FleetVehicleRow,
  type FuelLogRow,
  type MaintenanceEventRow,
  type ProjectDetail,
  type ProjectRow,
  type ProjectSummary,
  type TripRow,
  fleetUtilization,
  fuelReport,
  maintenanceDue,
  projectMetrics,
  projectWeekTimesheet,
  tripCost,
  vehicleCostPerKm,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { ProyectosFlotaFixture } from './Showcase';

/**
 * PROYECTOS Y FLOTA CON DATOS INVENTADOS (0196). SÓLO EN DESARROLLO.
 *
 * /proyectos y /flota piden sesión; aquí se pintan los mismos componentes con
 * una empresa de mantenimiento industrial, armados con las mismas funciones de
 * lib/projects/views.ts, lib/fleet/views.ts y el motor de verdad.
 *
 * Parámetros: `?pantalla=proyectos|proyecto|flota`, `?tab=…`, `?modo=oscuro`.
 * En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const TODAY = '2026-10-03';
const NAMES: Record<string, string> = { u1: 'Laura Gómez', u2: 'Andrés Ruiz', u3: 'Pedro Castaño' };

function project(
  over: Partial<ProjectRow> & Pick<ProjectRow, 'id' | 'number' | 'code' | 'title'>,
): ProjectRow {
  return {
    kind: 'orden_servicio',
    description: null,
    status: 'en_curso',
    client_id: null,
    client_name: 'Nexa Logística',
    owner_id: 'u1',
    currency: 'COP',
    budget_amount: null,
    budget_hours: null,
    contract_amount: null,
    start_on: '2026-09-15',
    due_on: '2026-10-20',
    finished_on: null,
    quote_id: null,
    sales_order_id: null,
    contract_id: null,
    opportunity_id: null,
    origin: 'manual',
    team_ids: [],
    location: null,
    notes: null,
    created_by: 'u1',
    created_at: '2026-09-14T15:00:00Z',
    updated_at: '2026-10-01T15:00:00Z',
    ...over,
  };
}

const PROJECTS: Array<{
  row: ProjectRow;
  facts: Omit<Parameters<typeof projectMetrics>[0], 'project'>;
}> = [
  {
    row: project({
      id: 'p7',
      number: 7,
      code: 'OS-0007',
      title: 'Mantenimiento de 3 montacargas',
      budget_amount: 6_000_000,
      budget_hours: 40,
      contract_amount: 9_500_000,
    }),
    facts: {
      tasks: [
        { status: 'done' },
        { status: 'done' },
        { status: 'open', dueAt: '2026-10-08' },
        { status: 'open', dueAt: '2026-10-12' },
      ],
      time: [{ hours: 28, billable: true, costRate: 42_000, billRate: 85_000 }],
      costs: [
        { kind: 'material', amount: 1_150_000 },
        { kind: 'gasto', amount: 240_000 },
      ],
      materials: [{ qty: -6, unitCost: 95_000 }],
      invoiced: 4_750_000,
    },
  },
  {
    row: project({
      id: 'p8',
      number: 8,
      code: 'PRY-0008',
      kind: 'proyecto',
      title: 'Montaje de banda transportadora',
      client_name: 'Alimentos del Valle',
      budget_amount: 18_000_000,
      budget_hours: 160,
      contract_amount: 21_000_000,
      due_on: '2026-09-30',
      owner_id: 'u2',
    }),
    facts: {
      tasks: [
        { status: 'done' },
        { status: 'open', dueAt: '2026-09-25' },
        { status: 'open', dueAt: '2026-09-29' },
        { status: 'open' },
      ],
      time: [{ hours: 172, billable: true, costRate: 45_000, billRate: 90_000 }],
      costs: [
        { kind: 'subcontrato', amount: 7_800_000 },
        { kind: 'gasto', amount: 1_400_000 },
      ],
      materials: [{ qty: -40, unitCost: 120_000 }],
      invoiced: 10_500_000,
    },
  },
  {
    row: project({
      id: 'p9',
      number: 9,
      code: 'OS-0009',
      title: 'Revisión eléctrica planta 2',
      client_name: 'Coltrans',
      budget_amount: 2_500_000,
      budget_hours: 20,
      contract_amount: 4_200_000,
      status: 'terminado',
      finished_on: '2026-09-28',
      due_on: '2026-09-30',
    }),
    facts: {
      tasks: [{ status: 'done' }, { status: 'done' }],
      time: [{ hours: 18, billable: true, costRate: 40_000, billRate: 80_000 }],
      costs: [{ kind: 'material', amount: 380_000 }],
      materials: [],
      invoiced: 0,
    },
  },
  {
    row: project({
      id: 'p10',
      number: 10,
      code: 'OS-0010',
      title: 'Calibración de básculas',
      client_name: 'Ferretería Central',
      budget_amount: 1_200_000,
      budget_hours: 10,
      contract_amount: 2_100_000,
      status: 'abierto',
      start_on: '2026-10-01',
      due_on: '2026-10-15',
    }),
    facts: {
      tasks: [{ status: 'open', dueAt: '2026-10-10' }],
      time: [{ hours: 3, billable: true, costRate: 40_000, billRate: 80_000 }],
      costs: [],
      materials: [],
      invoiced: 0,
    },
  },
  {
    row: project({
      id: 'p11',
      number: 11,
      code: 'OS-0011',
      title: 'Cambio de compresor',
      client_name: 'Nexa Logística',
      status: 'cotizado',
      start_on: null,
      due_on: '2026-11-05',
      contract_amount: 3_400_000,
    }),
    facts: { tasks: [], time: [], costs: [], materials: [], invoiced: 0 },
  },
];

function summaries(): ProjectSummary[] {
  return PROJECTS.map(({ row, facts }) => ({
    project: row,
    ownerName: row.owner_id ? (NAMES[row.owner_id] ?? null) : null,
    metrics: projectMetrics(
      {
        project: {
          status: row.status,
          budgetAmount: row.budget_amount === null ? null : Number(row.budget_amount),
          budgetHours: row.budget_hours === null ? null : Number(row.budget_hours),
          contractAmount: row.contract_amount === null ? null : Number(row.contract_amount),
          dueOn: row.due_on,
          currency: 'COP',
        },
        ...facts,
      },
      TODAY,
    ),
  }));
}

function detailFixture(s: ProjectSummary): ProjectDetail {
  return {
    project: s.project,
    metrics: s.metrics,
    names: NAMES,
    tasks: [
      {
        id: 't1',
        title: 'Diagnóstico de los tres equipos',
        status: 'done',
        assigneeId: 'u2',
        assigneeLabel: null,
        dueAt: '2026-09-18',
        doneAt: '2026-09-18T20:00:00Z',
        openedAt: '2026-09-15',
      },
      {
        id: 't2',
        title: 'Cambio de rodamientos y mangueras',
        status: 'done',
        assigneeId: 'u3',
        assigneeLabel: null,
        dueAt: '2026-09-26',
        doneAt: '2026-09-25T20:00:00Z',
        openedAt: '2026-09-15',
      },
      {
        id: 't3',
        title: 'Prueba de carga con el cliente',
        status: 'open',
        assigneeId: 'u2',
        assigneeLabel: null,
        dueAt: '2026-10-08',
        doneAt: null,
        openedAt: '2026-09-15',
      },
      {
        id: 't4',
        title: 'Informe técnico y entrega',
        status: 'open',
        assigneeId: 'u1',
        assigneeLabel: null,
        dueAt: '2026-10-12',
        doneAt: null,
        openedAt: '2026-09-15',
      },
    ],
    time: [
      {
        id: 'h1',
        projectId: 'p7',
        workItemId: null,
        userId: 'u2',
        personLabel: null,
        workedOn: '2026-10-02',
        hours: 8,
        billable: true,
        costRate: 42_000,
        billRate: 85_000,
        note: 'Montacargas 2',
      },
      {
        id: 'h2',
        projectId: 'p7',
        workItemId: null,
        userId: 'u3',
        personLabel: null,
        workedOn: '2026-10-01',
        hours: 6,
        billable: true,
        costRate: 42_000,
        billRate: 85_000,
        note: null,
      },
      {
        id: 'h3',
        projectId: 'p7',
        workItemId: null,
        userId: 'u2',
        personLabel: null,
        workedOn: '2026-09-25',
        hours: 14,
        billable: true,
        costRate: 42_000,
        billRate: 85_000,
        note: null,
      },
    ],
    costs: [
      {
        id: 'c1',
        kind: 'material',
        description: 'Kit de mangueras hidráulicas',
        amount: 1_150_000,
        incurredOn: '2026-09-22',
        counterparty: 'Hidráulicos SAS',
        ledgerMovementId: null,
        source: 'manual',
      },
      {
        id: 'c2',
        kind: 'gasto',
        description: 'Transporte de repuestos',
        amount: 240_000,
        incurredOn: '2026-09-23',
        counterparty: null,
        ledgerMovementId: 'l1',
        source: 'libro',
      },
    ],
    materials: [
      {
        id: 'm1',
        productId: 'pr1',
        qty: -6,
        unitCost: 95_000,
        occurredOn: '2026-09-24',
        productName: 'Rodamiento 6205',
        unit: 'und',
      },
    ],
    milestones: [
      {
        id: 'ms1',
        position: 0,
        title: 'Anticipo 50 %',
        amount: 4_750_000,
        dueOn: '2026-09-15',
        status: 'facturado',
        salesDocumentId: 'inv1',
        invoicedAt: '2026-09-16T15:00:00Z',
      },
      {
        id: 'ms2',
        position: 1,
        title: 'Saldo contra entrega',
        amount: 4_750_000,
        dueOn: '2026-10-20',
        status: 'pendiente',
        salesDocumentId: null,
        invoicedAt: null,
      },
    ],
    salesDocs: [
      {
        id: 'q1',
        kind: 'quote',
        label: 'COT-0024',
        status: 'aceptada',
        amount: 9_500_000,
        issueDate: '2026-09-10',
      },
      {
        id: 'inv1',
        kind: 'invoice',
        label: 'FV-0029',
        status: 'emitida',
        amount: 4_750_000,
        issueDate: '2026-09-16',
      },
    ],
  };
}

// ---------------------------------------------------------------------------

function vehicle(
  over: Partial<FleetVehicleRow> & Pick<FleetVehicleRow, 'id' | 'plate'>,
): FleetVehicleRow {
  return {
    user_id: 'u1',
    label: null,
    brand: null,
    line: null,
    model_year: null,
    notes: null,
    runt_estado: 'ACTIVO',
    soat_expires_at: '2027-03-01',
    rtm_expires_at: '2027-01-15',
    last_runt_sync: null,
    last_simit_sync: null,
    total_pending_cop: 0,
    archived: false,
    in_fleet: true,
    vehicle_type: 'camion',
    fuel_type: 'diesel',
    odometer_km: 84_320,
    odometer_on: '2026-10-02',
    tank_gallons: 30,
    driver_user_id: 'u3',
    driver_name: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function fuelLogs(vehicleId: string, startKm: number, legs: number[], gallons = 10): FuelLogRow[] {
  let km = startKm;
  return [0, ...legs].map((leg, i) => {
    km += leg;
    return {
      id: `${vehicleId}-f${i}`,
      vehicle_id: vehicleId,
      filled_on: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 9 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      odometer_km: km,
      gallons,
      amount: gallons * 15_800,
      full_tank: true,
      station: null,
      driver_user_id: null,
      driver_name: null,
      created_at: '2026-08-01T00:00:00Z',
    };
  });
}

function fleetFixture(): FleetOverview {
  const rows = [
    vehicle({
      id: 'v1',
      plate: 'NQR482',
      label: 'El NQR blanco',
      brand: 'Chevrolet',
      line: 'NQR',
      model_year: 2019,
      odometer_km: 84_320,
    }),
    vehicle({
      id: 'v2',
      plate: 'FRT219',
      label: 'Camioneta de servicio',
      vehicle_type: 'camioneta',
      fuel_type: 'gasolina',
      odometer_km: 61_200,
      soat_expires_at: '2026-10-21',
      driver_user_id: 'u2',
      tank_gallons: 18,
    }),
    vehicle({
      id: 'v3',
      plate: 'KLM77F',
      label: 'Moto mensajería',
      vehicle_type: 'moto',
      fuel_type: 'gasolina',
      odometer_km: 23_900,
      rtm_expires_at: '2026-09-20',
      driver_user_id: null,
      driver_name: 'Jhon Mesa',
      tank_gallons: 4,
      total_pending_cop: 468_000,
    }),
  ];
  const fuel: Record<string, FuelLogRow[]> = {
    v1: fuelLogs('v1', 82_000, [400, 410, 395, 280], 14),
    v2: fuelLogs('v2', 59_800, [350, 340, 360], 9),
    v3: fuelLogs('v3', 23_200, [220, 230], 2.5),
  };
  const plansFor: Record<
    string,
    Array<{
      id: string;
      task: string;
      everyKm: number | null;
      everyDays: number | null;
      lastDoneKm: number | null;
      lastDoneOn: string | null;
    }>
  > = {
    v1: [
      {
        id: 'pl1',
        task: 'Cambio de aceite y filtros',
        everyKm: 5000,
        everyDays: 180,
        lastDoneKm: 79_600,
        lastDoneOn: '2026-06-10',
      },
      {
        id: 'pl2',
        task: 'Revisión de frenos',
        everyKm: 20_000,
        everyDays: 365,
        lastDoneKm: 70_000,
        lastDoneOn: '2026-02-01',
      },
    ],
    v2: [
      {
        id: 'pl3',
        task: 'Cambio de aceite y filtros',
        everyKm: 5000,
        everyDays: 180,
        lastDoneKm: 56_500,
        lastDoneOn: '2026-07-01',
      },
    ],
    v3: [
      {
        id: 'pl4',
        task: 'Revisión general',
        everyKm: null,
        everyDays: 120,
        lastDoneKm: null,
        lastDoneOn: '2026-07-10',
      },
    ],
  };
  const events: MaintenanceEventRow[] = [
    {
      id: 'e1',
      vehicle_id: 'v1',
      plan_id: 'pl1',
      kind: 'preventivo',
      description: 'Cambio de aceite y filtros',
      done_on: '2026-06-10',
      odometer_km: 79_600,
      cost: 420_000,
      vendor: 'Lubricentro El Sol',
      created_at: '',
    },
    {
      id: 'e2',
      vehicle_id: 'v2',
      plan_id: null,
      kind: 'correctivo',
      description: 'Cambio de batería',
      done_on: '2026-09-12',
      odometer_km: 60_900,
      cost: 380_000,
      vendor: null,
      created_at: '',
    },
  ];
  const trips: TripRow[] = [
    {
      id: 'tr1',
      vehicle_id: 'v1',
      trip_on: '2026-10-01',
      driver_user_id: 'u3',
      driver_name: null,
      origin: 'Bodega Montevideo, Bogotá',
      destination: 'Girardot',
      stops: [{ place: 'Fusagasugá' }],
      planned_km: 132,
      planned_source: 'proveedor',
      start_km: 83_900,
      end_km: 84_040,
      km: null,
      tolls: 48_000,
      other_costs: 30_000,
      status: 'completado',
      guide_refs: ['1023', '1024'],
      sales_document_id: null,
      project_id: null,
      note: null,
      created_at: '',
    },
    {
      id: 'tr2',
      vehicle_id: 'v2',
      trip_on: '2026-10-02',
      driver_user_id: 'u2',
      driver_name: null,
      origin: 'Oficina',
      destination: 'Planta Nexa, Funza',
      stops: [],
      planned_km: 28,
      planned_source: 'manual',
      start_km: null,
      end_km: null,
      km: 31,
      tolls: 0,
      other_costs: 15_000,
      status: 'completado',
      guide_refs: [],
      sales_document_id: null,
      project_id: 'p7',
      note: null,
      created_at: '',
    },
    {
      id: 'tr3',
      vehicle_id: 'v1',
      trip_on: '2026-10-06',
      driver_user_id: 'u3',
      driver_name: null,
      origin: 'Bodega Montevideo, Bogotá',
      destination: 'Tunja',
      stops: [{ place: 'Chocontá' }],
      planned_km: 147,
      planned_source: 'proveedor',
      start_km: null,
      end_km: null,
      km: null,
      tolls: 0,
      other_costs: 0,
      status: 'planeado',
      guide_refs: ['1031'],
      sales_document_id: null,
      project_id: null,
      note: null,
      created_at: '',
    },
  ];
  const from = '2026-07-05';
  const exp = (d: string | null) => {
    if (!d) return { expiresAt: null, status: 'unknown' as const, daysLeft: null };
    const days = Math.round(
      (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000,
    );
    return {
      expiresAt: d,
      status:
        days < 0 ? ('expired' as const) : days <= 30 ? ('expiring' as const) : ('valid' as const),
      daysLeft: days,
    };
  };
  const vehicles = rows.map((r) => {
    const logs = fuel[r.id] ?? [];
    const report = fuelReport(
      logs.map((f) => ({
        id: f.id,
        filledOn: String(f.filled_on),
        odometerKm: Number(f.odometer_km),
        gallons: Number(f.gallons),
        amount: Number(f.amount),
        fullTank: f.full_tank,
      })),
      { tankGallons: Number(r.tank_gallons) },
    );
    const vTrips = trips.filter((t) => t.vehicle_id === r.id);
    const tf = vTrips.map((t) => ({
      tripOn: t.trip_on,
      vehicleId: t.vehicle_id,
      status: t.status,
      km: t.km === null ? null : Number(t.km),
      startKm: t.start_km === null ? null : Number(t.start_km),
      endKm: t.end_km === null ? null : Number(t.end_km),
      plannedKm: t.planned_km === null ? null : Number(t.planned_km),
      tolls: Number(t.tolls),
      otherCosts: Number(t.other_costs),
    }));
    const vEvents = events.filter((e) => e.vehicle_id === r.id);
    const cost = vehicleCostPerKm({
      fuelAmount: logs.reduce((s, f) => s + Number(f.amount), 0),
      maintenanceAmount: vEvents
        .filter((e) => e.done_on >= from)
        .reduce((s, e) => s + Number(e.cost), 0),
      trips: tf,
      odometerReadings: logs.map((f) => Number(f.odometer_km)),
    });
    const plans = (plansFor[r.id] ?? []).map((p) => ({
      ...p,
      due: maintenanceDue(p, Number(r.odometer_km), TODAY),
    }));
    const documents = [
      {
        kind: 'soat',
        expiresOn: r.soat_expires_at,
        status: '',
        needsReview: false,
        from: 'runt' as const,
        expiry: exp(r.soat_expires_at),
      },
      {
        kind: 'tecnomecanica',
        expiresOn: r.rtm_expires_at,
        status: '',
        needsReview: false,
        from: 'runt' as const,
        expiry: exp(r.rtm_expires_at),
      },
      ...(r.id === 'v1'
        ? [
            {
              kind: 'poliza',
              expiresOn: '2027-02-10',
              status: 'vigente',
              needsReview: false,
              from: 'documento' as const,
              expiry: exp('2027-02-10'),
            },
          ]
        : []),
    ];
    const attention: string[] = [];
    for (const d of documents) {
      const label =
        d.kind === 'soat' ? 'SOAT' : d.kind === 'tecnomecanica' ? 'Tecnomecánica' : 'Póliza';
      if (d.expiry.status === 'expired') attention.push(`${label} vencido`);
      else if (d.expiry.status === 'expiring')
        attention.push(`${label} vence en ${d.expiry.daysLeft} días`);
    }
    for (const p of plans)
      if (p.due.status === 'vencido' || p.due.status === 'pronto')
        attention.push(`${p.task}: ${p.due.status === 'vencido' ? 'vencido' : 'toca pronto'}`);
    if (report.anomalies.length) attention.push('Consumo de combustible raro');
    if (Number(r.total_pending_cop) > 0) attention.push('Comparendos pendientes');
    return {
      row: r,
      driver: r.driver_user_id ? (NAMES[r.driver_user_id] ?? null) : r.driver_name,
      odometerKm: Number(r.odometer_km),
      documents,
      plans,
      fuel: report,
      cost,
      utilization: fleetUtilization(
        vTrips.map((t) => t.trip_on),
        '2026-09-04',
        TODAY,
      ),
      fuelLogs: logs,
      events: vEvents,
      attention,
    };
  });
  const perKm = new Map(vehicles.map((v) => [v.row.id, v.cost.perKm]));
  return {
    vehicles,
    trips: trips.map((t) => ({
      ...t,
      cost: tripCost(
        {
          km: t.km === null ? null : Number(t.km),
          startKm: t.start_km === null ? null : Number(t.start_km),
          endKm: t.end_km === null ? null : Number(t.end_km),
          plannedKm: t.planned_km === null ? null : Number(t.planned_km),
          tolls: Number(t.tolls),
          otherCosts: Number(t.other_costs),
        },
        t.vehicle_id ? (perKm.get(t.vehicle_id) ?? null) : null,
      ),
      plate: rows.find((r) => r.id === t.vehicle_id)?.plate ?? null,
      driver: t.driver_user_id ? (NAMES[t.driver_user_id] ?? null) : t.driver_name,
    })),
    period: { from, to: TODAY },
    names: NAMES,
  };
}

export default async function ProyectosFlotaShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const pantalla =
    one('pantalla') === 'proyecto'
      ? 'proyecto'
      : one('pantalla') === 'flota'
        ? 'flota'
        : 'proyectos';
  const list = summaries();
  const week = projectWeekTimesheet(
    [
      { projectId: 'u2', workedOn: '2026-09-29', hours: 8 },
      { projectId: 'u2', workedOn: '2026-09-30', hours: 7.5 },
      { projectId: 'u2', workedOn: '2026-10-02', hours: 8 },
      { projectId: 'u3', workedOn: '2026-10-01', hours: 6 },
      { projectId: 'u3', workedOn: '2026-10-02', hours: 9 },
      { projectId: 'u1', workedOn: '2026-10-03', hours: 2 },
    ],
    '2026-09-28',
  );
  const people = Object.entries(NAMES).map(([id, name]) => ({ id, name }));
  const fleet = fleetFixture();
  const first = list[0] as ProjectSummary;
  return (
    <ProyectosFlotaFixture
      dark={one('modo') === 'oscuro'}
      pantalla={pantalla}
      projects={{
        tab: parseProjectsTab(one('tab')),
        today: TODAY,
        tiles: projectTiles(list, week.total),
        columns: projectColumns(Object.values(NAMES)),
        rows: list.map(projectRow),
        presets: projectPresets(),
        choices: list.map((s) => ({
          id: s.project.id,
          label: `${s.project.code} · ${s.project.title}`,
        })),
        people: people.map((p) => ({ value: p.id, label: p.name })),
        week: timesheetView(
          week,
          week.rows.map((r) => ({
            key: r.projectId,
            label: NAMES[r.projectId] ?? 'Alguien',
            days: r.days,
            total: r.total,
          })),
          { today: TODAY, hrefFor: () => '?tab=horas' },
        ),
        rates: rateViews(
          people,
          [
            { userId: null, costRate: 35_000, billRate: 80_000, source: 'manual' },
            { userId: 'u2', costRate: 45_000, billRate: 90_000, source: 'nomina' },
          ],
          new Map([
            ['u2', 112],
            ['u3', 96],
          ]),
        ),
        won: wonOpportunityViews([
          {
            id: 'o1',
            title: 'Mantenimiento anual de compresores',
            clientId: null,
            clientName: 'Alimentos del Valle',
            value: 14_500_000,
            currency: 'COP',
            wonAt: '2026-10-01T15:00:00Z',
            quoteId: null,
            ownerId: 'u1',
          },
        ]),
        canManage: true,
      }}
      detail={detailView(detailFixture(first), {
        today: TODAY,
        viewerId: 'u1',
        canManage: true,
        salesEnabled: true,
        inventoryEnabled: true,
        ledgerExpenses: [
          { id: 'l9', date: '2026-09-30', description: 'Peajes y parqueaderos', amount: 86_000 },
        ],
        products: [{ value: 'pr1', label: 'RD-6205 · Rodamiento 6205 (34 und)' }],
      })}
      fleet={{
        tab: parseFleetTab(one('tab')),
        today: TODAY,
        tiles: fleetTiles(fleet),
        vehicles: vehicleCards(fleet),
        plans: planRows(fleet),
        events: eventRows(fleet),
        fuel: fuelRows(fleet),
        fuelSummary: fuelSummaries(fleet),
        anomalies: anomalyViews(fleet),
        tripColumns: tripColumns(fleet),
        tripRows: tripRows(fleet),
        tripPresets: tripPresets(),
        choices: fleetChoices(fleet, true),
      }}
    />
  );
}
