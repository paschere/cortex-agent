import type { UUID } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditEvent } from '../audit';
import { isCompanyManager } from '../directory/store';

/**
 * LA NÓMINA POR PERSONA, SU PUERTA Y SU REGISTRO (0235).
 *
 * La nómina por persona (salarios) se trae por defecto como todo lo demás, pero
 * es de las pocas cosas que NO se comparten con el equipo:
 *
 *   - Vive en `accounting_payroll_lines`, que no es una tabla de «Tablas»: no
 *     aparece en vistas, apps, enlaces públicos ni en el selector de fuentes.
 *   - El permiso «nómina» es simple: quien administra la empresa o es su dueño
 *     (`isCompanyManager`). Si no se puede saber quién mira, no hay permiso.
 *   - Los movimientos contables de las cuentas de nómina (5105, 2505…) salen
 *     SIN tercero en la tabla compartida; quien tiene el permiso los ve con su
 *     tercero por `readPayrollMovements`, y cada lectura queda en
 *     `audit_events` (quién, qué periodo, cuántas líneas).
 *   - El modelo sólo llega al detalle por esta puerta, así que a quien no tiene
 *     permiso le contesta con totales.
 */

export const PAYROLL_DETAIL_TOOL_ID = 'accounting.payroll_detail';

/** ¿Esta persona puede ver la nómina por persona? Falla cerrado. */
export async function canReadPayroll(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  try {
    return await isCompanyManager(db, userId);
  } catch {
    return false;
  }
}

/** Una línea de «lectura de nómina» en la auditoría. Nunca lanza. */
export async function auditPayrollRead(
  db: SupabaseClient,
  input: {
    userId: string | null | undefined;
    allowed: boolean;
    what: string;
    period?: string | null;
    lines?: number;
    people?: number;
  },
): Promise<void> {
  if (!input.userId) return;
  await writeAuditEvent({
    db,
    userId: input.userId as UUID,
    toolId: PAYROLL_DETAIL_TOOL_ID,
    input: { what: input.what, period: input.period ?? null },
    status: input.allowed ? 'ok' : 'error',
    latencyMs: 0,
    decision: input.allowed ? 'allowed' : 'blocked',
    riskLevel: 'high',
    riskReason: input.allowed
      ? `Lectura de nómina por persona (${input.what})`
      : `Intento de leer nómina por persona sin permiso (${input.what})`,
    metadata: {
      what: input.what,
      period: input.period ?? null,
      lines: input.lines ?? 0,
      people: input.people ?? 0,
    },
  });
}

export interface PayrollMovementLine {
  journal: string | null;
  date: string;
  account: string;
  concept: string;
  group: string;
  movement: 'debit' | 'credit';
  amount: number;
  /** Identificación del tercero (la persona). */
  personTaxId: string | null;
  personName: string | null;
  description: string | null;
}

export interface PayrollMovements {
  allowed: boolean;
  lines: PayrollMovementLine[];
  /** Más líneas de las que se devuelven. */
  truncated: boolean;
}

interface DbLine {
  journal_name: string | null;
  journal_date: string;
  account_code: string;
  concept: string;
  concept_group: string;
  movement: 'debit' | 'credit';
  amount: number | string;
  person_tax_id: string | null;
  person_name: string | null;
  description: string | null;
}

/**
 * Los movimientos de nómina de un periodo CON tercero, sólo para quien tiene el
 * permiso. Sin permiso devuelve `allowed: false` y ninguna línea (y deja el
 * intento en la auditoría). Cada lectura permitida queda auditada.
 */
export async function readPayrollMovements(
  db: SupabaseClient,
  opts: {
    viewerId: string | null | undefined;
    period: string;
    account?: string;
    limit?: number;
  },
): Promise<PayrollMovements> {
  const allowed = await canReadPayroll(db, opts.viewerId);
  if (!allowed) {
    await auditPayrollRead(db, {
      userId: opts.viewerId,
      allowed: false,
      what: 'movimientos de nómina con tercero',
      period: opts.period,
    });
    return { allowed: false, lines: [], truncated: false };
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  let q = db
    .from('accounting_payroll_lines')
    .select(
      'journal_name, journal_date, account_code, concept, concept_group, movement, amount, person_tax_id, person_name, description',
    )
    .eq('period', opts.period)
    .order('journal_date')
    .order('journal_id')
    .order('line_index')
    .limit(limit + 1);
  if (opts.account) q = q.like('account_code', `${opts.account.replace(/\D/g, '')}%`);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as DbLine[];
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  // Nombre por documento, de la nómina de Cortex, si la persona está allí.
  const docs = [...new Set(page.map((r) => r.person_tax_id).filter((d): d is string => Boolean(d)))];
  const names = new Map<string, string>();
  if (docs.length) {
    const { data: emp, error: empError } = await db
      .from('employees')
      .select('full_name, document_number')
      .in('document_number', docs);
    if (!empError)
      for (const e of (emp ?? []) as Array<{ full_name: string; document_number: string }>)
        names.set(e.document_number.replace(/\D/g, ''), e.full_name);
  }
  const lines: PayrollMovementLine[] = page.map((r) => ({
    journal: r.journal_name,
    date: r.journal_date,
    account: r.account_code,
    concept: r.concept,
    group: r.concept_group,
    movement: r.movement,
    amount: Number(r.amount),
    personTaxId: r.person_tax_id,
    personName: r.person_name ?? (r.person_tax_id ? (names.get(r.person_tax_id) ?? null) : null),
    description: r.description,
  }));
  await auditPayrollRead(db, {
    userId: opts.viewerId,
    allowed: true,
    what: 'movimientos de nómina con tercero',
    period: opts.period,
    lines: lines.length,
    people: docs.length,
  });
  return { allowed: true, lines, truncated };
}
