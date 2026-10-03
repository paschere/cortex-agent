import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AccountingConnectionRow,
  listAccountingConnections,
  openAccountingSession,
  requestAccountingSync,
} from '../accounting/store';
import {
  type ProviderSession,
  ProviderUncertainError,
  ProviderValidationError,
} from '../accounting/types';
import { bogotaToday } from '../commitments/shape';
import {
  type EinvoiceChoices,
  type EinvoiceDraft,
  buildAlegraInvoice,
  buildSiigoInvoice,
  idempotencyKeyFrom,
} from './einvoice';
import { type SalesDocumentRow, canInvoice, documentNumber } from './shape';
import {
  DOC_COLUMNS,
  getSalesDocumentRow,
  getSalesLines,
  prepareInvoice,
  recordSalesEvent,
  transitionStatus,
} from './store';
import { formatMoney } from './totals';

/**
 * EMITIR LA FACTURA ELECTRÓNICA (migración 0182).
 *
 * La única escritura de Cortex en un programa contable, y por eso la más
 * cuidada del módulo. El orden:
 *
 *   1. De una cotización aceptada o un pedido sale la factura en borrador (una
 *      viva por origen; ver `prepareInvoice`).
 *   2. Se elige el programa conectado que sabe emitir (Siigo o Alegra). Sin
 *      ninguno, la factura se queda en BORRADOR con sus datos y la guía para
 *      conectar uno: nunca se dice «emitida» de algo que nadie selló (la base
 *      tampoco lo deja escribir: `sales_documents_emitted_has_provider`).
 *   3. Se lee el catálogo del programa y se busca el cliente por NIT; se arma
 *      la factura (sales/einvoice.ts, puro). Con un solo problema no se manda
 *      nada y se dice qué arreglar, en español.
 *   4. Se toma la factura (`borrador|error → emitiendo`, compare-and-swap): dos
 *      clics o dos personas no mandan dos facturas.
 *   5. POST con la llave de idempotencia de (empresa, factura). Siigo la honra
 *      en la cabecera; para Alegra la defensa es el paso 4 y, si la red se
 *      corta, la marca `emission_uncertain`: no se reintenta solo.
 *   6. Lo que volvió (id, número, CUFE, estado DIAN) queda en la factura; el
 *      origen pasa a «facturada»; y se pide una sincronización del programa,
 *      que trae la factura a su tabla y a la cartera por el camino de siempre.
 *
 * La aprobación de una persona la exige la herramienta (`sales.invoice_emit`,
 * confirmación obligatoria y nunca desatendida); este módulo no se llama desde
 * ningún otro sitio.
 */

const EMITTING_PROVIDERS = new Set(['siigo', 'alegra']);
const PROVIDER_NAME: Record<string, string> = { siigo: 'Siigo', alegra: 'Alegra' };

export const NO_PROVIDER_GUIDANCE =
  'Conecta Siigo o Alegra para emitir factura electrónica: un administrador lo hace en Integraciones → Programas contables. Mientras tanto la factura queda preparada en Cortex (no está emitida ni enviada a la DIAN).';

/** Una emisión trabada más de esto en «emitiendo» se trata como incierta. */
const STUCK_MS = 10 * 60_000;

export interface EmissionDeps {
  /** Para pruebas: abrir la sesión del programa sin descifrar nada. */
  openSession?: (db: SupabaseClient, connectionId: string) => Promise<ProviderSession>;
  today?: string;
}

export function invoiceIdempotencyKey(organizationId: string, invoiceId: string): string {
  return idempotencyKeyFrom(
    createHash('sha256').update(`sales-invoice:${organizationId}:${invoiceId}`).digest('hex'),
  );
}

async function pickConnection(
  db: SupabaseClient,
  provider?: 'siigo' | 'alegra',
): Promise<AccountingConnectionRow | null> {
  const connected = (await listAccountingConnections(db)).filter(
    (c) => EMITTING_PROVIDERS.has(c.provider) && c.enabled,
  );
  if (provider) return connected.find((c) => c.provider === provider) ?? null;
  if (connected.length > 1)
    throw new ValidationError(
      `Hay ${connected.map((c) => PROVIDER_NAME[c.provider]).join(' y ')} conectados. Dime en cuál emito la factura.`,
    );
  return connected[0] ?? null;
}

export interface InvoicePreview {
  provider: 'siigo' | 'alegra' | null;
  providerName: string | null;
  draft: EinvoiceDraft | null;
  /** Sin programa que sepa emitir: qué hacer. */
  guidance: string | null;
}

async function buildDraft(
  db: SupabaseClient,
  session: ProviderSession,
  provider: 'siigo' | 'alegra',
  doc: SalesDocumentRow,
  choices: EinvoiceChoices | undefined,
  today: string,
): Promise<EinvoiceDraft> {
  const invoicing = session.invoicing;
  if (!invoicing)
    throw new ValidationError(`${PROVIDER_NAME[provider]} todavía no permite emitir desde Cortex.`);
  const lines = await getSalesLines(db, doc.id);
  const [catalog, customer] = await Promise.all([
    invoicing.catalog(),
    doc.client_tax_id ? invoicing.findCustomer(doc.client_tax_id) : Promise.resolve(null),
  ]);
  const reference = documentNumber(doc);
  return provider === 'siigo'
    ? buildSiigoInvoice({
        doc: { ...doc, reference },
        lines,
        catalog,
        customerFound: Boolean(customer),
        choices,
        today,
      })
    : buildAlegraInvoice({
        doc: { ...doc, reference },
        lines,
        catalog,
        customerId: customer?.id ?? null,
        choices,
        today,
      });
}

/** Lo que se le mandaría al programa, sin mandar nada. */
export async function previewInvoice(
  db: SupabaseClient,
  documentId: string,
  opts: { provider?: 'siigo' | 'alegra'; choices?: EinvoiceChoices } & EmissionDeps = {},
): Promise<InvoicePreview> {
  const doc = await getSalesDocumentRow(db, documentId);
  if (!doc) throw new NotFoundError('Ese documento ya no existe.');
  const conn = await pickConnection(db, opts.provider);
  if (!conn)
    return { provider: null, providerName: null, draft: null, guidance: NO_PROVIDER_GUIDANCE };
  const provider = conn.provider as 'siigo' | 'alegra';
  const session = await (opts.openSession ?? openAccountingSession)(db, conn.id);
  const draft = await buildDraft(
    db,
    session,
    provider,
    doc,
    opts.choices,
    opts.today ?? bogotaToday(),
  );
  return { provider, providerName: PROVIDER_NAME[provider] ?? provider, draft, guidance: null };
}

export interface EmitOutcome {
  status: 'emitted' | 'already_emitted';
  invoice: SalesDocumentRow;
  markdown: string;
}

function emittedMarkdown(invoice: SalesDocumentRow, already: boolean): string {
  const name = PROVIDER_NAME[invoice.provider ?? ''] ?? 'el programa contable';
  const bits = [
    `${already ? 'Esa factura ya estaba emitida' : 'Factura electrónica emitida'} en ${name}: **${invoice.provider_number ?? invoice.provider_invoice_id}** por ${formatMoney(invoice.total, invoice.currency)} a ${invoice.client_name}.`,
    invoice.cufe ? `CUFE: ${invoice.cufe}.` : null,
    invoice.einvoice_status
      ? `Estado ante la DIAN: ${invoice.einvoice_status}.`
      : 'El estado ante la DIAN se ve en el programa en unos minutos.',
    'Entra a la cartera con la próxima sincronización del programa (ya la pedí).',
  ];
  return bits.filter(Boolean).join(' ');
}

/** Pasa el origen (y la cotización del pedido) a «facturada». */
async function markSourcesInvoiced(db: SupabaseClient, invoice: SalesDocumentRow, userId: string) {
  let sourceId = invoice.source_id;
  for (let depth = 0; sourceId && depth < 3; depth++) {
    const source = await getSalesDocumentRow(db, sourceId);
    if (!source) return;
    const moved = await transitionStatus(
      db,
      source.id,
      ['aceptada', 'pedido', 'enviada', 'borrador'],
      {
        status: 'facturada',
        updated_by: userId,
      },
    );
    if (moved)
      await recordSalesEvent(db, source.id, 'converted', {
        userId,
        detail: `Factura ${invoice.provider_number ?? documentNumber(invoice)}`,
      });
    sourceId = source.source_id;
  }
}

export async function emitInvoice(
  ctx: {
    db: SupabaseClient;
    organizationId: string;
    userId: string;
    enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
  },
  documentId: string,
  opts: {
    provider?: 'siigo' | 'alegra';
    choices?: EinvoiceChoices;
    retryUncertain?: boolean;
  } & EmissionDeps = {},
): Promise<EmitOutcome> {
  const { db, userId } = ctx;
  const today = opts.today ?? bogotaToday();
  const source = await getSalesDocumentRow(db, documentId);
  if (!source) throw new NotFoundError('Ese documento ya no existe.');
  if (source.kind === 'invoice' && source.status === 'emitida')
    return { status: 'already_emitted', invoice: source, markdown: emittedMarkdown(source, true) };
  if (source.kind !== 'invoice' && !canInvoice(source)) {
    // ¿Ya tiene factura emitida? Entonces es la misma pregunta otra vez.
    const { data, error } = await db
      .from('sales_documents')
      .select(DOC_COLUMNS)
      .eq('source_id', source.id)
      .eq('kind', 'invoice')
      .eq('status', 'emitida')
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const inv = (await getSalesDocumentRow(db, (data as { id: string }).id)) as SalesDocumentRow;
      return { status: 'already_emitted', invoice: inv, markdown: emittedMarkdown(inv, true) };
    }
    throw new ValidationError(
      source.kind === 'quote'
        ? `${documentNumber(source)} está ${source.status}: sólo se factura una cotización aceptada o un pedido.`
        : `${documentNumber(source)} está ${source.status}: no se puede facturar.`,
    );
  }

  let invoice = await prepareInvoice(db, source, userId);
  if (invoice.status === 'emitida')
    return { status: 'already_emitted', invoice, markdown: emittedMarkdown(invoice, true) };
  if (invoice.status === 'anulada') throw new ValidationError('Esa factura está anulada.');

  const conn = await pickConnection(db, opts.provider);
  if (!conn) {
    await recordSalesEvent(db, invoice.id, 'invoice_failed', {
      userId,
      detail: 'Sin programa contable conectado para emitir.',
    });
    throw new ValidationError(
      `Preparé la factura ${documentNumber(invoice)} por ${formatMoney(invoice.total, invoice.currency)}, pero NO está emitida. ${NO_PROVIDER_GUIDANCE}`,
    );
  }
  const provider = conn.provider as 'siigo' | 'alegra';
  const name = PROVIDER_NAME[provider] ?? provider;

  // Una emisión anterior que no se supo si llegó.
  const stuck =
    invoice.status === 'emitiendo' &&
    invoice.emission_attempted_at &&
    Date.now() - Date.parse(invoice.emission_attempted_at) > STUCK_MS;
  if (invoice.status === 'emitiendo' && !stuck)
    throw new ValidationError(
      'Esta factura se está emitiendo en este momento. Espera un minuto y revisa.',
    );
  if ((invoice.emission_uncertain || stuck) && provider === 'alegra' && !opts.retryUncertain)
    throw new ValidationError(
      'El intento anterior se cortó y no se sabe si Alegra alcanzó a crear la factura. Búscala en Alegra; si no está, pide reintentar diciendo que ya revisaste.',
    );

  const session = await (opts.openSession ?? openAccountingSession)(db, conn.id);
  const draft = await buildDraft(db, session, provider, invoice, opts.choices, today);
  if (draft.problems.length) {
    const message = `No se emitió nada en ${name}. Falta arreglar: ${draft.problems.join(' ')}`;
    await db
      .from('sales_documents')
      .update({ status: 'error', provider, provider_error: message.slice(0, 2000) })
      .eq('id', invoice.id)
      .in('status', ['borrador', 'error']);
    await recordSalesEvent(db, invoice.id, 'invoice_failed', { userId, detail: message });
    throw new ValidationError(message);
  }

  // La toma: sólo una emisión a la vez por factura.
  const claimed = await transitionStatus(
    db,
    invoice.id,
    stuck ? ['emitiendo'] : ['borrador', 'error'],
    {
      status: 'emitiendo',
      provider,
      emission_attempted_at: new Date().toISOString(),
      provider_payload: draft.payload,
      provider_error: null,
      updated_by: userId,
    },
  );
  if (!claimed) {
    const now = await getSalesDocumentRow(db, invoice.id);
    if (now?.status === 'emitida')
      return { status: 'already_emitted', invoice: now, markdown: emittedMarkdown(now, true) };
    throw new ValidationError(
      'Esta factura se está emitiendo en este momento. Espera un minuto y revisa.',
    );
  }
  invoice = claimed;

  try {
    const created = await (
      session.invoicing as NonNullable<ProviderSession['invoicing']>
    ).createInvoice(draft.payload, {
      idempotencyKey: invoiceIdempotencyKey(ctx.organizationId, invoice.id),
    });
    if (!created.id)
      throw new ProviderUncertainError(
        `${name} respondió sin el número de la factura: no se sabe si quedó creada. Revisa en ${name}.`,
      );
    const done = await transitionStatus(db, invoice.id, ['emitiendo'], {
      status: 'emitida',
      provider,
      provider_invoice_id: created.id,
      provider_number: created.number,
      cufe: created.cufe,
      einvoice_status: created.einvoiceStatus,
      provider_url: created.url,
      provider_error: null,
      emission_uncertain: false,
      emitted_at: new Date().toISOString(),
    });
    invoice = done ?? ((await getSalesDocumentRow(db, invoice.id)) as SalesDocumentRow);
    await recordSalesEvent(db, invoice.id, 'invoice_emitted', {
      userId,
      detail: `${name} ${created.number ?? created.id}${created.cufe ? ` · CUFE ${created.cufe.slice(0, 16)}…` : ''}`,
    });
    await markSourcesInvoiced(db, invoice, userId);
    // Que la factura llegue a su tabla y a la cartera por el camino de siempre.
    try {
      const synced = await requestAccountingSync(db, provider);
      await ctx.enqueueJob?.('accounting/run', {
        organizationId: ctx.organizationId,
        connectionId: synced.id,
      });
    } catch {
      // La sincronización programada la trae igual (como mucho en una hora).
    }
    return { status: 'emitted', invoice, markdown: emittedMarkdown(invoice, false) };
  } catch (err) {
    const uncertain = err instanceof ProviderUncertainError;
    const message =
      err instanceof ProviderValidationError || uncertain
        ? (err as Error).message
        : `No se pudo emitir en ${name}: ${err instanceof Error ? err.message : 'error desconocido'}`;
    await db
      .from('sales_documents')
      .update({
        status: 'error',
        provider_error: message.slice(0, 2000),
        emission_uncertain: uncertain,
      })
      .eq('id', invoice.id)
      .eq('status', 'emitiendo');
    await recordSalesEvent(db, invoice.id, 'invoice_failed', { userId, detail: message });
    throw new ValidationError(message);
  }
}
