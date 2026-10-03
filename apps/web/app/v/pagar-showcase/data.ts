import type { InvoiceView, PayablesScreenData, SupplierView } from '@/lib/payables/view';
import {
  type ForecastWeek,
  type PayableLine,
  type PayableStatus,
  checkPayable,
  nitDv,
  payPlanByWeek,
} from '@cortex/agent-tools';

/**
 * Cuentas por pagar inventadas para el escaparate: las facturas de proveedor
 * de Transportes del Valle, revisadas con el motor de verdad (checks.ts) y el
 * programa de pagos armado con payPlanByWeek sobre una proyección de juguete.
 */

export const TODAY = '2026-10-05';
const TEAM = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Mateo Ángel' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Laura Gómez' },
];

interface Seed {
  id: string;
  supplier: string;
  nit: string;
  dv: string;
  number: string;
  status: PayableStatus;
  issue: string;
  due: string | null;
  subtotal: number;
  iva: number;
  retefuente?: number;
  source: string;
  scheduled?: string;
  paid?: string;
  lines?: PayableLine[];
  customerNit?: string;
  orderReference?: string;
  subject?: string;
}

const line = (
  description: string,
  quantity: number,
  unitPrice: number,
  code: string | null = null,
): PayableLine => ({
  position: 1,
  description,
  code,
  quantity,
  unit: '94',
  unitPrice,
  amount: quantity * unitPrice,
});

const SEEDS: Seed[] = [
  {
    id: 'a1',
    supplier: 'Papelería El Cóndor S.A.S.',
    nit: '900373115',
    dv: '2',
    number: 'FEPA-451',
    status: 'por_aprobar',
    issue: '2026-09-28',
    due: '2026-10-28',
    subtotal: 2_000_000,
    iva: 380_000,
    retefuente: 50_000,
    source: 'correo',
    lines: [
      line('Resma papel carta 75 g', 100, 15_000, 'RES-75'),
      line('Tóner HP 85A', 50, 10_000),
    ],
    subject: 'Factura electrónica FEPA-451',
    orderReference: 'OC-0118',
  },
  {
    id: 'a2',
    supplier: 'Llantas del Pacífico',
    nit: '805011223',
    dv: '0',
    number: 'LP-9921',
    status: 'recibida',
    issue: '2026-10-01',
    due: '2026-10-16',
    subtotal: 8_400_000,
    iva: 1_596_000,
    source: 'correo',
    subject: 'FE LP-9921 Transportes del Valle',
  },
  {
    id: 'a3',
    supplier: 'Llantas del Pacífico',
    nit: '805011223',
    dv: '0',
    number: 'LP-9917',
    status: 'aprobada',
    issue: '2026-09-27',
    due: '2026-10-12',
    subtotal: 8_400_000,
    iva: 1_596_000,
    retefuente: 210_000,
    source: 'contable',
  },
  {
    id: 'a4',
    supplier: 'Combustibles Terpel Cali',
    nit: '830095213',
    dv: '0',
    number: 'TC-55120',
    status: 'por_aprobar',
    issue: '2026-09-30',
    due: '2026-10-10',
    subtotal: 12_600_000,
    iva: 0,
    source: 'documento',
    customerNit: '901222333',
  },
  {
    id: 'a5',
    supplier: 'Inmobiliaria Los Andes',
    nit: '800111222',
    dv: '9',
    number: 'ARR-10',
    status: 'programada',
    issue: '2026-10-01',
    due: '2026-10-05',
    subtotal: 6_500_000,
    iva: 0,
    retefuente: 227_500,
    source: 'contable',
    scheduled: '2026-10-05',
  },
  {
    id: 'a6',
    supplier: 'Taller Mecánico El Pibe',
    nit: '1144055667',
    dv: '1',
    number: 'TM-312',
    status: 'programada',
    issue: '2026-09-25',
    due: '2026-10-09',
    subtotal: 3_200_000,
    iva: 608_000,
    retefuente: 128_000,
    source: 'chat',
    scheduled: '2026-10-14',
  },
  {
    id: 'a7',
    supplier: 'Seguros Bolívar',
    nit: '860002503',
    dv: '2',
    number: 'SB-77812',
    status: 'aprobada',
    issue: '2026-10-02',
    due: '2026-10-20',
    subtotal: 4_100_000,
    iva: 779_000,
    source: 'correo',
  },
  {
    id: 'a8',
    supplier: 'Papelería El Cóndor S.A.S.',
    nit: '900373115',
    dv: '2',
    number: 'FEPA-402',
    status: 'pagada',
    issue: '2026-08-28',
    due: '2026-09-27',
    subtotal: 1_200_000,
    iva: 228_000,
    retefuente: 30_000,
    source: 'correo',
    paid: '2026-09-26',
    lines: [line('Resma papel carta 75 g', 80, 12_000, 'RES-75')],
  },
  {
    id: 'a9',
    supplier: 'Publicidad Visual SAS',
    nit: '901444555',
    dv: '6',
    number: 'PV-88',
    status: 'rechazada',
    issue: '2026-09-20',
    due: '2026-10-20',
    subtotal: 900_000,
    iva: 171_000,
    source: 'correo',
  },
];

function toView(s: Seed): InvoiceView {
  const total = s.subtotal + s.iva;
  const w = { retefuente: s.retefuente ?? 0, reteiva: 0, reteica: 0 };
  const history = SEEDS.filter(
    (o) => o.nit === s.nit && o.id !== s.id && o.status !== 'rechazada' && o.issue <= s.issue,
  ).map((o) => ({
    id: o.id,
    docNumber: o.number,
    issueDate: o.issue,
    total: o.subtotal + o.iva,
    currency: 'COP',
    status: o.status,
    lines: o.lines ?? [],
  }));
  const checks = checkPayable(
    {
      docNumber: s.number,
      supplierNit: s.nit,
      supplierDv: String(nitDv(s.nit) ?? s.dv),
      supplierName: s.supplier,
      customerNit: s.customerNit ?? '890399001',
      currency: 'COP',
      issueDate: s.issue,
      dueDate: s.due,
      subtotal: s.subtotal,
      total,
      lines: s.lines ?? [],
      withholdings: w,
      orderReference: s.orderReference ?? null,
      dianAccepted: s.source === 'correo' ? true : null,
    },
    {
      today: TODAY,
      companyNit: '890399001',
      supplier: { nit: s.nit, name: s.supplier, hasWithholdingRates: (s.retefuente ?? 0) > 0 },
      history,
      purchaseOrder:
        s.orderReference === 'OC-0118'
          ? {
              id: 'po',
              number: 'OC-0118',
              total,
              currency: 'COP',
              status: 'recibida',
              lines: [{ code: 'RES-75', description: 'Resma', quantity: 100, unitPrice: 15_000 }],
            }
          : null,
      purchaseOrdersAvailable: true,
    },
  );
  return {
    id: `00000000-0000-4000-8000-0000000000${s.id.slice(1).padStart(2, '0')}`,
    supplierId: s.nit,
    supplierName: s.supplier,
    supplierNit: s.nit,
    docNumber: s.number,
    cufe: s.source === 'correo' ? '8bb4b3c7a6f1e2d9c0b1a2f3e4d5c6b7' : null,
    status: s.status,
    source: s.source,
    currency: 'COP',
    issueDate: s.issue,
    dueDate: s.due,
    scheduledPayDate: s.scheduled ?? null,
    paidAt: s.paid ?? null,
    subtotal: s.subtotal,
    iva: s.iva,
    total,
    withholdings: w,
    netAmount: total - w.retefuente,
    checks: s.status === 'pagada' ? [] : checks,
    lines: s.lines ?? [],
    orderReference: s.orderReference ?? null,
    rejectionReason: s.status === 'rechazada' ? 'No se pidió: publicidad no autorizada.' : null,
    evidence: {
      subject: s.subject ?? null,
      from: s.subject ? 'facturacion@proveedor.com' : null,
      files: s.subject ? ['ad0900373115.xml', 'fv0900373115.pdf'] : [],
      note: null,
    },
    paidEvidence: s.paid ? { kind: 'bank', reference: null, note: null } : null,
    dianValidated: s.source === 'correo' ? true : null,
    approverName: s.nit === '805011223' ? 'Laura Gómez' : null,
  };
}

function weeks(): ForecastWeek[] {
  const starts = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const closing = [48_000_000, 21_500_000, 14_000_000, 31_000_000];
  return starts.map((start, i) => ({
    start,
    opening: i === 0 ? 61_000_000 : (closing[i - 1] as number),
    inflows: 18_000_000,
    outflows: 30_000_000,
    closing: closing[i] as number,
    items: [],
  }));
}

export function fixture(opts: { empty?: boolean; failing?: boolean } = {}): PayablesScreenData {
  const invoices = opts.empty ? [] : SEEDS.map(toView);
  const suppliers: SupplierView[] = opts.empty
    ? []
    : [...new Map(SEEDS.map((s) => [s.nit, s])).values()].map((s) => {
        const mine = invoices.filter((i) => i.supplierId === s.nit);
        const open = mine.filter((i) =>
          ['recibida', 'por_aprobar', 'aprobada', 'programada'].includes(i.status),
        );
        return {
          id: s.nit,
          name: s.supplier,
          nit: s.nit,
          email: null,
          paymentTermsDays: s.nit === '800111222' ? 5 : 30,
          approverId: s.nit === '805011223' ? (TEAM[1]?.id ?? null) : null,
          retefuenteRate: s.retefuente ? 2.5 : null,
          reteivaRate: null,
          reteicaRate: null,
          openCount: open.length,
          openAmount: open.reduce((sum, i) => sum + i.netAmount, 0),
          lastIssue:
            mine
              .map((i) => i.issueDate)
              .sort()
              .pop() ?? null,
        };
      });
  const w = weeks();
  const scheduled = invoices.filter((i) => i.status === 'programada' && i.scheduledPayDate);
  const awaiting = invoices.filter((i) => i.status === 'recibida' || i.status === 'por_aprobar');
  return {
    today: TODAY,
    invoices,
    suppliers,
    plan: opts.failing
      ? null
      : {
          today: TODAY,
          currency: 'COP',
          minimumCash: 20_000_000,
          weeks: payPlanByWeek({
            currency: 'COP',
            weeks: w,
            minimumCash: 20_000_000,
            invoices: scheduled.map((i) => ({
              id: i.id,
              supplierName: i.supplierName,
              docNumber: i.docNumber,
              amount: i.netAmount,
              currency: i.currency,
              date: i.scheduledPayDate as string,
              status: i.status,
            })),
          }),
          unscheduled: invoices
            .filter((i) => i.status === 'aprobada')
            .map((i) => ({
              id: i.id,
              supplierName: i.supplierName,
              docNumber: i.docNumber,
              amount: i.netAmount,
              currency: i.currency,
              dueDate: i.dueDate,
            })),
          awaiting: {
            count: awaiting.length,
            amount: awaiting.reduce((s, i) => s + i.netAmount, 0),
            firstDue: '2026-10-10',
          },
        },
    planError: opts.failing ? 'la proyección de caja no respondió' : null,
    team: TEAM,
    canManage: true,
  };
}
