import type { GridColumn, GridRow } from '@/components/datagrid/types';
import type {
  PayPlan,
  PayableCheck,
  PayableInvoice,
  PayableLine,
  PayableStatus,
  SupplierRow,
} from '@cortex/agent-tools';

/**
 * «POR PAGAR»: LO QUE LA PANTALLA NECESITA, YA ARMADO. Puro.
 *
 * El servidor (app/(app)/pagar/page.tsx) lee con el almacén de cuentas por
 * pagar y arma esto; la pantalla (components/payables) sólo dibuja. Los
 * nombres de estado y las etiquetas viven aquí (copiados del vocabulario del
 * paquete, que la pantalla no puede importar en el navegador).
 */

export const STATUS_LABEL: Record<PayableStatus, string> = {
  recibida: 'Por revisar',
  por_aprobar: 'Por aprobar',
  aprobada: 'Aprobada',
  programada: 'Programada',
  pagada: 'Pagada',
  rechazada: 'Rechazada',
};

export const STATUS_TONE: Record<
  PayableStatus,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  recibida: 'amber',
  por_aprobar: 'primary',
  aprobada: 'primary',
  programada: 'emerald',
  pagada: 'neutral',
  rechazada: 'rose',
};

export const SOURCE_LABEL: Record<string, string> = {
  correo: 'Correo',
  documento: 'Bandeja',
  contable: 'Programa contable',
  manual: 'A mano',
  chat: 'Chat',
};

export interface InvoiceView {
  id: string;
  supplierId: string | null;
  supplierName: string;
  supplierNit: string | null;
  docNumber: string;
  cufe: string | null;
  status: PayableStatus;
  source: string;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  scheduledPayDate: string | null;
  paidAt: string | null;
  subtotal: number | null;
  iva: number;
  total: number;
  withholdings: { retefuente: number; reteiva: number; reteica: number };
  netAmount: number;
  checks: PayableCheck[];
  lines: PayableLine[];
  orderReference: string | null;
  rejectionReason: string | null;
  evidence: {
    subject?: string | null;
    from?: string | null;
    files?: string[];
    note?: string | null;
  };
  paidEvidence: { kind: string; reference?: string | null; note?: string | null } | null;
  dianValidated: boolean | null;
  approverName: string | null;
}

export interface SupplierView {
  id: string;
  name: string;
  nit: string | null;
  email: string | null;
  paymentTermsDays: number | null;
  approverId: string | null;
  retefuenteRate: number | null;
  reteivaRate: number | null;
  reteicaRate: number | null;
  openCount: number;
  openAmount: number;
  lastIssue: string | null;
}

export interface PayablesScreenData {
  today: string;
  invoices: InvoiceView[];
  suppliers: SupplierView[];
  plan: PayPlan | null;
  planError: string | null;
  team: Array<{ id: string; name: string }>;
  canManage: boolean;
}

const n = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

export function invoiceView(
  inv: PayableInvoice,
  lines: PayableLine[],
  names: ReadonlyMap<string, string>,
): InvoiceView {
  return {
    id: inv.id,
    supplierId: inv.supplierId,
    supplierName: inv.supplierName,
    supplierNit: inv.supplierNit,
    docNumber: inv.docNumber,
    cufe: inv.cufe,
    status: inv.status,
    source: inv.source,
    currency: inv.currency,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    scheduledPayDate: inv.scheduledPayDate,
    paidAt: inv.paidAt,
    subtotal: inv.subtotal,
    iva: inv.iva,
    total: inv.total,
    withholdings: inv.withholdings,
    netAmount: inv.netAmount,
    checks: inv.checks,
    lines: lines.slice(0, 200),
    orderReference: inv.orderReference,
    rejectionReason: inv.rejectionReason,
    evidence: {
      subject: inv.evidence.subject ?? null,
      from: inv.evidence.from ?? null,
      files: inv.evidence.files ?? [],
      note: inv.evidence.note ?? null,
    },
    paidEvidence: inv.paidEvidence
      ? {
          kind: inv.paidEvidence.kind,
          reference: inv.paidEvidence.reference ?? null,
          note: inv.paidEvidence.note ?? null,
        }
      : null,
    dianValidated: inv.dianValidated,
    approverName: inv.approverId ? (names.get(inv.approverId) ?? null) : null,
  };
}

const OPEN: readonly PayableStatus[] = ['recibida', 'por_aprobar', 'aprobada', 'programada'];

export function supplierViews(suppliers: SupplierRow[], invoices: InvoiceView[]): SupplierView[] {
  return suppliers.map((s) => {
    const mine = invoices.filter((i) => i.supplierId === s.id);
    const open = mine.filter((i) => OPEN.includes(i.status));
    return {
      id: s.id,
      name: s.name,
      nit: s.nit,
      email: s.email,
      paymentTermsDays: s.payment_terms_days,
      approverId: s.approver_id,
      retefuenteRate: n(s.retefuente_rate),
      reteivaRate: n(s.reteiva_rate),
      reteicaRate: n(s.reteica_rate),
      openCount: open.length,
      openAmount: open.filter((i) => i.currency === 'COP').reduce((sum, i) => sum + i.netAmount, 0),
      lastIssue:
        mine
          .map((i) => i.issueDate)
          .sort()
          .pop() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// La grilla de facturas
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { block: 0, warn: 1, info: 2 } as const;

/** Lo más grave que encontró la revisión, en una frase corta. */
export function reviewHeadline(checks: readonly PayableCheck[]): string {
  const top = [...checks]
    .filter((c) => c.code !== 'po_match')
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
  if (!top)
    return checks.some((c) => c.code === 'po_match')
      ? 'Cuadra con la orden de compra'
      : 'Sin novedad';
  return top.message.length > 90 ? `${top.message.slice(0, 88)}…` : top.message;
}

export function reviewTone(checks: readonly PayableCheck[]): 'rose' | 'amber' | 'neutral' {
  if (checks.some((c) => c.severity === 'block')) return 'rose';
  if (checks.some((c) => c.severity === 'warn')) return 'amber';
  return 'neutral';
}

export const INVOICE_COLUMNS: GridColumn[] = [
  { key: 'proveedor', label: 'Proveedor', type: 'text', pinned: true, primary: true, width: 220 },
  { key: 'numero', label: 'Factura', type: 'text', width: 130 },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    width: 130,
    editable: true,
    options: (Object.keys(STATUS_LABEL) as PayableStatus[]).map((s) => ({
      value: s,
      label: STATUS_LABEL[s],
      tone: STATUS_TONE[s],
    })),
    description:
      'Cambiarlo a «Aprobada», «Programada» o «Rechazada» decide sobre las facturas elegidas.',
  },
  {
    key: 'revision',
    label: 'Revisión',
    type: 'select',
    width: 120,
    options: [
      { value: 'detiene', label: 'Detiene', tone: 'rose' },
      { value: 'revisar', label: 'Revisar', tone: 'amber' },
      { value: 'ok', label: 'Sin novedad', tone: 'emerald' },
    ],
    description:
      'Lo que encontró la revisión automática: doble cobro, NIT, precio, retención, orden de compra.',
  },
  { key: 'hallazgo', label: 'Qué encontró', type: 'text', width: 280 },
  { key: 'vence', label: 'Vence', type: 'date', width: 110 },
  { key: 'pago', label: 'Día de pago', type: 'date', width: 120 },
  { key: 'total', label: 'Total', type: 'money', width: 130 },
  {
    key: 'neto',
    label: 'A pagar (neto)',
    type: 'money',
    width: 140,
    description: 'Total menos retenciones: lo que sale del banco.',
  },
  { key: 'emision', label: 'Emitida', type: 'date', width: 110 },
  { key: 'nit', label: 'NIT', type: 'text', width: 120 },
  {
    key: 'origen',
    label: 'Llegó por',
    type: 'select',
    width: 140,
    options: Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
  },
];

export function invoiceRow(inv: InvoiceView): GridRow {
  const tone = reviewTone(inv.checks);
  return {
    id: inv.id,
    values: {
      proveedor: inv.supplierName,
      numero: inv.docNumber,
      estado: inv.status,
      revision: tone === 'rose' ? 'detiene' : tone === 'amber' ? 'revisar' : 'ok',
      hallazgo: reviewHeadline(inv.checks),
      vence: inv.dueDate,
      pago: inv.scheduledPayDate ?? inv.paidAt,
      total: inv.total,
      neto: inv.netAmount,
      emision: inv.issueDate,
      nit: inv.supplierNit,
      origen: inv.source,
    },
    locked: inv.status === 'pagada',
  };
}

export const SUPPLIER_COLUMNS = (team: Array<{ id: string; name: string }>): GridColumn[] => [
  { key: 'nombre', label: 'Proveedor', type: 'text', pinned: true, primary: true, width: 220 },
  { key: 'nit', label: 'NIT', type: 'text', width: 120 },
  { key: 'abiertas', label: 'Facturas abiertas', type: 'number', width: 130 },
  { key: 'por_pagar', label: 'Por pagar', type: 'money', width: 140 },
  {
    key: 'plazo',
    label: 'Plazo (días)',
    type: 'number',
    width: 110,
    editable: true,
    description: 'Si la factura no trae vencimiento, se usa este plazo.',
  },
  { key: 'retefuente', label: 'ReteFuente %', type: 'percent', width: 120, editable: true },
  {
    key: 'reteiva',
    label: 'ReteIVA %',
    type: 'percent',
    width: 110,
    editable: true,
    description: 'Sobre el IVA de la factura.',
  },
  { key: 'reteica', label: 'ReteICA %', type: 'percent', width: 110, editable: true },
  {
    key: 'aprobador',
    label: 'Quién aprueba',
    type: 'select',
    width: 160,
    editable: true,
    options: team.map((m) => ({ value: m.id, label: m.name })),
    description: 'Sin nadie: cualquier dueño o administrador.',
  },
  { key: 'ultima', label: 'Última factura', type: 'date', width: 120 },
];

export function supplierRow(s: SupplierView): GridRow {
  return {
    id: s.id,
    values: {
      nombre: s.name,
      nit: s.nit,
      abiertas: s.openCount,
      por_pagar: s.openAmount,
      plazo: s.paymentTermsDays,
      retefuente: s.retefuenteRate,
      reteiva: s.reteivaRate,
      reteica: s.reteicaRate,
      aprobador: s.approverId,
      ultima: s.lastIssue,
    },
  };
}

export const PAYABLES_ASK_CONTEXT =
  'Sobre mis facturas de proveedor (cuentas por pagar): qué está por aprobar, qué encontró la revisión y qué hay que pagar esta semana.';
