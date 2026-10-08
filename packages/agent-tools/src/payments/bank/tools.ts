import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getFile } from '../../files';
import { registerTool } from '../../index';
import { getVisibleDocument } from '../../kb/spaces';
import { applyPaymentToInvoice } from '../store';
import { normalizeHeader } from './format';
import type { ManualMapping, NeedsMapping } from './parse';
import { COLUMN_ROLES, type ColumnMap, type ColumnRole } from './profiles';
import { parseStatementFile } from './read';
import {
  type BankStatementInput,
  type BankStatementPreview,
  bankReconciliation,
  importBankStatement,
  previewBankStatement,
} from './store';

/**
 * El extracto del banco, desde el chat.
 *
 * El archivo llega como un adjunto de la conversación o como un archivo del
 * Feed —los dos son filas de `chat_attachments` con sus bytes en
 * 'chat-uploads'—, y la herramienta lo pide por el `id` de su etiqueta
 * `<archivo>`. Primero se mira (`preview_bank_statement`, sólo lectura), luego
 * se importa (`import_bank_statement`, con confirmación obligatoria e
 * indelegable: mete dinero en la cartera de la empresa).
 *
 * Cuando el formato no se reconoce, la vista previa devuelve los encabezados
 * encontrados y unas filas de muestra; el modelo se los enseña a la persona y
 * repite la llamada con `columns`, nombrando cada papel por su encabezado. No
 * hay un modelo adivinando columnas por su cuenta: con dinero, la persona
 * escoge.
 */

const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe(
    'Tres letras. Una cuenta colombiana en pesos es COP; una cuenta en dólares, USD. Obligatoria y nunca se asume.',
  );

const ROLE_ENUM = z.enum(COLUMN_ROLES as [ColumnRole, ...ColumnRole[]]);

const STATEMENT_INPUT = z.object({
  fileId: z
    .string()
    .uuid()
    .nullish()
    .describe(
      'El `id` de la etiqueta `<archivo>` del extracto (adjunto del chat o archivo del Feed). Usa fileId O documentId, nunca los dos.',
    ),
  documentId: z
    .string()
    .uuid()
    .nullish()
    .describe(
      'El `result.download.documentId` que devolvió browser.run_flow cuando un trámite bajó el extracto del portal del banco (queda en Brain Knowledge). Usa documentId O fileId, nunca los dos.',
    ),
  accountLabel: z
    .string()
    .min(2)
    .max(48)
    .describe(
      'El nombre de la cuenta, por ejemplo «Bancolombia corriente 1234». Usa SIEMPRE el mismo para la misma cuenta: es lo que evita duplicar al volver a importar.',
    ),
  currency: CURRENCY,
  bank: z
    .enum(['bancolombia', 'davivienda', 'bbva', 'bogota', 'generic'])
    .nullish()
    .describe('Sólo si la detección se equivocó. Cambia la etiqueta, no lo que se lee.'),
  columns: z
    .record(ROLE_ENUM, z.union([z.string().min(1), z.number().int().min(1)]))
    .nullish()
    .describe(
      'Sólo cuando la vista previa dijo que no reconoció las columnas: qué encabezado (o qué número de columna, desde 1) es cada papel. Mínimo date y amount (valor con signo) o credit.',
    ),
  headerRow: z
    .number()
    .int()
    .min(0)
    .nullish()
    .describe('La fila de encabezados, desde 1; 0 si el archivo no trae encabezados.'),
});

type StatementToolInput = z.infer<typeof STATEMENT_INPUT>;

/** Un adjunto o archivo del Feed de esta persona, con sus bytes. */
async function loadStatementFile(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<{ bytes: Uint8Array; fileName: string; mime: string | null }> {
  const { data, error } = await db
    .from('chat_attachments')
    .select('id, filename, mime, file_path, extracted_text')
    .eq('id', id)
    .eq('created_by', userId)
    .gt('purge_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    filename: string;
    mime: string | null;
    file_path: string | null;
    extracted_text: string | null;
  } | null;
  if (!row) {
    throw new NotFoundError(
      'No encuentro ese archivo. Súbelo al chat o al Feed (los adjuntos duran una semana) y vuelve a intentarlo.',
    );
  }
  if (row.file_path) {
    const stored = await getFile(db, 'chat-uploads', row.file_path);
    if (stored) return { bytes: stored.content, fileName: row.filename, mime: row.mime };
  }
  // Sin bytes guardados sólo sirve si era texto plano (un CSV): el texto de un
  // Excel ya leído es una tabla en markdown, no las celdas.
  if (row.extracted_text && /csv|text\/plain/.test(row.mime ?? '')) {
    return {
      bytes: Buffer.from(row.extracted_text, 'utf8'),
      fileName: row.filename,
      mime: row.mime,
    };
  }
  throw new ValidationError(
    `De «${row.filename}» no quedó el archivo original. Vuelve a subirlo en Excel o CSV.`,
  );
}

/**
 * Un archivo que bajó un trámite: vive en Brain Knowledge (`kb_documents`, bytes
 * en 'kb-uploads' bajo `source_ref`). Pasa por la misma puerta de visibilidad que
 * el resto del cerebro: un documento de un espacio que esta persona no ve, o de
 * otra organización, se lee como si no existiera.
 */
export async function loadStatementDocument(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<{ bytes: Uint8Array; fileName: string; mime: string | null }> {
  const visible = await getVisibleDocument(db, userId, id).catch(() => null);
  if (!visible) {
    throw new NotFoundError(
      'No encuentro ese documento en Brain Knowledge, o no es tuyo. Vuelve a correr el trámite que baja el extracto.',
    );
  }
  const { data, error } = await db
    .from('kb_documents')
    .select('source_ref, mime, title')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  const sourceRef = (data?.source_ref as string | null) ?? null;
  if (!sourceRef) {
    throw new ValidationError(
      `«${visible.title}» no tiene un archivo detrás (es texto guardado). Necesito el Excel o CSV del extracto.`,
    );
  }
  const stored = await getFile(db, 'kb-uploads', sourceRef).catch(() => null);
  if (!stored) {
    throw new NotFoundError(
      `No encontré los bytes de «${visible.title}». Vuelve a bajar el extracto.`,
    );
  }
  return {
    bytes: stored.content,
    fileName: sourceRef.split('/').pop() || visible.title,
    mime: (data?.mime as string | null) ?? stored.contentType ?? null,
  };
}

/**
 * Las columnas que nombró la persona, de encabezado a índice. Se leen los
 * encabezados del propio archivo para que «Valor Total» signifique la columna
 * que se llama así y no otra.
 */
async function mappingFrom(
  file: { bytes: Uint8Array; fileName: string; mime: string | null },
  input: StatementToolInput,
): Promise<ManualMapping | null> {
  if (!input.columns || Object.keys(input.columns).length === 0) return null;
  let headerRow: number;
  let headers: string[];
  if (input.headerRow != null) {
    headerRow = input.headerRow - 1;
    const probe = await parseStatementFile(file.bytes, file.fileName, file.mime, {
      mapping: { headerRow, columns: {} },
    });
    headers = probe.headers;
  } else {
    const probe = await parseStatementFile(file.bytes, file.fileName, file.mime);
    headerRow = probe.headerRow;
    headers = probe.headers;
  }
  const normalized = headers.map(normalizeHeader);
  const columns: ColumnMap = {};
  for (const [role, value] of Object.entries(input.columns) as Array<
    [ColumnRole, string | number]
  >) {
    const idx = typeof value === 'number' ? value - 1 : normalized.indexOf(normalizeHeader(value));
    if (idx < 0 || idx >= Math.max(headers.length, 1)) {
      throw new ValidationError(
        `No encuentro la columna «${value}». Las del archivo son: ${headers.join(', ')}.`,
      );
    }
    columns[role] = idx;
  }
  return { headerRow, columns };
}

async function statementInput(
  db: SupabaseClient,
  userId: string,
  input: StatementToolInput,
): Promise<BankStatementInput> {
  if (input.fileId && input.documentId) {
    throw new ValidationError('Pasa fileId o documentId, no los dos.');
  }
  if (!input.fileId && !input.documentId) {
    throw new ValidationError(
      'Falta el archivo: pasa fileId (adjunto del chat o Feed) o documentId (el que bajó un trámite con browser.run_flow).',
    );
  }
  const file = input.documentId
    ? await loadStatementDocument(db, input.documentId, userId)
    : await loadStatementFile(db, input.fileId as string, userId);
  return {
    ...file,
    accountLabel: input.accountLabel,
    currency: input.currency,
    bank: input.bank ?? null,
    mapping: await mappingFrom(file, input),
  };
}

function cop(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

function needsMappingOutput(r: NeedsMapping) {
  return {
    status: 'needs_mapping' as const,
    guidance: `${r.message} Pregúntale a la persona qué es cada columna y vuelve a llamar con \`columns\`.`,
    headers: r.headers,
    headerRow: r.headerRow + 1,
    sample: r.sample.slice(0, 4),
  };
}

function previewSentence(p: BankStatementPreview): string {
  const period = p.period ? ` del ${p.period.from} al ${p.period.to}` : '';
  const parts = [
    `Extracto de ${p.bank.label}${period}: ${p.credits} abono(s) por ${cop(p.creditsTotal, p.currency)}.`,
  ];
  if (p.duplicates > 0) parts.push(`${p.duplicates} ya estaban importados y se saltarían.`);
  parts.push(
    `De los ${p.newCredits} nuevos, ${p.matched} se atarían solos a su factura, ${p.suggested} tienen una sugerencia para confirmar y ${p.unmatched} no tienen factura a la vista.`,
  );
  if (p.debitsIgnored > 0)
    parts.push(
      `Las ${p.debitsIgnored} salidas no entran a Pagos; al importar quedan en el libro de plata como gastos.`,
    );
  if (p.skipped > 0) parts.push(`${p.skipped} fila(s) no se pudieron leer.`);
  return [...parts, ...p.warnings].join(' ');
}

const LINE = z.object({
  date: z.string(),
  amount: z.number(),
  description: z.string(),
  duplicate: z.boolean(),
  status: z.string().nullable(),
  invoice: z.string().nullable(),
});

export const paymentsPreviewBankStatement = registerTool({
  id: 'payments.preview_bank_statement',
  description:
    'Mirar un extracto bancario (Excel o CSV de Bancolombia, Davivienda, BBVA, Banco de Bogotá u otro) antes de importarlo, sin escribir nada: qué banco es, cuántos abonos trae y por cuánto, cuántos ya estaban importados, y a qué factura iría cada uno. Las salidas no entran a Pagos; al importar quedan en el libro de plata. El extracto puede ser un adjunto del chat (fileId) o el archivo que bajó un trámite del portal del banco (documentId = result.download.documentId de browser.run_flow). Úsalo SIEMPRE antes de payments.import_bank_statement y cuéntale el resumen a la persona. Si dice needs_mapping, enséñale los encabezados y pregúntale qué columna es cada cosa.',
  inputSchema: STATEMENT_INPUT,
  outputSchema: z.object({
    status: z.enum(['ready', 'needs_mapping']),
    guidance: z.string(),
    bank: z.string().optional(),
    credits: z.number().optional(),
    creditsTotal: z.number().optional(),
    duplicates: z.number().optional(),
    newCredits: z.number().optional(),
    matched: z.number().optional(),
    suggested: z.number().optional(),
    unmatched: z.number().optional(),
    lines: z.array(LINE).optional(),
    headers: z.array(z.string()).optional(),
    headerRow: z.number().optional(),
    sample: z.array(z.array(z.string())).optional(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const result = await previewBankStatement(
      ctx.db,
      await statementInput(ctx.db, ctx.userId, input),
    );
    if (result.status === 'needs_mapping') return needsMappingOutput(result);
    return {
      status: 'ready' as const,
      guidance: previewSentence(result),
      bank: result.bank.label,
      credits: result.credits,
      creditsTotal: result.creditsTotal,
      duplicates: result.duplicates,
      newCredits: result.newCredits,
      matched: result.matched,
      suggested: result.suggested,
      unmatched: result.unmatched,
      lines: result.lines.slice(0, 25).map((l) => ({
        date: l.date,
        amount: l.amount,
        description: l.description.slice(0, 120),
        duplicate: l.duplicate,
        status: l.status,
        invoice: l.suggestions[0]?.label ?? null,
      })),
    };
  },
});

export const paymentsImportBankStatement = registerTool({
  id: 'payments.import_bank_statement',
  description:
    'Importar los abonos de un extracto bancario a Pagos. Cada abono nuevo queda registrado como dicho por el banco; los que cuadran sin duda (valor exacto y el número de la factura o el NIT en la descripción) quedan atados a su factura, y los demás quedan por revisar con sugerencias en /payments. Reimportar el mismo archivo o un periodo que se solapa NO duplica nada. Las salidas (débitos) no entran a Pagos: quedan en el libro de plata como gastos, y el saldo de cierre del extracto queda como saldo de la cuenta. Mismo archivo que la vista previa: fileId (adjunto) o documentId (lo que bajó un trámite con browser.run_flow). Llama antes a payments.preview_bank_statement. Requiere confirmación.',
  inputSchema: STATEMENT_INPUT,
  outputSchema: z.object({
    status: z.enum(['imported', 'needs_mapping']),
    guidance: z.string(),
    created: z.number().optional(),
    duplicates: z.number().optional(),
    autoMatched: z.number().optional(),
    suggested: z.number().optional(),
    unmatched: z.number().optional(),
    disputed: z.number().optional(),
    headers: z.array(z.string()).optional(),
    headerRow: z.number().optional(),
    sample: z.array(z.array(z.string())).optional(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const result = await importBankStatement(ctx.db, {
      ...(await statementInput(ctx.db, ctx.userId, input)),
      createdBy: ctx.userId,
    });
    if (result.status === 'needs_mapping') return needsMappingOutput(result);
    return {
      status: 'imported' as const,
      guidance: `${result.sentence} Lo que quedó por revisar está en Pagos → Conciliación del banco.`,
      created: result.created,
      duplicates: result.duplicates,
      autoMatched: result.autoMatched,
      suggested: result.preview.suggested,
      unmatched: result.preview.unmatched,
      disputed: result.disputed,
    };
  },
});

export const paymentsBankUnmatched = registerTool({
  id: 'payments.bank_unmatched',
  description:
    'Los abonos que entraron por el extracto del banco y todavía no están atados a una factura: los que tienen una factura sugerida (con el porqué) y los que no tienen ninguna a la vista. Responde «¿qué pagos del banco no sé de qué son?» y «¿qué falta por conciliar?». Sólo lectura.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(20),
  }),
  outputSchema: z.object({
    suggested: z.number(),
    unmatched: z.number(),
    matched: z.number(),
    items: z.array(
      z.object({
        paymentId: z.string(),
        date: z.string(),
        amount: z.number(),
        currency: z.string(),
        description: z.string(),
        account: z.string().nullable(),
        status: z.string(),
        reason: z.string(),
        suggestions: z.array(
          z.object({
            kind: z.enum(['document', 'accounting']),
            invoiceId: z.string(),
            label: z.string(),
            reasons: z.array(z.string()),
          }),
        ),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const recon = await bankReconciliation(ctx.db);
    const items = [...recon.suggested, ...recon.unmatched].slice(0, input.limit);
    return {
      suggested: recon.suggested.length,
      unmatched: recon.unmatched.length,
      matched: recon.matched.length,
      items: items.map((i) => ({
        paymentId: i.paymentId,
        date: i.date,
        amount: i.amount,
        currency: i.currency,
        description: i.description.slice(0, 160),
        account: i.account,
        status: i.status,
        reason: i.reason,
        suggestions: i.suggestions.map((s) => ({
          kind: s.kind,
          invoiceId: s.id,
          label: s.label,
          reasons: s.reasons,
        })),
      })),
      guidance:
        recon.suggested.length + recon.unmatched.length === 0
          ? 'Todo lo que entró por el banco está atado a su factura.'
          : `${recon.suggested.length} abono(s) tienen una factura sugerida y ${recon.unmatched.length} no tienen ninguna a la vista. Para atar uno, confírmalo con la persona y usa payments.apply_to_invoice.`,
    };
  },
});

export const paymentsApplyToInvoice = registerTool({
  id: 'payments.apply_to_invoice',
  description:
    'Atar un pago que entró sin factura (normalmente un abono del extracto del banco) a la factura que paga, cuando la persona lo confirmó. Sólo rellena la factura que le faltaba: no cambia el importe, no cruza monedas y no re-atribuye un pago que ya tenía factura. Los ids salen de payments.bank_unmatched. Requiere confirmación.',
  inputSchema: z.object({
    paymentId: z.string().uuid(),
    invoiceKind: z
      .enum(['document', 'accounting'])
      .describe('El `kind` de la sugerencia: factura leída o factura del programa contable.'),
    invoiceId: z.string().uuid(),
  }),
  outputSchema: z.object({
    paymentId: z.string(),
    invoiceNumber: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const payment = await applyPaymentToInvoice(ctx.db, {
      paymentId: input.paymentId,
      userId: ctx.userId,
      invoice: { kind: input.invoiceKind, id: input.invoiceId },
    });
    return {
      paymentId: payment.id,
      invoiceNumber: payment.invoice_number,
      guidance: `Listo: el pago quedó atado a la factura ${payment.invoice_number ?? 'escogida'}, bajo tu nombre.`,
    };
  },
});
