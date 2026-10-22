import { logger } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../../commitments/shape';
import { registerTool } from '../../index';
import { canSeePayrollDetail } from '../../ledger/privacy';
import { humanReportError } from '../../statements/report-errors';
import { providerName } from '../providers';
import { listAccountingConnections, openAccountingSession } from '../store';
import {
  LIVE_GROUPS,
  LIVE_RESOURCES,
  LIVE_STATUSES,
  type LiveRequest,
  type LiveResult,
  type LiveTrialRow,
  renderLive,
} from './shape';

/**
 * `accounting.query` — consulta EN VIVO al programa contable conectado. Sólo
 * lectura. Complementa lo sincronizado (tablas, cartera) y los estados
 * financieros: sirve para cualquier documento o cuenta que el programa exponga
 * en su API, sin esperar a que se sincronice.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'AAAA-MM-DD');

export function trialRows(
  rows: LiveTrialRow[],
  opts: { account?: string; level?: number },
): LiveTrialRow[] {
  const prefix = (opts.account ?? '').replace(/\D/g, '');
  const level = opts.level ?? (prefix ? undefined : 2);
  return rows
    .filter((r) => (prefix ? r.code.startsWith(prefix) : true))
    .filter((r) => (level ? r.code.length === level : true))
    .filter((r) => Math.abs(r.debit) + Math.abs(r.credit) + Math.abs(r.final) + Math.abs(r.initial) > 0.004)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export const accountingQuery = registerTool({
  id: 'accounting.query',
  description:
    'Read LIVE from the connected accounting program (Siigo today; Alegra and QuickBooks do not support live queries from Cortex yet and the tool says so). Read-only. Everything important is already synced as tables (purchases, supplier payments, journal lines, quotations, stock by warehouse, statements month by month, payroll cost, catalogs): for dashboards, charts, rules and anything recurring use those tables; use this live read for a one-off question, a document or account that is not in the synced tables or in the financial statements, or a very fresh figure: sales invoices (facturas_venta), credit notes (notas_credito), purchases / supplier invoices (compras), documento soporte, cash receipts (recibos_caja), payments and egresos (pagos), accounting vouchers with their lines per PUC account (comprobantes), third parties (terceros: clientes/proveedores), products, taxes (impuestos) and the trial balance (balance_prueba) by date range and level or account. Filters: from/to dates, party (NIT or name), number, account (PUC prefix), status (con_saldo, pagada, anulada), groupBy (mes, tercero, cuenta, producto) with totals. It reads up to maxDocuments documents and says how many were left out; for long ranges query month by month. For a month-by-month income statement use the financial statements tool with section mensual instead. Payroll lines (5105, 2505…) show per person only to admins and owners; everyone else gets company totals. This live read covers ONLY the accounting program: sheets or tables declared as accounting sources (accounting.sources_list) are not in it — for combined figures (program + sheets, without double counting, with the origin of each figure) use cortex.ventas / cortex.por_pagar / cortex.pagos, receivables, or statements.get, and say which origins feed the figure. Never show tool ids to the person; say «consulté Siigo en vivo».',
  inputSchema: z.object({
    resource: z.enum(LIVE_RESOURCES),
    from: DATE.nullish().describe('Desde (AAAA-MM-DD). Por defecto, el 1 de enero del año en curso.'),
    to: DATE.nullish().describe('Hasta (AAAA-MM-DD). Por defecto, hoy.'),
    party: z.string().max(120).nullish().describe('NIT/cédula o parte del nombre del tercero.'),
    number: z.string().max(60).nullish().describe('Número o prefijo del documento («FV-1-1234», «RC»).'),
    account: z.string().max(20).nullish().describe('Cuenta PUC o prefijo («1305», «5105»).'),
    status: z.enum(LIVE_STATUSES).nullish(),
    groupBy: z.enum(LIVE_GROUPS).nullish().describe('Agrupar y sumar por mes, tercero, cuenta o producto.'),
    level: z.number().int().min(1).max(10).nullish().describe('Balance de prueba o agrupación por cuenta: dígitos del nivel (2 grupo, 4 cuenta, 6 subcuenta).'),
    relationship: z.enum(['cliente', 'proveedor', 'todos']).nullish().describe('Terceros: sólo clientes, sólo proveedores o todos.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Cuántos documentos listar; los totales cubren todos los revisados.'),
    includeLines: z.boolean().default(false).describe('Mostrar las líneas (ítems o cuentas) de los primeros documentos.'),
    maxDocuments: z.number().int().min(100).max(10000).nullish().describe('Tope de documentos a revisar (por defecto 3000).'),
    provider: z.enum(['siigo', 'alegra', 'quickbooks']).nullish().describe('Cuál programa, si hay varios conectados.'),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    provider: z.string().nullable(),
    resource: z.string(),
    count: z.number(),
    total: z.number().nullable(),
    balance: z.number().nullable(),
    partial: z.boolean(),
    groups: z.array(z.any()),
    docs: z.array(z.any()),
    records: z.array(z.any()),
  }),
  rateLimit: { perMinute: 12 },
  handler: async (input, ctx) => {
    const empty = (markdown: string, provider: string | null = null) => ({
      markdown,
      provider,
      resource: input.resource,
      count: 0,
      total: null,
      balance: null,
      partial: false,
      groups: [],
      docs: [],
      records: [],
    });
    const connections = (await listAccountingConnections(ctx.db)).filter((c) => c.enabled);
    if (!connections.length)
      return empty(
        'No hay programa contable conectado, así que no puedo consultar en vivo. Un administrador lo conecta en Integraciones → Programas contables (la llave nunca pasa por el chat).',
      );
    const conn = input.provider
      ? connections.find((c) => c.provider === input.provider)
      : connections[0];
    if (!conn)
      return empty(`${providerName(input.provider ?? '')} no está conectado.`);
    const name = providerName(conn.provider);
    const today = bogotaToday();
    const req: LiveRequest = {
      resource: input.resource,
      from: input.from ?? `${today.slice(0, 4)}-01-01`,
      to: input.to ?? today,
      party: input.party ?? undefined,
      number: input.number ?? undefined,
      account: input.account ?? undefined,
      status: input.status ?? undefined,
      groupBy: input.groupBy ?? undefined,
      level: input.level ?? undefined,
      relationship: input.relationship ?? undefined,
      limit: input.limit,
      includeLines: input.includeLines,
      maxDocuments: input.maxDocuments ?? undefined,
      canSeePayroll: await canSeePayrollDetail(ctx.db, ctx.userId),
    };
    try {
      const session = await openAccountingSession(ctx.db, conn.id);
      let result: LiveResult;
      if (input.resource === 'balance_prueba') {
        if (!session.reports?.trialBalance)
          return empty(
            `${name} no entrega el balance de prueba por API. Los estados de resultados y el balance general sí se leen con los estados financieros.`,
            conn.provider,
          );
        const rows = await session.reports.trialBalance(req.from as string, req.to as string);
        const trial = trialRows(rows, { account: req.account, level: req.level });
        result = {
          provider: name,
          resource: 'balance_prueba',
          currency: 'COP',
          docs: [],
          records: [],
          trial,
          groups: [],
          totals: { count: trial.length, total: 0, balance: null },
          scanned: rows.length,
          reported: rows.length,
          partial: false,
          notes: ['Un balance de prueba cubre un solo año; para mes a mes, pide el estado de resultados mensual.'],
        };
      } else {
        if (!session.live)
          return empty(
            `${name} todavía no permite consultas en vivo desde Cortex. Puedo mostrar lo que ya está sincronizado (clientes, productos, facturas y pagos) y los estados financieros.`,
            conn.provider,
          );
        result = await session.live(req);
      }
      return {
        markdown: renderLive(result, req),
        provider: conn.provider,
        resource: input.resource,
        count: result.resource === 'balance_prueba' ? result.trial.length : result.records.length || result.totals.count,
        total: result.totals.total,
        balance: result.totals.balance,
        partial: result.partial,
        groups: result.groups.slice(0, 60),
        docs: result.docs.slice(0, input.limit).map((d) => ({ ...d, lines: input.includeLines ? d.lines?.slice(0, 40) : undefined })),
        records: result.records.slice(0, input.limit),
      };
    } catch (err) {
      const h = humanReportError(err, 'esa consulta', name);
      logger.warn({ err, provider: conn.provider, resource: input.resource }, 'accounting.query falló');
      return empty(h.message, conn.provider);
    }
  },
});
