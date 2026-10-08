import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { COMP_SENSITIVITY_NOTE } from '../payroll/sensitive';
import { PAYROLL_GROUP_LABEL } from './payroll';
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
          ? 'al día'
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
      `- ${ENTITY_LABEL[entity]} → tabla «${spec.name}» (\`${spec.slug}\`)${n ? `: última corrida ${n.inserted} nuevas, ${n.updated} actualizadas` : ''}`,
    );
  }
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
    'Show the connected accounting programs (Siigo, Alegra, QuickBooks Online): whether each is up to date, last sync, what it brings (customers, products, invoices, payments), which company tables it fills and any error. Read-only. Use it when the person asks about Siigo, Alegra, QuickBooks, their accounting program, or why invoices are or are not showing.',
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
    'Bring data from a connected accounting program (Siigo, Alegra or QuickBooks) right now instead of waiting for the next scheduled sync: new and changed customers, products, invoices and payments go into their company tables and invoices with a balance into receivables. Requires confirmation. It cannot connect a program — that is done by an admin in Integrations.',
  inputSchema: z.object({
    provider: z
      .enum(ACCOUNTING_PROVIDER_IDS as unknown as [string, ...string[]])
      .optional()
      .describe(
        'Which accounting program: siigo, alegra or quickbooks. Omit it when only one is connected.',
      ),
  }),
  outputSchema: z.object({ queued: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
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
  description: `Payroll read from the connected accounting program (Siigo) — NOT from Cortex's own payroll screen. Siigo has no payroll API, so Cortex reads the payroll accounting entries (comprobantes contables: gastos de personal 5105/5205/7205, salarios por pagar 2505, retenciones y aportes 2370, provisiones 2510–2525) when the company turned on «Nómina» in Integrations → Programa contable → Qué traer. Returns per month: devengado, prestaciones, aportes, total cost to the company, neto a pagar, deducciones, provisiones and the amount per concept. Per-person figures (by identification number) come back ONLY when the person asking is an admin or owner; anyone else gets company totals. Use it for «¿cuánto nos costó la nómina en agosto según Siigo?», «¿cuánto se provisionó de prima?». Figures are accrual (what was booked), not cash paid. ${COMP_SENSITIVITY_NOTE}`,
  inputSchema: z.object({
    months: z.number().int().min(1).max(36).default(6).describe('How many recent months to show.'),
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish()
      .describe('One month, YYYY-MM. Also asks for the per-person detail (admins only).'),
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
    const conn = connections.find((c) => c.entities.includes('payroll'));
    const view = await readPayrollView(ctx.db, {
      viewerId: ctx.userId,
      months: input.months,
      period: input.period ?? undefined,
      today: bogotaToday(),
    });
    if (!view.periods.length)
      return {
        periods: [],
        people: [],
        detail: view.detail,
        markdown: conn
          ? `${providerName(conn.provider)} tiene la nómina activada pero todavía no ha llegado ningún comprobante de nómina (la primera carga puede tardar unos minutos). Si Siigo no contabiliza la nómina con cuentas 5105/2505, no hay qué leer: en ese caso la nómina se liquida en la pantalla Nómina de Cortex. No inventes cifras.`
          : 'Ningún programa contable tiene activada la nómina. Un administrador la enciende en Integraciones → Programa contable → «Qué traer» → Nómina. Siigo no tiene API de nómina: Cortex lee los comprobantes contables de nómina. No inventes cifras.',
      };
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
