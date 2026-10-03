import { ForbiddenError, NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import {
  createCommitment,
  dropCommitment,
  isUniqueViolation,
  markMet,
  rescheduleCommitment,
} from '../commitments/store';
import { supportedYears } from './calendar-co';
import { generateObligations } from './engine';
import {
  type GeneratedObligation,
  OBLIGATION_STATUS_LABEL,
  type ObligationStatus,
  type TaxObligation,
  type TaxProfile,
  isFulfilled,
} from './shape';
import {
  type MarkObligationInput,
  type ObligationRow,
  TAX_OBLIGATION_COLUMNS,
  canMarkTaxObligations,
  listTaxObligations,
  readTaxProfile,
  rowToObligation,
  updateObligationStatus,
} from './store';

/**
 * DEL PERFIL A LAS FECHAS, Y DE LAS FECHAS A LOS VENCIMIENTOS.
 *
 * `syncTaxCalendar` es idempotente: correrlo dos veces seguidas no cambia nada
 * la segunda. Lo llaman guardar el perfil (pantalla y `tax.configure`), abrir
 * /impuestos y `tax.calendar` cuando el calendario guardado es de otra versión
 * de las reglas.
 *
 * Tres reglas, en este orden de importancia:
 *
 *   1. LO QUE UNA PERSONA YA MARCÓ NO SE TOCA. Una obligación presentada,
 *      pagada o marcada «no aplica» es historia, aunque las reglas cambien.
 *   2. CAMBIAR EL PERFIL REGENERA SÓLO LO FUTURO Y PENDIENTE. Lo pendiente con
 *      fecha pasada se queda (es un vencido real, o algo que alguien tiene que
 *      marcar); lo pendiente futuro que ya no aplica se borra y su vencimiento
 *      se descarta con el motivo.
 *   3. CADA OBLIGACIÓN PENDIENTE CON FECHA FUTURA TIENE SU VENCIMIENTO en
 *      `commitments`, con el responsable y los días de aviso del perfil. El
 *      vigilante de siempre (avisos, escalamiento, resumen diario, piloto) se
 *      encarga del resto: no hay un segundo vigilante para impuestos.
 *
 * La decisión (qué insertar, qué actualizar, qué borrar) es pura
 * (`planTaxSync`) y está probada aparte; aquí sólo se ejecuta.
 */

/** Lo que dice el vencimiento sobre su origen (`commitments.source_system`, ≤ 60). */
export const TAX_SOURCE_SYSTEM = 'Calendario tributario';

// ---------------------------------------------------------------------------
// La decisión, pura
// ---------------------------------------------------------------------------

export interface TaxSyncPlan {
  insert: GeneratedObligation[];
  update: Array<{ id: string; next: GeneratedObligation }>;
  remove: TaxObligation[];
}

const COMPARED: Array<keyof GeneratedObligation> = [
  'dueDate',
  'title',
  'period',
  'authority',
  'form',
  'requiresPayment',
  'needsConfirmation',
  'ruleVersion',
  'sourceNote',
  'kind',
];

export function planTaxSync(input: {
  existing: TaxObligation[];
  generated: GeneratedObligation[];
  today: string;
  /** Años que el motor generó: fuera de ellos no se borra nada. */
  years: number[];
}): TaxSyncPlan {
  const byKey = new Map(input.existing.map((o) => [`${o.year}|${o.key}`, o]));
  const wanted = new Set(input.generated.map((g) => `${g.year}|${g.key}`));
  const plan: TaxSyncPlan = { insert: [], update: [], remove: [] };
  for (const g of input.generated) {
    const current = byKey.get(`${g.year}|${g.key}`);
    if (!current) {
      plan.insert.push(g);
      continue;
    }
    if (current.status !== 'pendiente') continue;
    if (COMPARED.some((k) => (current[k] ?? null) !== (g[k] ?? null)))
      plan.update.push({ id: current.id, next: g });
  }
  const years = new Set(input.years);
  for (const o of input.existing) {
    if (!years.has(o.year)) continue;
    if (o.status !== 'pendiente') continue;
    if (o.dueDate < input.today) continue;
    if (!wanted.has(`${o.year}|${o.key}`)) plan.remove.push(o);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// La ejecución
// ---------------------------------------------------------------------------

export interface TaxSyncResult {
  inserted: number;
  updated: number;
  removed: number;
  commitmentsCreated: number;
  commitmentsUpdated: number;
  commitmentsClosed: number;
  years: number[];
}

function toRow(g: GeneratedObligation) {
  return {
    year: g.year,
    obligation_key: g.key,
    kind: g.kind,
    period: g.period,
    title: g.title,
    authority: g.authority,
    form: g.form,
    due_date: g.dueDate,
    requires_payment: g.requiresPayment,
    needs_confirmation: g.needsConfirmation,
    rule_version: g.ruleVersion,
    source_note: g.sourceNote,
  };
}

/** El detalle del vencimiento: qué es, de dónde sale la fecha y si hay que confirmarla. */
export function commitmentDetail(o: GeneratedObligation): string {
  return [
    `${o.period}${o.form ? ` · formulario ${o.form}` : ''} · ${o.authority}.`,
    o.needsConfirmation
      ? 'Fecha por confirmar con tu contador: Cortex no pudo verificarla contra la norma.'
      : null,
    o.sourceNote ? `Fuente: ${o.sourceNote}.` : null,
    'Se marca presentada o pagada en Impuestos.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
}

interface CommitmentBrief {
  id: string;
  title: string;
  due_on: string;
  owner_user_id: string | null;
  notice_days: number;
  state: string;
}

async function readCommitments(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, CommitmentBrief>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db
    .from('commitments')
    .select('id, title, due_on, owner_user_id, notice_days, state')
    .in('id', ids);
  if (error) throw error;
  return new Map(((data ?? []) as CommitmentBrief[]).map((c) => [c.id, c]));
}

export async function syncTaxCalendar(
  db: SupabaseClient,
  opts: { userId: string; today?: string; profile?: TaxProfile | null },
): Promise<TaxSyncResult> {
  const today = opts.today ?? bogotaToday();
  const profile = opts.profile === undefined ? await readTaxProfile(db) : opts.profile;
  const thisYear = Number(today.slice(0, 4));
  // El año en curso y, si sus fechas ya están en el código, el siguiente.
  const years = supportedYears().filter((y) => y === thisYear || y === thisYear + 1);
  const result: TaxSyncResult = {
    inserted: 0,
    updated: 0,
    removed: 0,
    commitmentsCreated: 0,
    commitmentsUpdated: 0,
    commitmentsClosed: 0,
    years,
  };
  if (!profile) return result;

  const generated = years.flatMap((year) => generateObligations(profile, year));
  const existing = (
    await Promise.all(years.map((year) => listTaxObligations(db, { year, limit: 1000 })))
  ).flat();
  const plan = planTaxSync({ existing, generated, today, years });

  // 1. Borrar lo futuro que ya no aplica (su vencimiento se descarta abajo).
  for (const o of plan.remove) {
    if (o.commitmentId) {
      await dropCommitment(db, {
        id: o.commitmentId,
        reason: 'El perfil tributario cambió: esta obligación ya no aplica.',
        userId: opts.userId,
      }).catch(() => undefined);
      result.commitmentsClosed++;
    }
    const { error } = await db.from('tax_obligations').delete().eq('id', o.id);
    if (error) throw error;
    result.removed++;
  }

  // 2. Insertar lo nuevo. Upsert sobre la llave natural: dos sincronizaciones
  //    a la vez no duplican, la segunda se vuelve una actualización.
  if (plan.insert.length) {
    const { error } = await db.from('tax_obligations').upsert(plan.insert.map(toRow), {
      onConflict: 'organization_id,year,obligation_key',
      ignoreDuplicates: true,
    });
    if (error) throw error;
    result.inserted = plan.insert.length;
  }

  // 3. Actualizar lo pendiente cuya regla cambió.
  const now = new Date().toISOString();
  for (const u of plan.update) {
    const { error } = await db
      .from('tax_obligations')
      .update({ ...toRow(u.next), updated_at: now })
      .eq('id', u.id)
      .eq('status', 'pendiente');
    if (error) throw error;
    result.updated++;
  }

  // 4. Los vencimientos: uno por obligación pendiente con fecha de hoy en adelante.
  const rows = (
    await Promise.all(years.map((year) => listTaxObligations(db, { year, limit: 1000 })))
  ).flat();
  const commitments = await readCommitments(
    db,
    rows.map((r) => r.commitmentId).filter(Boolean) as string[],
  );
  for (const o of rows) {
    const c = o.commitmentId ? commitments.get(o.commitmentId) : undefined;
    if (o.status !== 'pendiente') {
      // Una obligación cerrada con su vencimiento abierto (marcada antes de
      // que existiera el vínculo, o un cierre que falló a medias).
      if (c && (c.state === 'in_force' || c.state === 'due_soon' || c.state === 'overdue')) {
        await closeCommitment(db, o, c.id, opts.userId);
        result.commitmentsClosed++;
      }
      continue;
    }
    if (o.dueDate < today) continue;
    const open = c && c.state !== 'met' && c.state !== 'dropped';
    if (!open) {
      const created = await createCommitmentFor(db, o, profile, opts.userId);
      if (created) result.commitmentsCreated++;
      continue;
    }
    let touched = false;
    if (c.due_on !== o.dueDate) {
      await rescheduleCommitment(db, { id: c.id, dueOn: o.dueDate, today });
      touched = true;
    }
    if (
      c.owner_user_id !== profile.ownerUserId ||
      c.notice_days !== profile.noticeDays ||
      c.title !== o.title
    ) {
      const { error } = await db
        .from('commitments')
        .update({
          owner_user_id: profile.ownerUserId,
          notice_days: profile.noticeDays,
          title: o.title,
          detail: commitmentDetail(o),
          updated_at: now,
        })
        .eq('id', c.id);
      if (error) throw error;
      touched = true;
    }
    if (touched) result.commitmentsUpdated++;
  }
  return result;
}

async function createCommitmentFor(
  db: SupabaseClient,
  o: TaxObligation,
  profile: TaxProfile,
  userId: string,
): Promise<boolean> {
  try {
    const row = await createCommitment(db, {
      title: o.title,
      detail: commitmentDetail(o),
      // `other` y no un tipo nuevo: la diferencia que importa (la ventana de
      // aviso y el responsable) ya viene del perfil, y un tipo nuevo en la
      // restricción de `commitments.kind` chocaría con cualquier otra
      // migración que la redefina.
      kind: 'other',
      dueOn: o.dueDate,
      noticeDays: profile.noticeDays,
      counterparty: o.authority,
      ownerUserId: profile.ownerUserId,
      // La fecha sale del calendario oficial, no la dijo una persona: fuente
      // de sistema. Eso además impide que «cumplido» invente la próxima
      // fecha sumando un periodo (commitments/store.ts `markMet`).
      source: { kind: 'system', system: TAX_SOURCE_SYSTEM, readAt: new Date().toISOString() },
      createdBy: userId,
    });
    const { error } = await db
      .from('tax_obligations')
      .update({ commitment_id: row.id, updated_at: new Date().toISOString() })
      .eq('id', o.id);
    if (error) throw error;
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function closeCommitment(
  db: SupabaseClient,
  o: Pick<TaxObligation, 'status' | 'requiresPayment' | 'statusNote'>,
  commitmentId: string,
  userId: string,
): Promise<void> {
  if (o.status === 'no_aplica') {
    await dropCommitment(db, {
      id: commitmentId,
      reason: o.statusNote?.trim() || 'Marcada «no aplica» en Impuestos.',
      userId,
    });
    return;
  }
  if (!isFulfilled(o.status, o.requiresPayment)) return;
  await markMet(db, {
    id: commitmentId,
    userId,
    note: `${OBLIGATION_STATUS_LABEL[o.status]} en Impuestos${o.statusNote ? `: ${o.statusNote}` : ''}`.slice(
      0,
      500,
    ),
  });
}

// ---------------------------------------------------------------------------
// Marcar una obligación
// ---------------------------------------------------------------------------

export interface MarkResult {
  obligation: TaxObligation;
  /** Qué pasó con su vencimiento, en una frase. */
  commitmentNote: string | null;
}

/**
 * Marca una obligación (pantalla y `tax.mark`) y cierra o reabre su
 * vencimiento. Puede hacerlo el responsable de los impuestos o quien
 * administra la empresa.
 */
export async function markTaxObligation(
  db: SupabaseClient,
  input: MarkObligationInput & { today?: string },
): Promise<MarkResult> {
  const profile = await readTaxProfile(db);
  if (!(await canMarkTaxObligations(db, input.userId, profile)))
    throw new ForbiddenError(
      'Sólo quien responde por los impuestos o quien administra la empresa puede marcar obligaciones.',
    );
  const obligation = await updateObligationStatus(db, input);
  const today = input.today ?? bogotaToday();
  let commitmentNote: string | null = null;
  const status: ObligationStatus = obligation.status;
  if (obligation.commitmentId && status !== 'pendiente') {
    const fulfilled = isFulfilled(status, obligation.requiresPayment);
    if (fulfilled) {
      await closeCommitment(db, obligation, obligation.commitmentId, input.userId);
      commitmentNote =
        status === 'no_aplica'
          ? 'Descarté su vencimiento: ya no se avisa.'
          : 'Cerré su vencimiento: ya no se avisa.';
    } else {
      commitmentNote =
        'Su vencimiento sigue abierto: se paga, así que se cierra cuando la marques pagada.';
    }
  }
  if (status === 'pendiente' && profile && obligation.dueDate >= today) {
    // Volver a pendiente reabre la vigilancia con un vencimiento nuevo: el
    // cerrado queda como historia de lo que se dijo.
    const brief = obligation.commitmentId
      ? (await readCommitments(db, [obligation.commitmentId])).get(obligation.commitmentId)
      : undefined;
    if (!brief || brief.state === 'met' || brief.state === 'dropped') {
      if (await createCommitmentFor(db, obligation, profile, input.userId))
        commitmentNote = 'La vuelvo a vigilar con un vencimiento nuevo.';
    }
  }
  const { data, error } = await db
    .from('tax_obligations')
    .select(TAX_OBLIGATION_COLUMNS)
    .eq('id', obligation.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa obligación ya no existe.');
  return { obligation: rowToObligation(data as ObligationRow), commitmentNote };
}
