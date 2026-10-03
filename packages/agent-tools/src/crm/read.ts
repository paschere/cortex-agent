import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ClientInvoice,
  type LedgerIn,
  type PaymentIn,
  type TimelineItem,
  invoicesByClient,
  moneyOf,
  paymentDaysOf,
  toNum,
} from '../clients/hub';
import {
  loadClient360,
  readAccountingInvoices,
  readContacts,
  readDocumentInvoices,
  readLedger,
  readPayments,
} from '../clients/hub-read';
import { listClients } from '../clients/store';
import { addDays, bogotaToday } from '../commitments/shape';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import {
  type ProductCost,
  type QuoteIn,
  type QuoteLineIn,
  type SaleIn,
  margins,
  quoteConversion,
  winLoss,
} from './analytics';
import { type ChurnAssessment, assessChurn } from './churn';
import { type CrmForecast, weightedForecast } from './forecast';
import { type StaleDeal, staleDeals } from './rules';
import { ACTIVITY_LABEL, type ActivityRow, type OpportunityRow, type StageDef } from './shape';
import { listActivities, listOpportunities, listResponses, loadStages } from './store';

/**
 * LAS LECTURAS DEL EMBUDO (migración 0193): lo que la pantalla /comercial,
 * las herramientas y el piloto necesitan, armado con las funciones puras.
 * `db` es siempre el handle de la empresa. Cada sección que puede faltar se
 * nombra en `missing` en vez de pintarse en cero.
 */

const SCAN = 5000;

// ---------------------------------------------------------------------------
// El nombre de la gente
// ---------------------------------------------------------------------------

export async function loadPeople(db: SupabaseClient): Promise<Map<string, string>> {
  const people = await listDirectory(db).catch(() => []);
  return new Map(people.map((p) => [p.id, personLabel(p)]));
}

// ---------------------------------------------------------------------------
// El tablero
// ---------------------------------------------------------------------------

export interface CrmBoard {
  stages: StageDef[];
  opportunities: OpportunityRow[];
  stale: StaleDeal[];
  forecast: CrmForecast;
  /** Tareas abiertas con fecha hasta hoy (de todos; la pantalla filtra «mías»). */
  tasks: ActivityRow[];
}

export async function loadCrmBoard(
  db: SupabaseClient,
  opts: { today?: string; staleDays?: number } = {},
): Promise<CrmBoard> {
  const today = opts.today ?? bogotaToday();
  const [{ stages }, opportunities, tasks] = await Promise.all([
    loadStages(db),
    listOpportunities(db, { includeClosed: true, limit: 2000 }),
    listActivities(db, { openTasks: true, limit: 500 }),
  ]);
  const open = opportunities.filter((o) => !o.won_at && !o.lost_at);
  return {
    stages,
    opportunities,
    stale: staleDeals(open, stages, today, opts.staleDays),
    forecast: weightedForecast(open, stages, { today, months: 6 }),
    tasks,
  };
}

// ---------------------------------------------------------------------------
// El riesgo de perder clientes
// ---------------------------------------------------------------------------

export interface RiskRead {
  assessments: ChurnAssessment[];
  /** Nombre del responsable de cada cliente. */
  owners: Map<string, string | null>;
  missing: string[];
}

async function settle<T>(
  fn: () => Promise<T>,
  label: string,
  missing: string[],
): Promise<T | null> {
  try {
    return await fn();
  } catch {
    missing.push(label);
    return null;
  }
}

/**
 * La lectura de riesgo de todos los clientes activos (o de los pedidos). Lee
 * dos años de facturas para tener con qué comparar.
 */
export async function assessClientRisk(
  db: SupabaseClient,
  opts: { today?: string; clientIds?: string[] } = {},
): Promise<RiskRead> {
  const today = opts.today ?? bogotaToday();
  const since = addDays(today, -730);
  const missing: string[] = [];
  const clients = (await listClients(db, { statuses: ['active', 'dormant'], limit: 2000 })).filter(
    (c) => !opts.clientIds || opts.clientIds.includes(c.id),
  );
  const [acc, docs, pays, ledger, contacts, escalations, nps] = await Promise.all([
    settle(() => readAccountingInvoices(db, { since }), 'facturas del programa contable', missing),
    settle(() => readDocumentInvoices(db, {}), 'facturas confirmadas', missing),
    settle(() => readPayments(db, {}), 'pagos', missing),
    settle(() => readLedger(db, { since }), 'libro de plata', missing),
    settle(() => readContacts(db, {}), 'último contacto', missing),
    settle(
      async () => {
        const { data, error } = await db
          .from('wa_customer_conversations')
          .select('client_id, escalated_at, escalation_reason')
          .not('client_id', 'is', null)
          .gte('escalated_at', `${addDays(today, -90)}T00:00:00Z`)
          .limit(SCAN);
        if (error) throw error;
        return (data ?? []) as Array<{
          client_id: string;
          escalated_at: string;
          escalation_reason: string | null;
        }>;
      },
      'quejas por WhatsApp',
      missing,
    ),
    settle(
      () => listResponses(db, { since: `${addDays(today, -180)}T00:00:00Z`, limit: SCAN }),
      'encuestas',
      missing,
    ),
  ]);

  const moneyRead = acc !== null && docs !== null && pays !== null;
  const invoices = moneyRead
    ? invoicesByClient({ accountingInvoices: acc, documentInvoices: docs, payments: pays }, today)
    : new Map<string, ClientInvoice[]>();
  const group = <T extends { client_id: string | null }>(rows: readonly T[] | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows ?? []) {
      if (!r.client_id) continue;
      const list = m.get(r.client_id);
      if (list) list.push(r);
      else m.set(r.client_id, [r]);
    }
    return m;
  };
  const paysBy = group<PaymentIn>(pays);
  const ledgerBy = group<LedgerIn>(ledger);
  const escalBy = group(escalations);
  const npsBy = group(nps);
  const lastContact = new Map<string, string>();
  for (const c of contacts ?? []) {
    const prev = lastContact.get(c.client_id);
    if (!prev || c.at > prev) lastContact.set(c.client_id, c.at);
  }

  const half = addDays(today, -180);
  const assessments = clients.map((c) => {
    const mine = (invoices.get(c.id) ?? []).filter((i) => i.currency === 'COP' && i.issuedOn);
    // Sin facturas en la cartera, lo que el libro sabe de sus ventas.
    const history = mine.length
      ? mine.map((i) => ({ issuedOn: i.issuedOn as string, total: i.total }))
      : (ledgerBy.get(c.id) ?? [])
          .filter((m) => m.currency === 'COP')
          .map((m) => ({ issuedOn: m.date, total: toNum(m.amount) ?? 0 }));
    const money = moneyRead
      ? moneyOf(mine, paysBy.get(c.id) ?? [], ledgerBy.get(c.id) ?? [], today)
      : null;
    const recentInv = mine.filter((i) => (i.issuedOn as string) >= half);
    const priorInv = mine.filter((i) => (i.issuedOn as string) < half);
    return assessChurn({
      clientId: c.id,
      clientName: c.name,
      today,
      invoices: history,
      paymentDays: moneyRead
        ? {
            recent: paymentDaysOf(recentInv, paysBy.get(c.id) ?? [], ledgerBy.get(c.id) ?? []),
            prior: paymentDaysOf(priorInv, paysBy.get(c.id) ?? [], ledgerBy.get(c.id) ?? []),
          }
        : undefined,
      overdue:
        money && money.overdue > 0 && money.maxDaysOverdue != null
          ? { amount: money.overdue, maxDays: money.maxDaysOverdue }
          : null,
      lastContactAt: contacts ? (lastContact.get(c.id) ?? null) : null,
      escalations: (escalBy.get(c.id) ?? []).map((e) => ({
        at: e.escalated_at,
        reason: e.escalation_reason,
      })),
      nps: (npsBy.get(c.id) ?? []).map((n) => ({
        at: n.created_at,
        score: n.score,
        comment: n.comment,
      })),
    });
  });
  const people = await loadPeople(db);
  const owners = new Map(
    clients.map((c) => [c.id, c.owner_user_id ? (people.get(c.owner_user_id) ?? null) : null]),
  );
  return { assessments, owners, missing };
}

// ---------------------------------------------------------------------------
// La línea de tiempo de una oportunidad
// ---------------------------------------------------------------------------

export interface OppTimelineItem {
  id: string;
  at: string;
  kind: string;
  kindLabel: string;
  title: string;
  detail: string | null;
  by: string | null;
  href: string | null;
  /** De dónde salió: del embudo o del hub del cliente (correo, reunión, WhatsApp…). */
  from: 'crm' | 'hub';
  done: boolean;
}

const HUB_KINDS = new Set(['email', 'meeting', 'whatsapp', 'note', 'action', 'case']);

/**
 * Lo del negocio (actividades y cambios de etapa) y lo del cliente desde que
 * se abrió el negocio (correos, reuniones, WhatsApp, notas, cobros) en una
 * sola línea, lo más reciente primero. Lo del hub no se copia: se lee.
 */
export async function loadOpportunityTimeline(
  db: SupabaseClient,
  opp: OpportunityRow,
  opts: { today?: string; people?: Map<string, string> } = {},
): Promise<{ items: OppTimelineItem[]; missing: string[] }> {
  const missing: string[] = [];
  const people = opts.people ?? (await loadPeople(db));
  const activities = await listActivities(db, { opportunityId: opp.id, limit: 300 });
  const items: OppTimelineItem[] = activities.map((a) => ({
    id: `a:${a.id}`,
    at: a.done_at ?? a.created_at,
    kind: a.kind,
    kindLabel: ACTIVITY_LABEL[a.kind],
    title: a.title,
    detail: a.body,
    by: a.owner_user_id
      ? (people.get(a.owner_user_id) ?? null)
      : a.origin === 'rule'
        ? 'Regla automática'
        : null,
    href: null,
    from: 'crm',
    done: a.kind !== 'task' || !!a.done_at,
  }));
  if (opp.client_id) {
    const hub = await loadClient360(db, opp.client_id, {
      today: opts.today,
      withForecast: false,
      withRecovered: false,
    }).catch(() => null);
    if (!hub || !hub.timeline.ok) missing.push('correos, reuniones y WhatsApp del cliente');
    else {
      const since = opp.created_at.slice(0, 10);
      for (const t of hub.timeline.data as TimelineItem[]) {
        if (!HUB_KINDS.has(t.kind) || t.at.slice(0, 10) < since) continue;
        items.push({
          id: `h:${t.id}`,
          at: t.at,
          kind: t.kind,
          kindLabel:
            t.kind === 'email'
              ? 'Correo'
              : t.kind === 'meeting'
                ? 'Reunión'
                : t.kind === 'whatsapp'
                  ? 'WhatsApp'
                  : t.kind === 'note'
                    ? 'Nota en la ficha'
                    : t.kind === 'case'
                      ? 'Caso'
                      : 'Cobro',
          title: t.title,
          detail: t.detail ?? null,
          by: t.by ?? null,
          href: t.href ?? null,
          from: 'hub',
          done: true,
        });
      }
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { items: items.slice(0, 200), missing };
}

// ---------------------------------------------------------------------------
// El análisis
// ---------------------------------------------------------------------------

export interface CrmAnalytics {
  conversion: ReturnType<typeof quoteConversion>;
  winLoss: ReturnType<typeof winLoss>;
  margins: ReturnType<typeof margins>;
  missing: string[];
}

interface DocRow {
  id: string;
  kind: string;
  status: string;
  source_id: string | null;
  client_id: string | null;
  client_name: string;
  issue_date: string;
  valid_until: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  currency: string;
  total: number | string;
  created_by: string | null;
}

interface LineRow {
  document_id: string;
  description: string;
  product_code: string | null;
  product_ref: string | null;
  quantity: number | string;
  unit_price: number | string;
  discount_pct: number | string;
  base: number | string;
}

export async function loadCrmAnalytics(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<CrmAnalytics> {
  const today = opts.today ?? bogotaToday();
  const since = addDays(today, -540);
  const missing: string[] = [];
  const [docsRes, oppsRes, productsRes, stagesRes, people] = await Promise.all([
    settle(
      async () => {
        const { data, error } = await db
          .from('sales_documents')
          .select(
            'id, kind, status, source_id, client_id, client_name, issue_date, valid_until, sent_at, accepted_at, currency, total, created_by',
          )
          .gte('issue_date', since)
          .limit(SCAN);
        if (error) throw error;
        return (data ?? []) as DocRow[];
      },
      'cotizaciones y pedidos',
      missing,
    ),
    settle(
      () => listOpportunities(db, { includeClosed: true, limit: SCAN }),
      'oportunidades',
      missing,
    ),
    settle(
      async () => {
        const { data, error } = await db
          .from('products')
          .select('sku, source_ref, name, cost')
          .limit(SCAN);
        if (error) throw error;
        return ((data ?? []) as Array<Record<string, unknown>>).map(
          (p): ProductCost => ({
            sku: (p.sku as string | null) ?? null,
            sourceRef: (p.source_ref as string | null) ?? null,
            name: String(p.name ?? ''),
            cost: p.cost == null ? null : toNum(p.cost as string),
          }),
        );
      },
      'costos del inventario',
      missing,
    ),
    loadStages(db),
    loadPeople(db),
  ]);
  const docs = docsRes ?? [];
  const docIds = docs.map((d) => d.id);
  const lines = new Map<string, QuoteLineIn[]>();
  for (let i = 0; i < docIds.length; i += 300) {
    const chunk = docIds.slice(i, i + 300);
    const res = await settle(
      async () => {
        const { data, error } = await db
          .from('sales_document_lines')
          .select(
            'document_id, description, product_code, product_ref, quantity, unit_price, discount_pct, base',
          )
          .in('document_id', chunk)
          .limit(SCAN);
        if (error) throw error;
        return (data ?? []) as LineRow[];
      },
      'líneas de las cotizaciones',
      missing,
    );
    for (const l of res ?? []) {
      const list = lines.get(l.document_id) ?? [];
      list.push({
        description: l.description,
        productCode: l.product_code,
        productRef: l.product_ref,
        quantity: toNum(l.quantity) ?? 0,
        unitPrice: toNum(l.unit_price) ?? 0,
        discountPct: toNum(l.discount_pct) ?? 0,
        base: toNum(l.base) ?? 0,
      });
      lines.set(l.document_id, list);
    }
  }

  const quotes: QuoteIn[] = docs
    .filter((d) => d.kind === 'quote')
    .map((d) => ({
      id: d.id,
      createdBy: d.created_by,
      issueDate: d.issue_date,
      status: d.status,
      validUntil: d.valid_until,
      sentAt: d.sent_at,
      acceptedAt: d.accepted_at,
      currency: d.currency,
      total: toNum(d.total) ?? 0,
      lines: lines.get(d.id) ?? [],
    }));
  // Cada venta una vez: el pedido; la cotización aceptada que aún no es
  // pedido; la factura hecha directa (sin cotización ni pedido detrás).
  const sales: SaleIn[] = docs
    .filter(
      (d) =>
        d.status !== 'anulada' &&
        (d.kind === 'order' ||
          (d.kind === 'quote' && d.status === 'aceptada') ||
          (d.kind === 'invoice' && !d.source_id)),
    )
    .map((d) => ({
      id: d.id,
      clientId: d.client_id,
      clientName: d.client_name,
      issueDate: d.issue_date,
      currency: d.currency,
      lines: lines.get(d.id) ?? [],
    }));

  const ownerName = (id: string | null) =>
    id ? (people.get(id) ?? 'Alguien del equipo') : 'Sin responsable';
  return {
    conversion: quoteConversion(quotes, { today, ownerName }),
    winLoss: winLoss(oppsRes ?? [], quotes, stagesRes.stages, today),
    margins: margins(sales, productsRes ?? []),
    missing,
  };
}
