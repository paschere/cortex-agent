import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentKind } from './shape';
import { type RecordOutcome, recordPaymentReport } from './store';

/**
 * Traer los movimientos de un sistema contable o de un banco.
 *
 * ESTO ES LO QUE HACE QUE UNA FUENTE NUEVA CUESTE UN IMPORTADOR Y CERO
 * MIGRACIONES, y por eso está terminado y sin ningún conector concreto dentro.
 * Conectar Siigo mañana es escribir UNA función que devuelva
 * `SystemPaymentRow[]` — la que hable con su API, o la que lea el CSV que el
 * contador exporta — y llamar a `importSystemPayments` con ella. Nada de la
 * 0098, nada de store.ts y nada de este archivo cambia. World Office es otra
 * función igual. Un extracto de Bancolombia, otra.
 *
 * LO ÚNICO QUE UNA FUENTE NUEVA TIENE QUE PROMETER son las cuatro cosas que un
 * pago necesita para existir, y las cuatro se comprueban aquí antes de escribir:
 *
 *   `sourceRef`   El identificador que la fuente le da al movimiento. Sin él la
 *                 reimportación duplica, porque `payment_reports_source_once_idx`
 *                 sólo cubre las filas que lo traen. Una fuente que no tiene un
 *                 identificador estable se importa una vez y a mano.
 *   `amount`      Un número no negativo. El signo lo pone `kind`.
 *   `currency`    Tres letras. NUNCA se asume: una fila sin moneda se rechaza y
 *                 sale en `rejected` con el motivo, en vez de entrar como pesos.
 *   `paidOn`      El día del dinero, no el día de la lectura.
 *
 * REIMPORTAR ES SEGURO POR CONSTRUCCIÓN. Cada fila pasa por
 * `recordPaymentReport`, que descarta las que ya estaban por `sourceRef` y
 * enlaza —no duplica— las que otra fuente ya había contado. Volver a traer el
 * mismo mes de Siigo devuelve `duplicates` igual al número de filas y no mueve
 * ni un peso.
 */

export interface SystemPaymentRow {
  /** El identificador de ESE sistema para ESE movimiento. Obligatorio. */
  sourceRef: string;
  amount: number;
  currency: string;
  /** AAAA-MM-DD. */
  paidOn: string;
  kind?: PaymentKind;
  /** En cualquier formato: se compara dígito a dígito contra la lista de clientes. */
  clientNit?: string | null;
  invoiceNumber?: string | null;
  /** Lo que el sistema escribió al lado del apunte, para que alguien lo reconozca. */
  reference?: string | null;
  note?: string | null;
}

export interface ImportSystemPaymentsInput {
  /** Cómo se llama la fuente: 'siigo', 'world-office', 'bancolombia'… */
  system: string;
  /** Cuándo se leyó. Un valor importado es un hecho sobre un MOMENTO. */
  readAt?: string;
  rows: SystemPaymentRow[];
  createdBy?: string | null;
}

export interface ImportSystemPaymentsResult {
  system: string;
  readAt: string;
  created: number;
  agreed: number;
  disputed: number;
  duplicates: number;
  rejected: Array<{ sourceRef: string | null; reason: string }>;
  /** Lo que pasó, en español, listo para decirse tal cual. */
  sentence: string;
}

export async function importSystemPayments(
  db: SupabaseClient,
  input: ImportSystemPaymentsInput,
): Promise<ImportSystemPaymentsResult> {
  const system = input.system.trim().toLowerCase().slice(0, 60);
  const readAt = input.readAt ?? new Date().toISOString();
  const counts: Record<RecordOutcome, number> = {
    created: 0,
    agreed: 0,
    disputed: 0,
    duplicate: 0,
  };
  const rejected: Array<{ sourceRef: string | null; reason: string }> = [];

  for (const row of input.rows) {
    const ref = row.sourceRef?.trim() || null;
    if (!ref) {
      // Sin referencia estable no hay idempotencia, y una importación que
      // duplica en silencio es peor que una que no corre.
      rejected.push({
        sourceRef: null,
        reason:
          'sin referencia del sistema de origen: no se puede garantizar que reimportar no duplique',
      });
      continue;
    }
    try {
      const result = await recordPaymentReport(db, {
        source: { kind: 'system', system, readAt },
        kind: row.kind ?? 'payment',
        amount: row.amount,
        currency: row.currency,
        paidOn: row.paidOn,
        clientNit: row.clientNit ?? null,
        invoiceNumber: row.invoiceNumber ?? null,
        reference: row.reference ?? null,
        note: row.note ?? null,
        sourceRef: ref,
        createdBy: input.createdBy ?? null,
      });
      counts[result.outcome] += 1;
    } catch (err) {
      rejected.push({
        sourceRef: ref,
        reason: err instanceof Error ? err.message : 'error desconocido',
      });
    }
  }

  return {
    system,
    readAt,
    created: counts.created,
    agreed: counts.agreed,
    disputed: counts.disputed,
    duplicates: counts.duplicate,
    rejected,
    sentence: describeImport(system, counts, rejected.length),
  };
}

function describeImport(
  system: string,
  counts: Record<RecordOutcome, number>,
  rejectedCount: number,
): string {
  const parts: string[] = [];
  if (counts.created > 0) parts.push(`${counts.created} pago(s) nuevo(s)`);
  if (counts.agreed > 0) {
    parts.push(`${counts.agreed} que confirman uno que ya estaba (sin duplicar el importe)`);
  }
  if (counts.disputed > 0) {
    parts.push(
      `${counts.disputed} que NO cuadran con lo que ya había y quedaron en disputa, fuera de toda cifra`,
    );
  }
  if (counts.duplicate > 0)
    parts.push(`${counts.duplicate} que ya estaban y no se volvieron a contar`);
  if (parts.length === 0 && rejectedCount === 0) return `De ${system} no llegó ningún movimiento.`;

  const lines = [`De ${system}: ${parts.join(', ')}.`];
  if (rejectedCount > 0) {
    lines.push(
      `${rejectedCount} fila(s) se rechazaron por venir incompletas (sin moneda, sin fecha o sin referencia) — están sin registrar, no registradas a medias.`,
    );
  }
  if (counts.disputed > 0) {
    lines.push(
      'Las disputas las resuelve una persona: no se promedian ni gana ninguna fuente por serlo.',
    );
  }
  return lines.join(' ');
}
