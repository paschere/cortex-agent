'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type BankStatementInput,
  COLUMN_ROLES,
  type ColumnMap,
  type ColumnRole,
  STATEMENT_MAX_BYTES,
  applyPaymentToInvoice,
  importBankStatement,
  previewBankStatement,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { NotFoundError, type UUID, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { BankImportAction, BankPreviewAction } from './_components/bank-types';
import type { ActionResult } from './_components/types';

/**
 * Lo que la conciliación del banco puede hacer desde la pantalla de Pagos:
 * mirar un extracto, importarlo, y atar un abono a su factura.
 *
 * Archivo aparte de `actions.ts` a propósito: todo lo que se exporta de un
 * archivo 'use server' es un endpoint, y estos tres tienen su propio contrato
 * (FormData con el archivo). Ninguno calcula nada: delegan en
 * `previewBankStatement`, `importBankStatement` y `applyPaymentToInvoice`, las
 * mismas funciones que usan las herramientas del chat.
 *
 * Vista previa e importación reciben el MISMO archivo: el navegador lo guarda
 * entre los dos pasos y lo vuelve a mandar. Así no hay un archivo a medio
 * importar guardado en ninguna parte, y lo que se importa es exactamente lo que
 * se vio (la referencia de cada abono sale de su contenido).
 */

const PATH = '/payments';

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function statementFrom(form: FormData): Promise<BankStatementInput> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new ValidationError('Elige el archivo del extracto (Excel o CSV).');
  }
  if (file.size > STATEMENT_MAX_BYTES) {
    throw new ValidationError('El archivo pasa de 10 MB. Divide el periodo en dos.');
  }
  const currency = String(form.get('currency') ?? '').trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('Escoge la moneda de la cuenta.');
  }
  let mapping: BankStatementInput['mapping'] = null;
  const rawMapping = form.get('mapping');
  if (typeof rawMapping === 'string' && rawMapping.trim()) {
    let parsed: { headerRow?: unknown; columns?: unknown };
    try {
      parsed = JSON.parse(rawMapping) as { headerRow?: unknown; columns?: unknown };
    } catch {
      throw new ValidationError('Las columnas escogidas no llegaron bien. Vuelve a escogerlas.');
    }
    const columns: ColumnMap = {};
    for (const [role, idx] of Object.entries((parsed.columns ?? {}) as Record<string, unknown>)) {
      if (!COLUMN_ROLES.includes(role as ColumnRole)) continue;
      if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < 200) {
        columns[role as ColumnRole] = idx;
      }
    }
    const headerRow =
      typeof parsed.headerRow === 'number' && Number.isInteger(parsed.headerRow)
        ? Math.max(-1, Math.min(parsed.headerRow, 200))
        : undefined;
    mapping = { headerRow, columns };
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name.slice(0, 240),
    mime: file.type || null,
    accountLabel: String(form.get('accountLabel') ?? ''),
    currency,
    mapping,
  };
}

export async function previewStatement(form: FormData): Promise<BankPreviewAction> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await previewBankStatement(db, await statementFrom(form));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer el extracto.') };
  }
}

export async function importStatement(form: FormData): Promise<BankImportAction> {
  const user = await requireSession();
  const started = performance.now();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const input = await statementFrom(form);
    const result = await importBankStatement(db, { ...input, createdBy: user.id });
    if (result.status === 'needs_mapping') {
      return { ok: false, needsMapping: true, error: result.message };
    }
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'payments.import_bank_statement',
      input: { fileName: input.fileName, account: result.preview.accountLabel },
      status: result.rejected.length > 0 ? 'error' : 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: {
        system: result.preview.system,
        created: result.created,
        agreed: result.agreed,
        disputed: result.disputed,
        duplicates: result.duplicates,
        autoMatched: result.autoMatched,
        rejected: result.rejected.length,
      },
    });
    revalidatePath(PATH);
    return { ok: true, note: result.sentence };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo importar el extracto.') };
  }
}

export async function applySuggestion(input: {
  paymentId: string;
  kind: 'document' | 'accounting';
  invoiceId: string;
}): Promise<ActionResult> {
  const user = await requireSession();
  const started = performance.now();
  try {
    if (input.kind !== 'document' && input.kind !== 'accounting') {
      throw new ValidationError('Esa factura no es válida.');
    }
    const db = getOrgScopedClient(user.organization.id);
    const payment = await applyPaymentToInvoice(db, {
      paymentId: input.paymentId,
      // Quien ata es la persona de la sesión. No hay forma de pasar otra.
      userId: user.id,
      invoice: { kind: input.kind, id: input.invoiceId },
    });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'payments.apply_to_invoice',
      input,
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { paymentId: payment.id, invoiceNumber: payment.invoice_number },
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `Atado a la factura ${payment.invoice_number ?? ''} bajo tu nombre.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo atar el pago a la factura.') };
  }
}
