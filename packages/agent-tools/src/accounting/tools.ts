import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
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
 * Dos herramientas, a propósito ninguna para CONECTAR: la llave de Siigo la
 * pega un administrador en Integraciones y no pasa nunca por el modelo ni por
 * la conversación. Desde aquí se puede preguntar cómo va («¿Siigo está al
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
  if (c.entities.includes('invoices'))
    lines.push(
      '- Las facturas con saldo entran a la cartera y a la plata en riesgo con el saldo que dice el programa.',
    );
  return lines.join('\n');
}

export const accountingStatus = registerTool({
  id: 'accounting.status',
  description:
    'Show the connected accounting programs (Siigo today; Alegra and QuickBooks coming): whether each is up to date, last sync, what it brings (customers, products, invoices, payments), which company tables it fills and any error. Read-only. Use it when the person asks about Siigo, their accounting program, or why invoices are or are not showing.',
  inputSchema: z.object({}),
  outputSchema: z.object({ markdown: z.string(), connected: z.number().int() }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const connections = await listAccountingConnections(ctx.db);
    const soon = listAccountingProviders()
      .filter((p) => !connections.some((c) => c.provider === p.id))
      .map((p) => (p.available ? `${p.name} (se puede conectar)` : `${p.name} (próximamente)`));
    if (!connections.length)
      return {
        connected: 0,
        markdown: `No hay ningún programa contable conectado. Un administrador lo conecta en Integraciones → Programas contables, pegando la llave del programa (la llave nunca pasa por el chat). Disponibles: ${soon.join(', ')}.`,
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
    'Bring data from a connected accounting program (Siigo) right now instead of waiting for the next scheduled sync: new and changed customers, products, invoices and payments go into their company tables and invoices with a balance into receivables. Requires confirmation. It cannot connect a program — that is done by an admin in Integrations.',
  inputSchema: z.object({
    provider: z
      .enum(ACCOUNTING_PROVIDER_IDS as unknown as [string, ...string[]])
      .default('siigo')
      .describe('Which accounting program: siigo, alegra or quickbooks.'),
  }),
  outputSchema: z.object({ queued: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const provider = input.provider ?? 'siigo';
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
