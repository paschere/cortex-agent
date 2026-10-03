import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchGmailAttachment } from '../gmail/attachments';
import type { GmailFetchContext } from '../gmail/client';
import { fetchThreadMessages, listThreadPage } from '../gmail/threads';
import { graphFetch } from '../msgraph/client';
import { fetchOutlookAttachment, listOutlookAttachments } from '../outlook/attachments';
import { draftFromUbl, invoicesFromAttachment, isInvoiceAttachmentName } from './intake';
import { purchaseOrderLookup } from './purchase-orders';
import { companyNit, intakePayable, logIntake, seenRefs } from './store';

/**
 * LAS FACTURAS DE PROVEEDOR QUE LLEGAN AL CORREO.
 *
 * Un proveedor colombiano manda la factura electrónica como un ZIP (XML de la
 * DIAN + PDF) o el XML suelto. Este barrido mira el buzón de UNA persona
 * (Gmail o Outlook) en los últimos días, baja sólo los adjuntos ZIP/XML que no
 * se hayan mirado antes (`payable_intake_log`), los lee (ubl.ts) y recibe cada
 * factura (store.ts › intakePayable, con dedupe por CUFE y por número).
 *
 * Sólo lectura sobre el correo: no archiva, no etiqueta, no responde. Las
 * notas crédito/débito se anotan («nota») y no se pagan. Lo que falla se
 * reintenta en la próxima pasada; lo que no era factura no se vuelve a bajar.
 */

export interface MailPollOptions {
  today: string;
  userId: string;
  /** Días hacia atrás. Por defecto 3 (el barrido corre cada hora). */
  days?: number;
  /** Tope de mensajes por pasada. */
  maxMessages?: number;
}

export interface MailPollResult {
  examined: number;
  created: number;
  duplicates: number;
  notes: number;
  errors: string[];
  invoiceIds: string[];
}

const GMAIL_QUERY = (days: number) =>
  `has:attachment (filename:zip OR filename:xml) newer_than:${days}d -in:sent -in:chats`;

function empty(): MailPollResult {
  return { examined: 0, created: 0, duplicates: 0, notes: 0, errors: [], invoiceIds: [] };
}

interface Candidate {
  ref: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  subject: string | null;
  from: string | null;
}

async function ingestCandidates(
  db: SupabaseClient,
  candidates: Candidate[],
  download: (c: Candidate) => Promise<Buffer>,
  provider: 'google' | 'microsoft',
  opts: MailPollOptions,
  result: MailPollResult,
): Promise<void> {
  if (!candidates.length) return;
  const seen = await seenRefs(
    db,
    'correo',
    candidates.map((c) => c.ref),
  );
  const fresh = candidates.filter((c) => !seen.has(c.ref));
  if (!fresh.length) return;
  const ourNit = await companyNit(db);
  const lookup = purchaseOrderLookup(db);
  for (const c of fresh) {
    result.examined += 1;
    let data: Buffer;
    try {
      data = await download(c);
    } catch (err) {
      const why = err instanceof Error ? err.message : 'no se pudo bajar el adjunto';
      result.errors.push(`${c.filename}: ${why}`);
      await logIntake(db, { channel: 'correo', ref: c.ref, outcome: 'error', detail: why });
      continue;
    }
    const found = invoicesFromAttachment(c.filename, data);
    if (!found.invoices.length) {
      const outcome = found.notes.length ? 'nota' : found.errors.length ? 'error' : 'no_factura';
      if (found.notes.length) result.notes += found.notes.length;
      await logIntake(db, {
        channel: 'correo',
        ref: c.ref,
        outcome: outcome === 'error' ? 'no_factura' : outcome,
        detail:
          found.notes
            .map(
              (n) =>
                `${n.kind === 'credit_note' ? 'Nota crédito' : 'Nota débito'} ${n.number ?? ''}`,
            )
            .join(', ') ||
          found.errors.join(' ') ||
          null,
      });
      continue;
    }
    let lastId: string | null = null;
    let created = false;
    for (const { invoice, files } of found.invoices) {
      const draft = draftFromUbl(invoice, {
        sourceRef: `${provider}:${c.messageId}:${invoice.number}`,
        sourceSystem: provider === 'google' ? 'gmail' : 'outlook',
        evidence: {
          provider,
          messageId: c.messageId,
          subject: c.subject,
          from: c.from,
          files,
        },
      });
      try {
        const r = await intakePayable(db, draft, { today: opts.today, ourNit, lookup });
        lastId = r.invoice.id;
        if (r.outcome === 'creada') {
          created = true;
          result.created += 1;
          result.invoiceIds.push(r.invoice.id);
        } else result.duplicates += 1;
      } catch (err) {
        result.errors.push(
          `${invoice.number}: ${err instanceof Error ? err.message : 'no se pudo guardar'}`,
        );
      }
    }
    await logIntake(db, {
      channel: 'correo',
      ref: c.ref,
      outcome: created ? 'creada' : lastId ? 'duplicada' : 'error',
      invoiceId: lastId,
    });
  }
}

/** Barrer el Gmail de una persona. `ctx.integrations` es el de esa persona. */
export async function pollGmailSupplierInvoices(
  db: SupabaseClient,
  ctx: GmailFetchContext,
  opts: MailPollOptions,
): Promise<MailPollResult> {
  const result = empty();
  const page = await listThreadPage(ctx, {
    query: GMAIL_QUERY(opts.days ?? 3),
    pageSize: Math.min(opts.maxMessages ?? 30, 100),
  });
  const candidates: Candidate[] = [];
  for (const threadId of page.threadIds) {
    const messages = await fetchThreadMessages(ctx, threadId);
    for (const m of messages) {
      for (const a of m.attachments) {
        if (!a.key || !isInvoiceAttachmentName(a.filename, a.mime)) continue;
        candidates.push({
          ref: `gmail:${m.id}:${a.filename}`.slice(0, 300),
          messageId: m.id,
          attachmentId: a.key,
          filename: a.filename,
          subject: m.subject,
          from: m.from,
        });
      }
    }
  }
  await ingestCandidates(
    db,
    candidates,
    (c) => fetchGmailAttachment(ctx, c.messageId, c.attachmentId),
    'google',
    opts,
    result,
  );
  return result;
}

interface GraphListMessage {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } };
}

/** Barrer el Outlook de una persona. */
export async function pollOutlookSupplierInvoices(
  db: SupabaseClient,
  ctx: GmailFetchContext,
  opts: MailPollOptions,
): Promise<MailPollResult> {
  const result = empty();
  const since = new Date(
    Date.parse(`${opts.today}T00:00:00Z`) - (opts.days ?? 3) * 86_400_000,
  ).toISOString();
  const params = new URLSearchParams({
    $select: 'id,subject,from,receivedDateTime',
    $filter: `receivedDateTime ge ${since} and hasAttachments eq true`,
    $orderby: 'receivedDateTime desc',
    $top: String(Math.min(opts.maxMessages ?? 30, 100)),
  });
  const list = await graphFetch<{ value?: GraphListMessage[] }>(
    ctx,
    `/me/mailFolders/inbox/messages?${params.toString()}`,
  );
  const candidates: Candidate[] = [];
  for (const m of list?.value ?? []) {
    const atts = await listOutlookAttachments(ctx, m.id);
    for (const a of atts) {
      if (!a.key || !isInvoiceAttachmentName(a.filename, a.mime)) continue;
      const from = m.from?.emailAddress;
      candidates.push({
        ref: `outlook:${m.id}:${a.filename}`.slice(0, 300),
        messageId: m.id,
        attachmentId: a.key,
        filename: a.filename,
        subject: m.subject ?? null,
        from: from ? `${from.name ?? ''} <${from.address ?? ''}>`.trim() : null,
      });
    }
  }
  await ingestCandidates(
    db,
    candidates,
    (c) => fetchOutlookAttachment(ctx, c.messageId, c.attachmentId),
    'microsoft',
    opts,
    result,
  );
  return result;
}

/** Los dos buzones de una persona, el que tenga conectado. Nunca lanza por uno caído. */
export async function pollSupplierInvoiceMail(
  db: SupabaseClient,
  ctx: GmailFetchContext,
  opts: MailPollOptions & { providers: Array<'google' | 'microsoft'> },
): Promise<MailPollResult> {
  const total = empty();
  for (const p of opts.providers) {
    try {
      const r =
        p === 'google'
          ? await pollGmailSupplierInvoices(db, ctx, opts)
          : await pollOutlookSupplierInvoices(db, ctx, opts);
      total.examined += r.examined;
      total.created += r.created;
      total.duplicates += r.duplicates;
      total.notes += r.notes;
      total.errors.push(...r.errors);
      total.invoiceIds.push(...r.invoiceIds);
    } catch (err) {
      total.errors.push(
        `${p === 'google' ? 'Gmail' : 'Outlook'}: ${err instanceof Error ? err.message : 'no se pudo leer el correo'}`,
      );
    }
  }
  return total;
}
