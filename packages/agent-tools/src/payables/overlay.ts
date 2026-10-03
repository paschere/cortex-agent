import type { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerMovement } from '../ledger/types';

/**
 * LO QUE CUENTAS POR PAGAR LE DICE A LA PROYECCIÓN DE CAJA (0181).
 *
 * Una factura de proveedor vive en el libro como `payable` —la fila suya, o la
 * del documento o del programa contable que la trajo primero (el libro deja
 * una sola contando, dedup.ts)—. La fila que cuenta la escribe su fuente, y
 * su fuente no sabe nada de aprobaciones ni de programación. Así que, al armar
 * la proyección, se le superpone lo que se decidió aquí:
 *
 *   programada  sale el día programado (no el vencimiento) y por el NETO de
 *               retenciones (lo que de verdad sale del banco).
 *   aprobada /  sale al vencimiento, por el neto.
 *   por aprobar
 *   pagada /    no sale más (se pagó, o no se paga): fuera de lo esperado.
 *   rechazada
 *
 * Hoja: sólo importa tipos, para que ledger/plans.ts pueda llamarla sin
 * ciclos. Si la tabla todavía no existe (la migración no está aplicada), no
 * superpone nada y la proyección sigue como antes.
 */

export interface PayableOverlayEntry {
  dueDate: string | null;
  outstanding: number | null;
  drop: boolean;
}

const OPEN_FOR_OVERLAY = [
  'recibida',
  'por_aprobar',
  'aprobada',
  'programada',
  'pagada',
  'rechazada',
];

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

/** Por id de la fila del libro QUE CUENTA: qué cambiarle. */
export async function loadPayablesOverlay(
  db: SupabaseClient,
): Promise<Map<string, PayableOverlayEntry>> {
  const out = new Map<string, PayableOverlayEntry>();
  const { data, error } = await db
    .from('payable_invoices')
    .select('ledger_movement_id, status, scheduled_pay_date, due_date, net_amount, updated_at')
    .in('status', OPEN_FOR_OVERLAY)
    .not('ledger_movement_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(3000);
  if (error) {
    if (isMissingTable(error)) return out;
    throw error;
  }
  const rows = (data ?? []) as Array<{
    ledger_movement_id: string;
    status: string;
    scheduled_pay_date: string | null;
    due_date: string | null;
    net_amount: number | string | null;
  }>;
  if (!rows.length) return out;
  // La fila del libro de cada factura puede ser una duplicada de la que manda.
  const ids = [...new Set(rows.map((r) => r.ledger_movement_id))];
  const primary = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: led, error: e } = await db
      .from('ledger_movements')
      .select('id, duplicate_of')
      .in('id', ids.slice(i, i + 100));
    if (e) throw e;
    for (const r of (led ?? []) as Array<{ id: string; duplicate_of: string | null }>)
      primary.set(r.id, r.duplicate_of ?? r.id);
  }
  for (const r of rows) {
    const target = primary.get(r.ledger_movement_id);
    if (!target || out.has(target)) continue;
    const net = r.net_amount == null ? null : Number(r.net_amount);
    out.set(target, {
      drop: r.status === 'pagada' || r.status === 'rechazada',
      dueDate: r.status === 'programada' ? r.scheduled_pay_date : null,
      outstanding: net != null && Number.isFinite(net) ? net : null,
    });
  }
  return out;
}

/** Pura: los movimientos con lo decidido encima. */
export function applyPayablesOverlay(
  movements: LedgerMovement[],
  overlay: ReadonlyMap<string, PayableOverlayEntry>,
): LedgerMovement[] {
  if (!overlay.size) return movements;
  const out: LedgerMovement[] = [];
  for (const m of movements) {
    const o = overlay.get(m.id);
    if (!o || m.kind !== 'payable' || m.status !== 'expected') {
      out.push(m);
      continue;
    }
    if (o.drop) continue;
    out.push({
      ...m,
      dueDate: o.dueDate ?? m.dueDate ?? null,
      outstanding:
        o.outstanding != null ? Math.min(o.outstanding, m.outstanding ?? m.amount) : m.outstanding,
    });
  }
  return out;
}

/** Lo de arriba, tolerante: si algo falla, la proyección sale sin superponer. */
export async function withPayablesOverlay(
  db: SupabaseClient,
  movements: LedgerMovement[],
): Promise<LedgerMovement[]> {
  try {
    return applyPayablesOverlay(movements, await loadPayablesOverlay(db));
  } catch {
    return movements;
  }
}
