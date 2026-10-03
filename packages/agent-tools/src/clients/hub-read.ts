import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday, daysBetween, deriveState } from '../commitments/shape';
import {
  type AccountingInvoiceIn,
  type ClientHealth,
  type ClientInvoice,
  type ClientListRow,
  type ClientMoney,
  type CommitmentIn,
  type ContactIn,
  type DocumentInvoiceIn,
  type LedgerIn,
  type ListInputs,
  type PaymentIn,
  type TimelineItem,
  assembleClientRows,
  clientHealth,
  cop,
  invoicesByClient,
  moneyOf,
  sortTimeline,
  toNum,
} from './hub';
import { type AliasRow, listAliases } from './merge';
import { type ClientRow, type ContactRow, type DomainRow, fullNit } from './shape';
import { getClient, listClients, listContacts, listDomains } from './store';

/**
 * LEER LA LISTA Y LA FICHA. Cada lectura va por su lado y, si falla, su
 * sección queda en «sin dato» — la página sigue en pie. Las cifras se arman en
 * hub.ts, que es puro.
 *
 * `db` es siempre el handle del espacio (createOrgScopedClient).
 */

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export async function settle<T>(work: () => Promise<T>, error: string): Promise<Section<T>> {
  try {
    return { ok: true, data: await work() };
  } catch {
    return { ok: false, error };
  }
}

const or = <T>(s: Section<T>): T | undefined => (s.ok ? s.data : undefined);

const SCAN = 5000;

// ---------------------------------------------------------------------------
// Lecturas compartidas
// ---------------------------------------------------------------------------

export async function readAccountingInvoices(
  db: SupabaseClient,
  opts: { clientId?: string; since: string },
): Promise<AccountingInvoiceIn[]> {
  const cols =
    'id, client_id, doc_number, currency, total, balance, issued_on, due_on, annulled, source_system, public_url';
  // Dos lecturas: lo emitido en el año (para «facturado») y todo lo abierto
  // (para el saldo, aunque sea viejo).
  let recent = db.from('accounting_invoices').select(cols).gte('issued_on', opts.since);
  let open = db.from('accounting_invoices').select(cols).gt('balance', 0).eq('annulled', false);
  if (opts.clientId) {
    recent = recent.eq('client_id', opts.clientId);
    open = open.eq('client_id', opts.clientId);
  } else {
    recent = recent.not('client_id', 'is', null);
    open = open.not('client_id', 'is', null);
  }
  const [a, b] = await Promise.all([recent.limit(SCAN), open.limit(SCAN)]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  const byId = new Map<string, AccountingInvoiceIn>();
  for (const r of [...(a.data ?? []), ...(b.data ?? [])] as AccountingInvoiceIn[])
    byId.set(r.id, r);
  return [...byId.values()];
}

export async function readDocumentInvoices(
  db: SupabaseClient,
  opts: { clientId?: string },
): Promise<DocumentInvoiceIn[]> {
  let q = db
    .from('document_extractions')
    .select('id, client_id, doc_number, currency, total_amount, issued_on, due_on')
    .eq('review_state', 'confirmed')
    .eq('doc_type', 'invoice')
    .eq('financial_role', 'receivable');
  // Sin cliente, igual se leen todas: su número sirve para no contar dos
  // veces la misma factura del programa contable.
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  const { data, error } = await q.limit(SCAN);
  if (error) throw error;
  return (data ?? []) as DocumentInvoiceIn[];
}

export async function readPayments(
  db: SupabaseClient,
  opts: { clientId?: string },
): Promise<PaymentIn[]> {
  let q = db
    .from('payments')
    .select('id, client_id, extraction_id, invoice_number, amount, currency, paid_on, kind')
    .in('state', ['reported', 'confirmed']);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  else q = q.not('client_id', 'is', null);
  const { data, error } = await q.order('paid_on', { ascending: false }).limit(SCAN);
  if (error) throw error;
  return (data ?? []) as PaymentIn[];
}

export async function readLedger(
  db: SupabaseClient,
  opts: { clientId?: string; since: string },
): Promise<LedgerIn[]> {
  let q = db
    .from('ledger_movements')
    .select(
      'id, client_id, kind, direction, status, amount, currency, date, due_date, settled_at, doc_number',
    )
    .eq('direction', 'in')
    .in('kind', ['receivable', 'income'])
    .is('duplicate_of', null)
    .is('excluded_reason', null)
    .neq('status', 'cancelled')
    .gte('date', opts.since);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  else q = q.not('client_id', 'is', null);
  const { data, error } = await q.order('date', { ascending: false }).limit(SCAN);
  if (error) throw error;
  return (data ?? []) as LedgerIn[];
}

/** Los momentos de contacto: correo, reunión, WhatsApp, nota, cobro enviado. */
export async function readContacts(
  db: SupabaseClient,
  opts: { clientId?: string },
): Promise<ContactIn[]> {
  const base = (table: string, cols: string) => {
    const q = db.from(table).select(cols);
    return opts.clientId ? q.eq('client_id', opts.clientId) : q.not('client_id', 'is', null);
  };
  const [gmail, outlook, actions, links, notes] = await Promise.all([
    base('gmail_thread_ingests', 'client_id, last_message_at')
      .order('last_message_at', { ascending: false })
      .limit(SCAN),
    base('microsoft_mail_ingests', 'client_id, last_message_at')
      .order('last_message_at', { ascending: false })
      .limit(SCAN),
    base('actions', 'client_id, executed_at').not('executed_at', 'is', null).limit(SCAN),
    base('client_links', 'client_id, entity_kind, occurred_at')
      .eq('state', 'confirmed')
      .in('entity_kind', ['meeting', 'whatsapp_group', 'email_thread'])
      .limit(SCAN),
    base('client_notes', 'client_id, created_at').limit(SCAN),
  ]);
  for (const r of [gmail, outlook, actions, links]) if (r.error) throw r.error;
  const out: ContactIn[] = [];
  for (const r of (gmail.data ?? []) as unknown as Array<{
    client_id: string;
    last_message_at: string | null;
  }>) {
    if (r.last_message_at)
      out.push({ client_id: r.client_id, at: r.last_message_at, kind: 'email' });
  }
  for (const r of (outlook.data ?? []) as unknown as Array<{
    client_id: string;
    last_message_at: string | null;
  }>) {
    if (r.last_message_at)
      out.push({ client_id: r.client_id, at: r.last_message_at, kind: 'email' });
  }
  for (const r of (actions.data ?? []) as unknown as Array<{
    client_id: string;
    executed_at: string | null;
  }>) {
    if (r.executed_at) out.push({ client_id: r.client_id, at: r.executed_at, kind: 'action' });
  }
  for (const r of (links.data ?? []) as unknown as Array<{
    client_id: string;
    entity_kind: string;
    occurred_at: string | null;
  }>) {
    if (!r.occurred_at) continue;
    const kind =
      r.entity_kind === 'meeting'
        ? 'meeting'
        : r.entity_kind === 'whatsapp_group'
          ? 'whatsapp'
          : 'email';
    out.push({ client_id: r.client_id, at: r.occurred_at, kind });
  }
  // Las notas son de 0179: sin la tabla, se sigue sin ellas.
  if (!notes.error) {
    for (const r of (notes.data ?? []) as unknown as Array<{
      client_id: string;
      created_at: string;
    }>) {
      out.push({ client_id: r.client_id, at: r.created_at, kind: 'note' });
    }
  }
  return out;
}

async function readCommitments(
  db: SupabaseClient,
  opts: { clientId?: string },
): Promise<Array<CommitmentIn & { id: string; kind: string; notice_days: number }>> {
  let q = db
    .from('commitments')
    .select('id, client_id, title, kind, due_on, notice_days, state, amount_cop')
    .eq('review_state', 'confirmed');
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  else q = q.not('client_id', 'is', null);
  const { data, error } = await q.order('due_on', { ascending: true }).limit(SCAN);
  if (error) throw error;
  return (data ?? []) as Array<CommitmentIn & { id: string; kind: string; notice_days: number }>;
}

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

export interface ClientListResult {
  rows: ClientListRow[];
  /** Propuestas esperando a alguien (la pestaña «Por confirmar»). */
  pending: number;
  /** Secciones que no se pudieron leer. */
  missing: string[];
}

export async function loadClientList(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<ClientListResult> {
  const today = opts.today ?? bogotaToday();
  const since = isoDaysBefore(today, 400);
  const clients = await listClients(db, { limit: 2000 });
  const [acc, docs, pays, ledger, contacts, commitments, pending] = await Promise.all([
    settle(() => readAccountingInvoices(db, { since }), 'facturas del programa contable'),
    settle(() => readDocumentInvoices(db, {}), 'facturas confirmadas'),
    settle(() => readPayments(db, {}), 'pagos'),
    settle(() => readLedger(db, { since }), 'libro de plata'),
    settle(() => readContacts(db, {}), 'último contacto'),
    settle(() => readCommitments(db, {}), 'vencimientos'),
    settle(async () => {
      const { data, error } = await db
        .from('client_links')
        .select('id')
        .eq('state', 'suggested')
        .limit(5000);
      if (error) throw error;
      return (data ?? []).length;
    }, 'propuestas'),
  ]);
  const inputs: ListInputs = {
    accountingInvoices: or(acc),
    documentInvoices: or(docs),
    payments: or(pays),
    ledger: or(ledger) ?? [],
    contacts: or(contacts),
    commitments: or(commitments),
  };
  const rows = assembleClientRows(clients, inputs, today);
  const missing = [acc, docs, pays, ledger, contacts, commitments]
    .filter((s): s is { ok: false; error: string } => !s.ok)
    .map((s) => s.error);
  return { rows, pending: or(pending) ?? 0, missing };
}

/**
 * Sólo las facturas de UN cliente, con las reglas de la cartera (0185: lo que
 * la atención por WhatsApp le dice a ese cliente). LANZA si alguna lectura
 * falla: «no debe nada» y «no pude leer» no se pueden confundir.
 */
export async function loadClientInvoices(
  db: SupabaseClient,
  clientId: string,
  opts: { today?: string } = {},
): Promise<ClientInvoice[]> {
  const today = opts.today ?? bogotaToday();
  const [acc, docs, pays] = await Promise.all([
    readAccountingInvoices(db, { clientId, since: '1900-01-01' }),
    readDocumentInvoices(db, { clientId }),
    readPayments(db, { clientId }),
  ]);
  return (
    invoicesByClient(
      { accountingInvoices: acc, documentInvoices: docs, payments: pays },
      today,
    ).get(clientId) ?? []
  ).filter((inv) => inv.balance >= 0);
}

function isoDaysBefore(today: string, days: number): string {
  const t = Date.parse(`${today}T00:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

export interface OpenCommitment {
  id: string;
  title: string;
  kind: string;
  dueOn: string;
  state: string;
  daysLeft: number;
  amountCop: number | null;
}

export interface OpenCase {
  id: string;
  title: string;
  state: string;
  dueOn: string | null;
  nextAction: string | null;
  /** Por qué es de este cliente: «cobro de su factura FV-12», «vinculado a mano». */
  why: string;
}

export interface OpenWork {
  id: string;
  title: string;
  assignee: string | null;
  dueOn: string | null;
  workType: string;
}

export interface ExpectedCollection {
  expectedDate: string;
  amount: number;
  expectedAmount: number;
  probability: number;
  label: string;
  reason: string;
}

export interface ClientDocument {
  id: string;
  title: string;
  at: string | null;
  kind: 'document' | 'email' | 'invoice';
  href: string | null;
}

export interface Client360 {
  client: ClientRow;
  nit: string | null;
  contacts: ContactRow[];
  domains: DomainRow[];
  aliases: AliasRow[];
  money: Section<ClientMoney>;
  recovered: Section<{ total: number; invoices: number; lastOn: string | null }>;
  expected: Section<ExpectedCollection[]>;
  health: ClientHealth;
  lastContactAt: string | null;
  timeline: Section<TimelineItem[]>;
  open: {
    invoices: Section<ClientInvoice[]>;
    commitments: Section<OpenCommitment[]>;
    cases: Section<OpenCase[]>;
    work: Section<OpenWork[]>;
  };
  documents: Section<ClientDocument[]>;
  proposals: number;
}

const ACTION_KIND_LABEL: Record<string, string> = {
  collect_payment: 'Cobro',
  remind_owner: 'Recordatorio al responsable',
  reply_to_client: 'Respuesta al cliente',
};

const ACTION_STATE_TEXT: Record<string, string> = {
  proposed: 'propuesto, esperando aprobación',
  approved: 'aprobado',
  dismissed: 'descartado',
};

/**
 * Todo lo de un cliente, en una ida. Null si el cliente no existe en este
 * espacio. Cada sección se lee aparte.
 */
export async function loadClient360(
  db: SupabaseClient,
  clientId: string,
  opts: { today?: string; withForecast?: boolean; withRecovered?: boolean } = {},
): Promise<Client360 | null> {
  const today = opts.today ?? bogotaToday();
  const client = await getClient(db, clientId);
  if (!client) return null;
  const since = isoDaysBefore(today, 400);

  const [contacts, domains, aliases] = await Promise.all([
    listContacts(db, clientId).catch(() => [] as ContactRow[]),
    listDomains(db, clientId).catch(() => [] as DomainRow[]),
    listAliases(db, clientId).catch(() => [] as AliasRow[]),
  ]);

  const [acc, docs, pays, ledger, contactMoments, commitments, links, proposals] =
    await Promise.all([
      settle(() => readAccountingInvoices(db, { clientId, since: '1900-01-01' }), 'facturas'),
      settle(() => readDocumentInvoices(db, { clientId }), 'facturas'),
      settle(() => readPayments(db, { clientId }), 'pagos'),
      settle(() => readLedger(db, { clientId, since }), 'libro'),
      settle(() => readContacts(db, { clientId }), 'contacto'),
      settle(() => readCommitments(db, { clientId }), 'compromisos'),
      settle(async () => {
        const { data, error } = await db
          .from('client_links')
          .select('id, entity_kind, entity_id, entity_ref, label, occurred_at, method, evidence')
          .eq('client_id', clientId)
          .eq('state', 'confirmed')
          .order('occurred_at', { ascending: false, nullsFirst: false })
          .limit(1000);
        if (error) throw error;
        return (data ?? []) as Array<{
          id: string;
          entity_kind: string;
          entity_id: string | null;
          entity_ref: string | null;
          label: string | null;
          occurred_at: string | null;
          method: string;
          evidence: string | null;
        }>;
      }, 'vínculos'),
      settle(async () => {
        const { data, error } = await db
          .from('client_links')
          .select('id')
          .eq('client_id', clientId)
          .eq('state', 'suggested')
          .limit(1000);
        if (error) throw error;
        return (data ?? []).length;
      }, 'propuestas'),
    ]);

  // --- La plata -----------------------------------------------------------
  const moneyRead = acc.ok && docs.ok && pays.ok;
  const invoices = moneyRead
    ? (invoicesByClient(
        { accountingInvoices: acc.data, documentInvoices: docs.data, payments: pays.data },
        today,
      ).get(clientId) ?? [])
    : [];
  const money: Section<ClientMoney> = moneyRead
    ? { ok: true, data: moneyOf(invoices, pays.data, or(ledger) ?? [], today) }
    : { ok: false, error: 'No pude leer las facturas o los pagos.' };

  const lastContactAt = (or(contactMoments) ?? []).reduce<string | null>(
    (max, c) => (!max || c.at > max ? c.at : max),
    null,
  );
  const health = clientHealth({
    status: client.status,
    money: money.ok ? money.data : null,
    lastContactAt,
    today,
  });

  const recovered: Section<{ total: number; invoices: number; lastOn: string | null }> =
    opts.withRecovered === false
      ? { ok: false, error: 'No se pidió.' }
      : await settle(async () => {
          const { moneyRecovered } = await import('../payments/recovered-store');
          const all = await moneyRecovered(db, { today });
          const mine = all.items.filter((i) => i.clientId === clientId && i.currency === 'COP');
          return {
            total: mine.reduce((s, i) => s + i.amount, 0),
            invoices: mine.length,
            lastOn: mine.reduce<string | null>((m, i) => (!m || i.lastOn > m ? i.lastOn : m), null),
          };
        }, 'No pude calcular lo recuperado.');

  const expected: Section<ExpectedCollection[]> =
    opts.withForecast === false
      ? { ok: false, error: 'No se pidió.' }
      : await settle(async () => {
          // La proyección de caja trabaja por movimiento del libro; los de este
          // cliente son los que tienen su client_id (0179).
          const { data, error } = await db
            .from('ledger_movements')
            .select('id')
            .eq('client_id', clientId)
            .eq('status', 'expected')
            .limit(SCAN);
          if (error) throw error;
          const ids = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
          if (ids.size === 0) return [];
          const { runForecast } = await import('../ledger/plans');
          const run = await runForecast(db, { today, includeEstimatedSales: false });
          return run.base.weeks
            .flatMap((w) => w.items)
            .filter((i) => i.direction === 'in' && i.movementId && ids.has(i.movementId))
            .map((i) => ({
              expectedDate: i.expectedDate,
              amount: i.amount,
              expectedAmount: i.expectedAmount,
              probability: i.probability,
              label: i.label,
              reason: i.reason,
            }))
            .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))
            .slice(0, 12);
        }, 'No pude leer la proyección de caja.');

  // --- Lo vinculado: reuniones, grupos, documentos, casos, trabajo ----------
  const linkRows = or(links) ?? [];
  const linkIds = (kind: string) =>
    linkRows.filter((l) => l.entity_kind === kind && l.entity_id).map((l) => l.entity_id as string);

  const [cases, work, emails, actions, notes, whatsapp, waCustomer] = await Promise.all([
    settle(() => readCases(db, linkIds('case'), invoices), 'casos'),
    settle(
      () =>
        readWork(db, linkIds('work_item'), commitments.ok ? commitments.data.map((c) => c.id) : []),
      'trabajo',
    ),
    settle(() => readEmails(db, clientId), 'correos'),
    settle(async () => {
      const { data, error } = await db
        .from('actions')
        .select('id, kind, subject, recipient, state, outcome, executed_at, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        kind: string;
        subject: string | null;
        recipient: string;
        state: string;
        outcome: string | null;
        executed_at: string | null;
        created_at: string;
      }>;
    }, 'acciones'),
    settle(async () => {
      const { data, error } = await db
        .from('client_notes')
        .select('id, body, created_by, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        body: string;
        created_by: string | null;
        created_at: string;
      }>;
    }, 'notas'),
    settle(() => readWhatsapp(db, linkIds('whatsapp_group')), 'WhatsApp'),
    // 0185: las conversaciones de atención por WhatsApp de este cliente.
    settle(() => readCustomerConversations(db, clientId), 'atención por WhatsApp'),
  ]);

  // --- La línea de tiempo ---------------------------------------------------
  const timeline: Section<TimelineItem[]> = await settle(async () => {
    const items: TimelineItem[] = [];
    for (const inv of invoices) {
      if (!inv.issuedOn) continue;
      items.push({
        id: `inv:${inv.id}`,
        kind: 'invoice',
        at: inv.issuedOn,
        title: `Factura ${inv.docNumber ?? ''} por ${money_(inv.total, inv.currency)}`.replace(
          '  ',
          ' ',
        ),
        detail:
          inv.balance > 0
            ? inv.daysOverdue
              ? `Debe ${money_(inv.balance, inv.currency)}, vencida hace ${inv.daysOverdue} días`
              : `Debe ${money_(inv.balance, inv.currency)}${inv.dueOn ? `, vence ${inv.dueOn}` : ''}`
            : 'Pagada',
        by:
          inv.source === 'accounting'
            ? (inv.system ?? 'Programa contable')
            : 'Documento confirmado',
        href: inv.href,
        tone: inv.daysOverdue ? 'rose' : inv.balance > 0 ? 'amber' : 'emerald',
      });
    }
    for (const p of or(pays) ?? []) {
      const amount = toNum(p.amount) ?? 0;
      items.push({
        id: `pay:${p.id}`,
        kind: 'payment',
        at: p.paid_on,
        title:
          p.kind === 'reversal'
            ? `Devolución de ${money_(amount, p.currency)}`
            : `Pago de ${money_(amount, p.currency)}`,
        detail: p.invoice_number ? `Factura ${p.invoice_number}` : null,
        tone: p.kind === 'reversal' ? 'rose' : 'emerald',
      });
    }
    for (const e of or(emails) ?? []) {
      if (!e.at) continue;
      items.push({
        id: `mail:${e.id}`,
        kind: 'email',
        at: e.at,
        title: e.subject || 'Correo sin asunto',
        detail: e.messages ? `${e.messages} mensaje${e.messages === 1 ? '' : 's'}` : null,
        by: e.system,
      });
    }
    for (const a of or(actions) ?? []) {
      items.push({
        id: `act:${a.id}`,
        kind: 'action',
        at: a.executed_at ?? a.created_at,
        title: `${ACTION_KIND_LABEL[a.kind] ?? 'Acción'}: ${a.subject ?? a.recipient}`,
        detail: a.executed_at
          ? `Enviado a ${a.recipient}`
          : (ACTION_STATE_TEXT[a.state] ?? a.state),
        tone: a.executed_at ? 'primary' : 'neutral',
        href: '/actions',
      });
    }
    for (const c of or(commitments) ?? []) {
      const state = c.state === 'met' || c.state === 'dropped' ? c.state : deriveState(c, today);
      items.push({
        id: `com:${c.id}`,
        kind: 'commitment',
        at: c.due_on,
        title: c.title,
        detail: c.amount_cop ? cop(c.amount_cop) : null,
        tone:
          state === 'overdue'
            ? 'rose'
            : state === 'due_soon'
              ? 'amber'
              : state === 'met'
                ? 'emerald'
                : 'neutral',
        href: '/commitments',
      });
    }
    for (const k of or(cases) ?? []) {
      items.push({
        id: `case:${k.id}`,
        kind: 'case',
        at: k.dueOn ?? today,
        title: k.title,
        detail: k.why,
        href: '/management',
      });
    }
    for (const l of linkRows) {
      if (!['meeting', 'document', 'whatsapp_group'].includes(l.entity_kind) || !l.occurred_at)
        continue;
      items.push({
        id: `link:${l.id}`,
        kind:
          l.entity_kind === 'meeting'
            ? 'meeting'
            : l.entity_kind === 'document'
              ? 'document'
              : 'whatsapp',
        at: l.occurred_at,
        title: l.label ?? 'Sin título',
        detail: l.evidence,
      });
    }
    for (const m of or(whatsapp) ?? []) {
      items.push({
        id: `wa:${m.id}`,
        kind: 'whatsapp',
        at: m.sent_at,
        title: `${m.sender ?? 'Alguien'} en ${m.group}`,
        detail: m.body,
      });
    }
    for (const n of or(notes) ?? []) {
      items.push({ id: `note:${n.id}`, kind: 'note', at: n.created_at, title: n.body, by: null });
    }
    for (const w of or(waCustomer) ?? []) {
      items.push({
        id: `wac:${w.id}`,
        kind: 'whatsapp',
        at: w.last_message_at,
        title: `Atención por WhatsApp${w.status === 'escalada' ? ' · con una persona' : w.status === 'cerrada' ? ' · cerrada' : ''}`,
        detail: w.preview,
        by: w.push_name,
        href: `/integrations/whatsapp/atencion?c=${w.id}`,
        tone: w.status === 'escalada' ? 'amber' : 'neutral',
      });
    }
    return sortTimeline(items).slice(0, 400);
  }, 'No pude armar la línea de tiempo.');

  const documents: Section<ClientDocument[]> = await settle(async () => {
    const out: ClientDocument[] = [];
    for (const l of linkRows) {
      if (l.entity_kind !== 'document') continue;
      out.push({
        id: l.entity_id ?? l.id,
        title: l.label ?? 'Documento',
        at: l.occurred_at,
        kind: 'document',
        href: null,
      });
    }
    for (const inv of invoices) {
      if (inv.source === 'accounting' && inv.href) {
        out.push({
          id: inv.id,
          title: `Factura ${inv.docNumber}`,
          at: inv.issuedOn,
          kind: 'invoice',
          href: inv.href,
        });
      }
    }
    return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, 60);
  }, 'No pude leer los documentos.');

  const openCommitments: Section<OpenCommitment[]> = commitments.ok
    ? {
        ok: true,
        data: commitments.data
          .map((c) => ({
            c,
            state: c.state === 'met' || c.state === 'dropped' ? c.state : deriveState(c, today),
          }))
          .filter((x) => x.state !== 'met' && x.state !== 'dropped')
          .map(({ c, state }) => ({
            id: c.id,
            title: c.title,
            kind: c.kind,
            dueOn: c.due_on,
            state,
            daysLeft: daysBetween(today, c.due_on),
            amountCop: c.amount_cop ?? null,
          })),
      }
    : { ok: false, error: commitments.error };

  return {
    client,
    nit: fullNit(client.tax_id),
    contacts,
    domains,
    aliases,
    money,
    recovered,
    expected,
    health,
    lastContactAt,
    timeline,
    open: {
      invoices: money.ok ? { ok: true, data: money.data.open } : { ok: false, error: money.error },
      commitments: openCommitments,
      cases: cases.ok
        ? { ok: true, data: cases.data.filter((c) => !['verified', 'cancelled'].includes(c.state)) }
        : cases,
      work,
    },
    documents,
    proposals: or(proposals) ?? 0,
  };
}

function money_(amount: number, currency: string): string {
  return currency === 'COP'
    ? cop(amount)
    : `${currency} ${Math.round(amount).toLocaleString('es-CO')}`;
}

/**
 * Los casos de Gerencia de este cliente: los que cobran una de SUS facturas
 * (el flujo de cobro, 0131) y los que una persona vinculó.
 */
async function readCases(
  db: SupabaseClient,
  linked: string[],
  invoices: readonly ClientInvoice[],
): Promise<OpenCase[]> {
  const documentIds = invoices.filter((i) => i.source === 'document').map((i) => i.id);
  const why = new Map<string, string>();
  for (const id of linked) why.set(id, 'Vinculado a este cliente');
  if (documentIds.length > 0) {
    const { data, error } = await db
      .from('management_workflows')
      .select('case_id, invoice_id')
      .in('invoice_id', documentIds.slice(0, 200))
      .limit(500);
    if (error) throw error;
    const numbers = new Map(invoices.map((i) => [i.id, i.docNumber]));
    for (const w of (data ?? []) as Array<{ case_id: string; invoice_id: string }>) {
      why.set(w.case_id, `Cobro de su factura ${numbers.get(w.invoice_id) ?? ''}`.trim());
    }
  }
  const ids = [...why.keys()];
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('management_cases')
    .select('id, data')
    .in('id', ids.slice(0, 200));
  if (error) throw error;
  return (
    (data ?? []) as Array<{
      id: string;
      data: { title?: string; state?: string; dueOn?: string; nextAction?: string } | null;
    }>
  ).map((r) => ({
    id: r.id,
    title: r.data?.title ?? 'Caso',
    state: r.data?.state ?? 'open',
    dueOn: r.data?.dueOn ?? null,
    nextAction: r.data?.nextAction ?? null,
    why: why.get(r.id) ?? '',
  }));
}

/** El trabajo abierto: lo vinculado a mano y lo que nace de sus vencimientos. */
async function readWork(
  db: SupabaseClient,
  linked: string[],
  commitmentIds: string[],
): Promise<OpenWork[]> {
  const out = new Map<string, OpenWork>();
  const take = (rows: unknown[]) => {
    for (const r of rows as Array<{
      id: string;
      title: string;
      assignee_label: string | null;
      due_on: string | null;
      work_type: string;
      status: string;
    }>) {
      if (r.status !== 'open') continue;
      out.set(r.id, {
        id: r.id,
        title: r.title,
        assignee: r.assignee_label,
        dueOn: r.due_on,
        workType: r.work_type,
      });
    }
  };
  const cols = 'id, title, assignee_label, due_on, work_type, status';
  if (linked.length) {
    const { data, error } = await db.from('work_items').select(cols).in('id', linked.slice(0, 200));
    if (error) throw error;
    take(data ?? []);
  }
  if (commitmentIds.length) {
    const { data, error } = await db
      .from('work_items')
      .select(cols)
      .eq('source_kind', 'commitment')
      .in('source_ref', commitmentIds.slice(0, 200));
    if (error) throw error;
    take(data ?? []);
  }
  return [...out.values()].sort((a, b) => (a.dueOn ?? '9').localeCompare(b.dueOn ?? '9'));
}

async function readEmails(
  db: SupabaseClient,
  clientId: string,
): Promise<
  Array<{
    id: string;
    subject: string | null;
    at: string | null;
    messages: number | null;
    system: string;
  }>
> {
  const [g, m] = await Promise.all([
    db
      .from('gmail_thread_ingests')
      .select('id, subject, last_message_at, message_count')
      .eq('client_id', clientId)
      .order('last_message_at', { ascending: false })
      .limit(100),
    db
      .from('microsoft_mail_ingests')
      .select('id, subject, last_message_at, message_count')
      .eq('client_id', clientId)
      .order('last_message_at', { ascending: false })
      .limit(100),
  ]);
  if (g.error) throw g.error;
  type R = {
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
  };
  return [
    ...((g.data ?? []) as R[]).map((r) => ({
      id: r.id,
      subject: r.subject,
      at: r.last_message_at,
      messages: r.message_count,
      system: 'Gmail',
    })),
    ...(m.error ? [] : ((m.data ?? []) as R[])).map((r) => ({
      id: r.id,
      subject: r.subject,
      at: r.last_message_at,
      messages: r.message_count,
      system: 'Outlook',
    })),
  ];
}

/** Lo último que se dijo en sus grupos de WhatsApp vinculados. */
/** 0185: las conversaciones de atención de este cliente, con su último mensaje. */
async function readCustomerConversations(
  db: SupabaseClient,
  clientId: string,
): Promise<
  Array<{
    id: string;
    status: string;
    push_name: string | null;
    last_message_at: string;
    preview: string | null;
  }>
> {
  const { data, error } = await db
    .from('wa_customer_conversations')
    .select('id, status, push_name, last_message_at')
    .eq('client_id', clientId)
    .order('last_message_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    status: string;
    push_name: string | null;
    last_message_at: string;
  }>;
  if (rows.length === 0) return [];
  const { data: msgs, error: msgError } = await db
    .from('wa_customer_messages')
    .select('conversation_id, body, created_at')
    .in(
      'conversation_id',
      rows.map((r) => r.id),
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (msgError) throw msgError;
  const last = new Map<string, string>();
  for (const m of (msgs ?? []) as Array<{ conversation_id: string; body: string }>) {
    if (!last.has(m.conversation_id)) last.set(m.conversation_id, m.body);
  }
  return rows.map((r) => {
    const body = last.get(r.id) ?? null;
    return { ...r, preview: body && body.length > 160 ? `${body.slice(0, 157)}…` : body };
  });
}

async function readWhatsapp(
  db: SupabaseClient,
  groupIds: string[],
): Promise<
  Array<{ id: string; group: string; sender: string | null; body: string | null; sent_at: string }>
> {
  if (groupIds.length === 0) return [];
  const { data: groups, error } = await db
    .from('whatsapp_groups')
    .select('id, jid, subject')
    .in('id', groupIds.slice(0, 50));
  if (error) throw error;
  const byJid = new Map(
    ((groups ?? []) as Array<{ id: string; jid: string; subject: string | null }>).map((g) => [
      g.jid,
      g.subject ?? 'Grupo',
    ]),
  );
  if (byJid.size === 0) return [];
  const { data, error: msgError } = await db
    .from('whatsapp_messages')
    .select('id, group_jid, sender_name, body, sent_at')
    .in('group_jid', [...byJid.keys()])
    .order('sent_at', { ascending: false })
    .limit(30);
  if (msgError) throw msgError;
  return (
    (data ?? []) as Array<{
      id: string;
      group_jid: string;
      sender_name: string | null;
      body: string | null;
      sent_at: string;
    }>
  ).map((m) => ({
    id: m.id,
    group: byJid.get(m.group_jid) ?? 'Grupo',
    sender: m.sender_name,
    body: m.body ? (m.body.length > 160 ? `${m.body.slice(0, 157)}…` : m.body) : null,
    sent_at: m.sent_at,
  }));
}
