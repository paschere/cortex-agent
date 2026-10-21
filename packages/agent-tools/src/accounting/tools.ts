import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { COMP_SENSITIVITY_NOTE } from '../payroll/sensitive';
import { PAYROLL_GROUP_LABEL } from './payroll';
import { livePayrollMarkdown, livePayrollRanges, readLivePayroll } from './payroll-live';
import { canSeePayrollDetail } from '../ledger/privacy';
import { monthEnd } from '../statements/store';
import { auditPayrollRead, readPayrollMovements } from './payroll-access';
import { readPayrollView } from './payroll-store';
import { getAccountingProvider, listAccountingProviders, providerName } from './providers';
import {
  type AccountingConnectionRow,
  getAccountingConnection,
  listAccountingConnections,
  requestAccountingSync,
} from './store';
import { accountingTableSpec } from './tables';
import { ACCOUNTING_ENTITIES, ACCOUNTING_PROVIDER_IDS, type AccountingEntity } from './types';

/**
 * Los programas contables desde el chat (migración 0165).
 *
 * Dos herramientas, a propósito ninguna para CONECTAR: la llave de Siigo o de
 * Alegra la pega un administrador en Integraciones (QuickBooks se autoriza
 * entrando a Intuit), y no pasa nunca por el modelo ni por la conversación. Desde aquí se puede preguntar cómo va («¿Siigo está al
 * día?») y pedir que traiga ya, con confirmación.
 */

const ENTITY_LABEL: Record<AccountingEntity, string> = {
  customers: 'clientes',
  products: 'productos',
  invoices: 'facturas',
  payments: 'pagos',
  credit_notes: 'notas crédito',
  purchases: 'compras y documentos soporte',
  supplier_payments: 'pagos a proveedores (egresos)',
  journal_lines: 'movimientos de comprobantes contables',
  quotations: 'cotizaciones',
  stock: 'existencias por bodega',
  statements: 'estados financieros mes a mes',
  payroll_costs: 'costo de nómina por mes (totales de la empresa)',
  cost_centers: 'centros de costo',
  taxes: 'impuestos y retenciones',
  payment_methods: 'formas de pago',
  warehouses: 'bodegas',
  document_types: 'tipos de documento',
  sellers: 'vendedores',
  accounts_payable: 'cuentas por pagar (reporte oficial del programa, con vencimientos; compáralo con las compras)',
  party_balances: 'saldos por tercero y cuenta mes a mes (balance de prueba por tercero; sirve para cuadrar cartera y por pagar contra la contabilidad)',
  product_prices: 'precios de cada producto por lista de precios',
  fixed_assets: 'activos fijos',
  price_lists: 'listas de precios',
  account_groups: 'grupos de inventario',
  expense_concepts: 'conceptos de descuento de los recibos de caja',
  cities: 'ciudades y municipios con código DANE',
};

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : 'aún no';
}

function describeConnection(c: AccountingConnectionRow): string {
  const name = providerName(c.provider);
  const state = !c.enabled
    ? 'en pausa'
    : c.last_status === 'error'
      ? `con error: ${c.last_error ?? 'sin detalle'}`
      : c.last_status === 'partial'
        ? 'trayendo la primera carga (sigue sola)'
        : c.last_status === 'ok'
          ? c.last_counts?.warnings?.length
            ? 'sincroniza, pero NO está completo (ver avisos)'
            : 'al día'
          : 'esperando la primera sincronización';
  const lines = [
    `**${name}** (cuenta ${c.account_label}) — ${state}. Cada ${c.interval_minutes} min; última corrida: ${when(c.last_run_at)} (UTC).`,
  ];
  for (const entity of ACCOUNTING_ENTITIES) {
    if (!c.entities.includes(entity)) continue;
    const spec = accountingTableSpec(
      getAccountingProvider(c.provider) ?? { id: c.provider, name },
      entity,
    );
    const n = c.last_counts?.[entity];
    lines.push(
      `- ${ENTITY_LABEL[entity]} → tabla «${spec.name}» (\`${spec.slug}\`)${n ? `: última corrida ${n.fetched} leídas, ${n.inserted} nuevas, ${n.updated} actualizadas` : ''}`,
    );
  }
  for (const w of c.last_counts?.warnings ?? []) lines.push(`- ATENCIÓN: ${w}`);
  for (const n of c.last_counts?.notes ?? []) lines.push(`- Nota (no es una falla): ${n}`);
  if (c.entities.includes('invoices') && c.provider === 'siigo')
    lines.push(
      '- Cada factura y nota crédito trae su estado ante la DIAN (factura_electronica: Aceptada, Rechazada, Pendiente, Sin enviar), el CUFE/CUDE, el mensaje de rechazo (mensaje_dian) y un enlace «Descargar PDF» (pdf) que pide el archivo a Siigo en el momento; el XML de facturas está en la misma ruta cambiando pdf por xml.',
    );
  if (c.entities.includes('payroll'))
    lines.push(
      '- nómina → comprobantes contables de nómina (no hay API de nómina en Siigo), confidenciales; se consultan con accounting.payroll_summary.',
    );
  if (c.entities.includes('invoices'))
    lines.push(
      '- Las facturas con saldo entran a la cartera y a la plata en riesgo con el saldo que dice el programa.',
    );
  return lines.join('\n');
}

export const accountingStatus = registerTool({
  id: 'accounting.status',
  description:
    'Show the connected accounting programs (Siigo, Alegra, QuickBooks Online): whether each is up to date, last sync, what it brings (customers and suppliers, products, invoices, payments, credit notes, purchases, supplier payments, journal movements, quotations, stock by warehouse, statements by month, payroll cost, catalogs), which company tables it fills (including DIAN status of invoices, official accounts payable, balance by third party, fixed assets, price lists, inventory groups and DANE cities) and any error. Read-only. Use it when the person asks about Siigo, Alegra, QuickBooks, their accounting program, or why invoices are or are not showing.',
  inputSchema: z.object({}),
  outputSchema: z.object({ markdown: z.string(), connected: z.number().int() }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const connections = await listAccountingConnections(ctx.db);
    const soon = listAccountingProviders()
      .filter((p) => !connections.some((c) => c.provider === p.id))
      .map((p) =>
        !p.available
          ? `${p.name} (próximamente)`
          : p.setupMissing
            ? `${p.name} (falta configurar su app en esta instalación)`
            : `${p.name} (se puede conectar)`,
      );
    if (!connections.length)
      return {
        connected: 0,
        markdown: `No hay ningún programa contable conectado. Un administrador lo conecta en Integraciones → Programas contables (la llave nunca pasa por el chat). Disponibles: ${soon.join(', ')}.`,
      };
    return {
      connected: connections.length,
      markdown: [
        ...connections.map(describeConnection),
        soon.length ? `\nOtros: ${soon.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  },
});

export const accountingSyncNow = registerTool({
  id: 'accounting.sync_now',
  description:
    'Bring data from a connected accounting program (Siigo, Alegra or QuickBooks) right now instead of waiting for the next scheduled sync: new and changed customers, products, invoices and payments go into their company tables and invoices with a balance into receivables. It runs without asking for confirmation (the connection is already authorized and it only reads). It cannot connect a program — that is done by an admin in Integrations.',
  inputSchema: z.object({
    provider: z
      .enum(ACCOUNTING_PROVIDER_IDS as unknown as [string, ...string[]])
      .optional()
      .describe(
        'Which accounting program: siigo, alegra or quickbooks. Omit it when only one is connected.',
      ),
  }),
  outputSchema: z.object({ queued: z.boolean(), markdown: z.string() }),
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    let provider = input.provider;
    if (!provider) {
      // Sin decir cuál: el único conectado; si hay varios, que lo diga.
      const connected = await listAccountingConnections(ctx.db);
      if (connected.length > 1)
        throw new ValidationError(
          `Hay varios programas contables conectados (${connected.map((c) => providerName(c.provider)).join(', ')}). Dime cuál sincronizo.`,
        );
      provider = connected[0]?.provider ?? 'siigo';
    }
    const name = providerName(provider);
    const existing = await getAccountingConnection(ctx.db, provider);
    if (!existing)
      throw new ValidationError(
        `${name} no está conectado. Un administrador lo conecta en Integraciones → Programas contables.`,
      );
    const conn = await requestAccountingSync(ctx.db, provider);
    const queued = Boolean(
      await ctx.enqueueJob?.('accounting/run', {
        organizationId: ctx.organizationId,
        connectionId: conn.id,
      }),
    );
    return {
      queued,
      markdown: queued
        ? `Listo: estoy trayendo lo nuevo de ${name}. Las tablas se actualizan en unos minutos${conn.notify ? ' y te aviso en la campana si entran facturas o pagos nuevos' : ''}.`
        : `Dejé ${name} marcado para sincronizar en la próxima vuelta del trabajo programado (como mucho 15 minutos).`,
    };
  },
});

const cop = (n: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);

export const accountingPayrollSummary = registerTool({
  id: 'accounting.payroll_summary',
  description: `What the payroll costs, read from the connected accounting program (Siigo) — works as soon as the program is connected, with no setup. If «Nómina» is turned on in Integrations → Programa contable → «Qué traer» and payroll entries have synced, it reads them (per month: devengado, prestaciones, aportes, total cost, neto a pagar, deducciones, provisiones; per person ONLY for admins/owners). Otherwise it computes the cost LIVE from Siigo's monthly trial balance: per month the total personnel expense (accounts 5105 administración + 5205 ventas + 7205 producción), the breakdown by concept (sueldos, horas extra, auxilio de transporte, cesantías, prima, vacaciones, aportes…), by area and totals — company totals only, never per person. Figures are accrual (what was booked), not cash paid. Use it for «¿cuánto cuesta la nómina?», «¿cuánto nos costó la nómina en agosto?», «¿cuánto se pagó en prima?». Range: months (last N), period (one month), or year + fromMonth/throughMonth. This is NOT Cortex's own liquidated payroll (payroll.period_summary): when the person asks about cost, show both if Cortex has liquidated periods. If it returns no personnel expense it says so for that range; never claim you cannot read payroll just because the option is off. For per-person pay (admins/owners only) read the journal entries with accounting.query (comprobantes, accounts 5105/5205/7205/2505 grouped by tercero). ${COMP_SENSITIVITY_NOTE}`,
  inputSchema: z.object({
    months: z.number().int().min(1).max(36).default(6).describe('How many recent months to show.'),
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish()
      .describe('One month, YYYY-MM. Also asks for the per-person detail (admins only).'),
    year: z.number().int().min(2000).max(2100).nullish().describe('A calendar year (live mode).'),
    fromMonth: z.number().int().min(1).max(12).nullish().describe('First month 1-12 (with year).'),
    throughMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('Last month 1-12 (with year).'),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    periods: z.array(z.any()),
    people: z.array(z.any()),
    detail: z.boolean(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const connections = await listAccountingConnections(ctx.db);
    const view = await readPayrollView(ctx.db, {
      viewerId: ctx.userId,
      months: input.months,
      period: input.period ?? undefined,
      today: bogotaToday(),
    });
    if (!view.periods.length) {
      const live = connections.find((c) => c.enabled && c.provider === 'siigo');
      if (live) {
        const today = bogotaToday();
        const ranges = livePayrollRanges(
          {
            months: input.months ?? 6,
            period: input.period,
            year: input.year,
            fromMonth: input.fromMonth,
            throughMonth: input.throughMonth,
          },
          today,
        );
        const r = await readLivePayroll(ctx.db, { ranges, today, viewerId: ctx.userId });
        const first = ranges[0];
        const last = ranges[ranges.length - 1];
        const canSeePeople = await canSeePayrollDetail(ctx.db, ctx.userId);
        return {
          periods: r.months,
          people: [],
          detail: false,
          markdown: livePayrollMarkdown(r, {
            providerLabel: providerName(live.provider),
            from: first ? `${first.year}-${String(first.fromMonth).padStart(2, '0')}-01` : '',
            to: last ? monthEnd(last.year, last.throughMonth) : '',
            canSeePeople,
          }),
        };
      }
      return {
        periods: [],
        people: [],
        detail: view.detail,
        markdown: connections.length
          ? `${connections.map((c) => providerName(c.provider)).join(', ')} está conectado pero no permite leer el costo de personal en vivo. Un administrador puede activar «Nómina» en Integraciones → Programa contable → «Qué traer», o se liquida en la pantalla Nómina de Cortex. No inventes cifras.`
          : 'No hay ningún programa contable conectado, así que no hay de dónde leer la nómina contable. Un administrador conecta Siigo en Integraciones → Programas contables, o la nómina se liquida en la pantalla Nómina de Cortex. No inventes cifras.',
      };
    }
    if (view.people.length)
      await auditPayrollRead(ctx.db, {
        userId: ctx.userId,
        allowed: true,
        what: 'resumen de nómina por persona',
        period: input.period ?? view.periods[0]?.period ?? null,
        people: view.people.length,
      });
    const lines = view.periods.map(
      (p) =>
        `**${p.period}** — costo para la empresa ${cop(p.costoTotal)} (devengado ${cop(p.devengado)}, prestaciones ${cop(p.prestaciones)}, aportes ${cop(p.aportes)}${p.otrosPersonal ? `, otros ${cop(p.otrosPersonal)}` : ''}); neto a pagar ${cop(p.neto)}; deducciones ${cop(p.deducciones)}; provisiones ${cop(p.provisiones)}. ${p.comprobantes} comprobante(s).`,
    );
    const top = view.periods[0];
    const conceptLines = top
      ? top.conceptos
          .slice(0, 12)
          .map((c) => `- ${c.concept} (${PAYROLL_GROUP_LABEL[c.group]}): ${cop(c.amount)}`)
      : [];
    const peopleLines = view.people.map(
      (p) =>
        `- ${p.name ?? `Doc. ${p.taxId}`}: devengado ${cop(p.devengado)}, neto ${cop(p.neto)}, deducciones ${cop(p.deducciones)}`,
    );
    const privacy = view.detailHidden
      ? '\n\nHay detalle por persona en estos comprobantes, pero es confidencial: sólo lo ve quien administra la empresa.'
      : '';
    return {
      periods: view.periods,
      people: view.people,
      detail: view.detail,
      markdown: [
        'Nómina según los comprobantes contables (base causada, no caja):',
        ...lines,
        top ? `\nPor concepto en ${top.period}:\n${conceptLines.join('\n')}` : '',
        peopleLines.length
          ? `\nPor persona en ${top?.period} (confidencial):\n${peopleLines.join('\n')}`
          : '',
        privacy,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

export const accountingPayrollMovements = registerTool({
  id: 'accounting.payroll_movements',
  description:
    'The payroll accounting entries of one month WITH the third party (the person) of each line, read from the payroll entries synced from the accounting program (Siigo). CONFIDENTIAL: only admins and owners of the company can see it; for anyone else it returns nothing and says so, and you must answer with company totals (accounting.payroll_summary) instead. Every read is written to the audit log. The shared table «Movimientos contables» never shows the person on payroll accounts (5105, 2505…); this is the only door to that detail. Use it only when an admin or owner asks who was paid what, or for the entries behind a payroll month. Never copy the figures outside the conversation.',
  inputSchema: z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/).describe('The month, YYYY-MM.'),
    account: z
      .string()
      .regex(/^\d{1,10}$/)
      .nullish()
      .describe('Optional PUC account prefix, e.g. 2505 (salaries payable) or 5105.'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    allowed: z.boolean(),
    lines: z.array(z.any()),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const r = await readPayrollMovements(ctx.db, {
      viewerId: ctx.userId,
      period: input.period,
      account: input.account ?? undefined,
      limit: input.limit,
    });
    if (!r.allowed)
      return {
        allowed: false,
        lines: [],
        markdown:
          'El detalle de nómina por persona es confidencial: sólo lo ven los administradores y el dueño de la empresa. Puedo darte los totales por mes y concepto con accounting.payroll_summary. No inventes cifras por persona.',
      };
    if (!r.lines.length)
      return {
        allowed: true,
        lines: [],
        markdown: `No hay movimientos de nómina sincronizados en ${input.period}. Si «Nómina por persona» está apagada en Integraciones → Programa contable → «Qué traer», un administrador puede activarla.`,
      };
    const rows = r.lines.map(
      (l) =>
        `- ${l.date} ${l.journal ?? ''} · cuenta ${l.account} (${l.concept}) · ${l.movement === 'debit' ? 'débito' : 'crédito'} ${cop(l.amount)} · ${l.personName ?? (l.personTaxId ? `Doc. ${l.personTaxId}` : 'sin tercero')}`,
    );
    return {
      allowed: true,
      lines: r.lines,
      markdown: [
        `Movimientos de nómina de ${input.period} (confidencial; esta lectura quedó en la auditoría):`,
        ...rows,
        r.truncated ? `\n(Hay más líneas; filtra por cuenta para verlas.)` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
