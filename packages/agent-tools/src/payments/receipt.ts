import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientMatchState } from './shape';
import { type RecordPaymentReportResult, recordPaymentReport } from './store';

/**
 * Un comprobante de pago confirmado se convierte en un reporte de pago.
 *
 * ESTE ARCHIVO ES LA SEGUNDA FUENTE, Y NO COSTÓ NINGUNA MIGRACIÓN. Un
 * comprobante es un tipo más en DOCUMENT_TYPES (`payment_receipt`), y por serlo
 * heredó gratis las tres cosas caras: la cita literal obligatoria, la
 * verificación de verify.ts —que rechaza un importe que no está escrito en la
 * frase, porque la aritmética no es lectura— y la cola de revisión. Aquí sólo
 * queda traducir lo que una persona ya confirmó al vocabulario de la 0098.
 *
 * POR QUÉ EL PUENTE VA EN ESTE SENTIDO. `documents/store.ts` llama aquí al
 * confirmar, y este módulo no importa nada de `documents/store`: recibe la
 * extracción y sus campos como datos planos. Si fuera al revés harían falta dos
 * puertas —el tool de confirmación y la acción de la pantalla— y la lección de
 * la 0064 es exactamente ésa: una tabla con dos escritores acaba teniendo uno
 * que se olvidó, y la lectura sigue funcionando mientras nadie guarda nada.
 *
 * NADA DE LO QUE PASE AQUÍ PUEDE ROMPER UNA CONFIRMACIÓN. Un comprobante sin
 * moneda, sin importe o sin fecha no produce un pago — produce una frase que
 * dice por qué, y el documento queda confirmado igual. Un fallo escribiendo el
 * pago tampoco deshace la revisión que una persona acaba de hacer.
 */

export const RECEIPT_DOC_TYPE = 'payment_receipt';

/** Un campo del comprobante, ya resuelto: la corrección si la hubo, si no la lectura. */
export interface ReceiptField {
  fieldKey: string;
  reviewState: 'pending' | 'confirmed' | 'rejected';
  text: string | null;
  number: number | null;
  date: string | null;
  currency: string | null;
  quote: string;
  chunkId: string | null;
}

/** La cabecera del comprobante, tal y como queda tras `settleExtraction`. */
export interface ReceiptExtraction {
  id: string;
  documentId: string;
  docType: string | null;
  reviewState: string;
  clientId: string | null;
  clientNit: string | null;
  clientMatchState: ClientMatchState;
  totalAmount: number | null;
  currency: string | null;
  issuedOn: string | null;
}

export interface ReceiptOutcome {
  recorded: boolean;
  /** En español, y siempre presente cuando no se registró nada. */
  reason: string | null;
  result: RecordPaymentReportResult | null;
}

const SKIPPED = (reason: string | null): ReceiptOutcome => ({
  recorded: false,
  reason,
  result: null,
});

export async function recordReceiptPayment(
  db: SupabaseClient,
  input: { extraction: ReceiptExtraction; fields: ReceiptField[]; userId?: string | null },
): Promise<ReceiptOutcome> {
  const { extraction } = input;
  if (extraction.docType !== RECEIPT_DOC_TYPE) return SKIPPED(null);
  if (extraction.reviewState !== 'confirmed') {
    // Mientras quede un campo pendiente el comprobante no es un hecho, y la
    // regla de la 0076 —dinero sin revisar no llega a un total— no admite un
    // atajo por venir de otro módulo.
    return SKIPPED(null);
  }

  const amount = extraction.totalAmount;
  if (amount == null) {
    return SKIPPED(
      'El comprobante quedó confirmado, pero nadie confirmó el valor pagado, así que no se registró ningún pago.',
    );
  }
  if (!extraction.currency) {
    return SKIPPED(
      'El comprobante quedó confirmado, pero no dice en qué moneda se pagó. No se registró ningún pago: un importe sin moneda no es un importe, y asumir pesos sobre un abono en dólares es un error de cuatro mil veces.',
    );
  }
  if (!extraction.issuedOn) {
    return SKIPPED(
      'El comprobante quedó confirmado, pero no tiene fecha de pago confirmada, así que no se registró ningún pago.',
    );
  }

  const confirmed = input.fields.filter((f) => f.reviewState === 'confirmed');
  const amountField = confirmed.find((f) => f.number != null && f.number === amount);
  // La cita del importe, que es la frase que sostiene el número. Sin ella la
  // CHECK `payment_reports_source_document` rechazaría la fila, y con razón.
  const quote = (amountField?.quote ?? '').trim();
  if (quote.length < 8) {
    return SKIPPED(
      'El comprobante quedó confirmado, pero no conserva la frase de la que se leyó el importe. Un pago de origen documental sin su cita no se guarda.',
    );
  }

  const invoiceNumber =
    confirmed.find((f) => f.fieldKey === 'invoice_number')?.text?.slice(0, 120) ?? null;
  const reference =
    confirmed.find((f) => f.fieldKey === 'bank_reference')?.text?.slice(0, 200) ?? null;
  const method = confirmed.find((f) => f.fieldKey === 'payment_method')?.text ?? null;

  try {
    const result = await recordPaymentReport(db, {
      source: {
        kind: 'document',
        documentId: extraction.documentId,
        chunkId: amountField?.chunkId ?? null,
        quote,
      },
      amount,
      currency: extraction.currency,
      paidOn: extraction.issuedOn,
      clientId: extraction.clientMatchState === 'matched' ? extraction.clientId : null,
      clientNit: extraction.clientNit,
      invoiceNumber,
      reference,
      note: method ? `Medio de pago: ${method}.` : null,
      // La extracción es única por documento (0076), así que esta referencia lo
      // es también: volver a confirmar el mismo comprobante no vuelve a
      // registrar el pago. Lo garantiza payment_reports_source_once_idx, no un
      // if() esperanzado aquí.
      sourceRef: `extraction:${extraction.id}`,
      createdBy: input.userId ?? null,
    });
    return { recorded: result.outcome !== 'duplicate', reason: result.note, result };
  } catch (err) {
    // Una confirmación que ya ocurrió no se deshace porque el pago no se pudo
    // escribir. Se devuelve la frase y quien la lea decide.
    return SKIPPED(
      `El comprobante quedó confirmado, pero no se pudo registrar el pago: ${err instanceof Error ? err.message : 'error desconocido'}.`,
    );
  }
}
