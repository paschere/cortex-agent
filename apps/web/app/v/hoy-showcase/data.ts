import { addDaysIso } from '@/components/charts/interactive';
import { buildOps } from '@/lib/hoy/ops';
import { buildHoyMetrics, narrative } from '@/lib/hoy/shape';
import type { HoyView } from '@/lib/hoy/view';
import type {
  ForecastResult,
  ForecastWeek,
  LedgerMovement,
} from '@cortex/agent-tools/src/ledger/types';

/** «Hoy» con una empresa inventada (Transportes Andinos). Determinista: sin azar. */

export const TODAY = '2026-10-10';
const CLIENTS = [
  'Frigoandes',
  'Agrícola del Sur',
  'Nexa Logística',
  'Cementos Valle',
  'Textiles Aurora',
];
const SUPPLIERS = ['Combustibles del Norte', 'Llantas Express', 'Seguros Bolívar', 'Talleres Díaz'];

function wave(i: number, period: number, amp: number): number {
  return 1 + Math.sin((i / period) * Math.PI * 2) * amp;
}

function movements(): LedgerMovement[] {
  const out: LedgerMovement[] = [];
  const mk = (p: Partial<LedgerMovement> & Pick<LedgerMovement, 'id' | 'direction' | 'amount'>) =>
    out.push({
      kind: 'income',
      status: 'settled',
      currency: 'COP',
      date: TODAY,
      description: p.id,
      source: { kind: 'manual', ref: p.id },
      ...p,
    } as LedgerMovement);

  for (let d = -480; d <= 0; d += 3) {
    const date = addDaysIso(TODAY, d);
    const i = d + 480;
    const client = CLIENTS[i % CLIENTS.length] as string;
    const amount = Math.round((5_200_000 * wave(i, 45, 0.35) * (1 + i / 1600)) / 1000) * 1000;
    const due = addDaysIso(date, 30);
    const paid =
      due < addDaysIso(TODAY, -3) &&
      !(client === 'Frigoandes' && d > -75) &&
      !(client === 'Nexa Logística' && d > -50);
    mk({
      id: `fe-${i}`,
      direction: 'in',
      kind: 'receivable',
      status: paid ? 'settled' : 'expected',
      amount,
      date,
      dueDate: due,
      settledAt: paid ? addDaysIso(due, (i % 9) - 2) : null,
      counterpartyName: client,
      description: `FE-${2100 + i}`,
    });
  }
  for (let d = -480; d <= 90; d += 5) {
    const date = addDaysIso(TODAY, d);
    const i = d + 480;
    const supplier = SUPPLIERS[i % SUPPLIERS.length] as string;
    const settled = d < -4;
    mk({
      id: `fp-${i}`,
      direction: 'out',
      kind: 'payable',
      status: settled ? 'settled' : 'expected',
      amount: Math.round((2_300_000 * wave(i, 31, 0.4)) / 1000) * 1000,
      date: addDaysIso(date, -20),
      dueDate: date,
      settledAt: settled ? date : null,
      counterpartyName: supplier,
      description: `Factura ${supplier}`,
      category: i % 3 ? 'combustible' : 'mantenimiento',
    });
  }
  for (let m = -16; m <= 3; m++) {
    for (const day of ['15', '30']) {
      const [y, mo] = addDaysIso(TODAY, m * 30).split('-');
      const date = `${y}-${mo}-${day}`;
      if (date > addDaysIso(TODAY, 80)) continue;
      mk({
        id: `nom-${date}`,
        direction: 'out',
        kind: 'expense',
        status: date <= TODAY ? 'settled' : 'expected',
        amount: 11_800_000,
        date,
        dueDate: date,
        settledAt: date <= TODAY ? date : null,
        category: 'nomina',
        description: 'Nómina',
      });
    }
  }
  return out;
}

function forecast(startingCash: number): ForecastResult {
  const weeks: ForecastWeek[] = [];
  let cash = startingCash;
  for (let w = 0; w < 10; w++) {
    const start = addDaysIso('2026-10-05', w * 7);
    const inflows = Math.round(9_500_000 * wave(w, 6, 0.3));
    const outflows = Math.round(
      8_200_000 * wave(w + 2, 5, 0.25) + (w === 1 || w === 3 || w === 5 ? 11_800_000 : 0),
    );
    const opening = cash;
    cash = cash + inflows - outflows;
    weeks.push({
      start,
      opening,
      inflows,
      outflows,
      closing: cash,
      items: [
        {
          label: 'Cobro FE',
          direction: 'in',
          amount: inflows,
          expectedAmount: Math.round(inflows * 0.82),
          probability: 0.82,
          expectedDate: addDaysIso(start, 3),
          reason: 'Vence esa semana',
          counterpartyName: w === 1 ? 'Agrícola del Sur S.A.S.' : 'Cementos Valle',
        },
        {
          label: 'Pagos a proveedores',
          direction: 'out',
          amount: outflows - (w === 1 || w === 3 || w === 5 ? 11_800_000 : 0),
          expectedAmount: outflows,
          probability: 0.9,
          expectedDate: addDaysIso(start, 4),
          reason: 'Facturas por pagar',
          counterpartyName: w === 2 ? 'Combustibles del Norte' : 'Llantas Express',
        },
        ...(w === 1 || w === 3 || w === 5
          ? [
              {
                label: 'Nómina',
                direction: 'out' as const,
                amount: 11_800_000,
                expectedAmount: 11_800_000,
                probability: 1,
                expectedDate: w === 1 ? '2026-10-15' : w === 3 ? '2026-10-30' : '2026-11-15',
                reason: 'Nómina quincenal',
                category: 'nomina',
              },
            ]
          : []),
      ],
    });
  }
  const lowest = weeks.reduce((a, b) => (b.closing < a.closing ? b : a));
  return {
    asOf: TODAY,
    currency: 'COP',
    startingCash,
    weeks,
    lowest: { week: lowest.start, closing: lowest.closing },
    alerts: [],
    assumptions: [],
    minimumCash: 15_000_000,
  };
}

export interface FixtureOptions {
  /** Sin la plata a la vista (módulo de finanzas apagado). */
  sinPlata?: boolean;
  /** Caja bajo el mínimo. */
  apuro?: boolean;
  /** Nada que decidir. */
  vacio?: boolean;
}

export function hoyFixture(opts: FixtureOptions = {}): HoyView {
  const cashTotal = opts.apuro ? 9_800_000 : 48_215_000;
  const fc = forecast(cashTotal);
  const ms = movements();
  const runs = Array.from({ length: 40 }, (_, i) => ({
    day: addDaysIso(TODAY, -i),
    done: (i * 7) % 5 === 0 ? 0 : 2 + ((i * 3) % 6),
  }));
  const built = buildHoyMetrics({
    today: TODAY,
    currency: 'COP',
    isAdmin: true,
    cashTotal,
    movements: ms,
    forecast: fc,
    minimumCash: 15_000_000,
    runs,
  });
  const overdueNow = built.metrics.find((m) => m.id === 'vencido')?.daily.at(-1)?.value ?? 0;
  const todos = opts.vacio
    ? []
    : [
        {
          id: 'a1',
          title: 'Recordarle a Frigoandes la factura FE-2231',
          detail: '$ 4.800.000 · 41 días vencida · ya te escribí el correo',
          badge: null,
          preview: {
            to: 'camila@frigoandes.co',
            subject: 'Factura FE-2231',
            body: 'Hola Camila, te escribo por la factura FE-2231 de $ 4.800.000, que venció el 29 de agosto. ¿Me confirmas cuándo pueden pagarla? Si ya la pagaron, mándame el soporte y la cruzo.',
          },
          decide: { itemId: 'i1', contentHash: 'h1', approveLabel: 'Enviar' },
          href: '/approvals',
          hrefLabel: 'Editar',
          ageLabel: 'espera hace 2 días',
          risk: { label: 'Riesgo alto', tone: 'rose' as const },
        },
        {
          id: 'a2',
          title: 'Pagar a Combustibles del Norte',
          detail: '$ 2.100.000 · vence mañana · hay caja',
          badge: { label: 'Mañana', tone: 'amber' as const },
          preview: null,
          decide: { itemId: 'i2', contentHash: 'h2', approveLabel: 'Hacerlo' },
          href: '/pagar',
          hrefLabel: 'Ver de dónde sale',
          ageLabel: 'espera hace 5 horas',
          risk: { label: 'Riesgo alto', tone: 'rose' as const },
        },
        {
          id: 'a3',
          title: 'Revisar la hoja «Prealertas»',
          detail: 'No llegan filas desde las 10 p. m.; suelen llegar cada 40 min',
          badge: { label: 'Urgente', tone: 'rose' as const },
          preview: null,
          decide: null,
          href: '/feed',
          hrefLabel: 'Abrir',
          ageLabel: 'espera hace 9 horas',
          risk: null,
        },
      ];
  const parties = [
    { name: 'Frigoandes', amount: '$ 12.740.000', count: 3, status: '41 días vencida', late: true },
    {
      name: 'Nexa Logística',
      amount: '$ 8.350.000',
      count: 2,
      status: '12 días vencida',
      late: true,
    },
    {
      name: 'Cementos Valle',
      amount: '$ 6.100.000',
      count: 1,
      status: 'vence 20 oct',
      late: false,
    },
  ];
  const view: HoyView = {
    today: TODAY,
    dateLabel: 'sábado 10 de octubre',
    greeting: 'Buenos días',
    firstName: 'Mateo',
    narrative: narrative({
      today: TODAY,
      currency: 'COP',
      cash: opts.sinPlata ? null : { total: cashTotal, minimum: 15_000_000 },
      forecast: opts.sinPlata ? null : fc,
      overdue: opts.sinPlata ? null : { total: overdueNow, biggest: 'Frigoandes' },
      waiting: todos.length,
      autopilotDone: 4,
    }),
    money: opts.sinPlata ? null : { currency: 'COP', metrics: built.metrics, kpis: built.kpis },
    todos,
    todosMore: opts.vacio ? 0 : 2,
    snoozed: opts.vacio ? 0 : 2,
    todosMoreHref: '/piloto/panel',
    canDecide: true,
    done: [
      {
        id: 'd1',
        title: 'Aprobar la cotización de Agrícola del Sur',
        timeLabel: '8:05 a. m.',
        href: null,
      },
    ],
    due: opts.sinPlata
      ? null
      : { total: '$ 31.940.000', overdue: '$ 21.190.000', parties, href: '/finance#me-deben' },
    ops: buildOps({
      today: TODAY,
      runs: Array.from({ length: 14 }, (_, i) => ({
        day: addDaysIso(TODAY, -i),
        done: i === 0 ? 4 : 2 + ((i * 3) % 5),
        failed: i === 0 ? 1 : i % 6 === 0 ? 2 : 0,
      })),
      approvals: { count: opts.vacio ? 0 : 5, oldestDays: opts.vacio ? null : 3 },
      commitments: { overdue: opts.vacio ? 0 : 2, oldestDays: opts.vacio ? null : 6 },
    }),
    activity: [
      {
        id: 'x1',
        eventIds: ['x1'],
        when: 'Hoy 08:05',
        text: 'Aprobé la cotización de Agrícola del Sur',
        on: 'Documento',
        who: 'Solo, con permiso',
        failed: false,
        undoLabel: null,
      },
      {
        id: 'x2',
        eventIds: ['x2'],
        when: 'Hoy 07:40',
        text: 'Cruzé 3 pagos con sus facturas',
        on: 'Plata',
        who: 'Solo, con permiso',
        failed: false,
        undoLabel: null,
      },
      {
        id: 'x3',
        eventIds: ['x3'],
        when: 'Ayer 17:12',
        text: 'Envié un correo a Nexa Logística por FE-2198',
        on: 'Correo',
        who: 'Aprobado por ti',
        failed: false,
        undoLabel: null,
      },
      {
        id: 'x4',
        eventIds: ['x4'],
        when: 'Ayer 16:50',
        text: 'Anoté una fila en Prealertas',
        on: 'Tabla',
        who: 'Pedido por Ana',
        failed: false,
        undoLabel: 'Quitar la fila',
      },
      {
        id: 'x5',
        eventIds: ['x5'],
        when: 'Ayer 09:30',
        text: 'No pude completar esto: leí la hoja «Prealertas»',
        on: 'Tabla',
        who: 'Solo, con permiso',
        failed: true,
        undoLabel: null,
      },
    ],
    closing: {
      text: 'Hoy hice cuatro cosas solo: cruzar tres pagos y avisar de una factura.',
      href: '/actividad',
      hrefLabel: 'Ver todo lo que hizo',
    },
    panelHref: '/piloto/panel',
  };
  return view;
}
