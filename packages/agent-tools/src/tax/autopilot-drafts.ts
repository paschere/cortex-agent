import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { addDays, daysBetween, plural } from '../commitments/shape';
import {
  DRAFTABLE_OBLIGATION_KINDS,
  DRAFT_KIND_LABEL,
  type DraftKind,
  type DraftStatus,
} from './draft-shape';
import { draftStatusByObligation } from './draft-store';
import { draftTargetFor } from './drafts';
import { listTaxObligations, readTaxProfile } from './store';

/**
 * EL PILOTO Y LOS BORRADORES (0197): una semana antes de una declaración que
 * Cortex sabe armar (IVA, retención, ICA, anticipo del Simple, renta), le
 * CUENTA al dueño que el borrador está listo para que el contador lo revise.
 * Sólo cuenta (sin acción): el borrador se arma al abrirlo, con los datos de
 * ese momento, y nunca se presenta nada.
 *
 * No repite lo que ya está revisado o presentado, ni lo que el recordatorio de
 * impuestos (collectImpuestos, ≤ 5 días) ya cubre.
 */

export interface SnapshotTaxDraft {
  obligationId: string;
  kind: DraftKind;
  title: string;
  dueOn: string;
  /** El periodo ya cerró (no tiene sentido revisar un mes que no ha terminado). */
  periodClosed: boolean;
  draftStatus: DraftStatus | null;
  ownerName: string | null;
}

/** Desde cuántos días antes se cuenta. */
export const DRAFT_TELL_DAYS = 7;
/** Hasta cuántos: desde aquí ya avisa collectImpuestos. */
export const DRAFT_TELL_UNTIL = 5;

export function collectBorradores(rows: SnapshotTaxDraft[] | undefined, today: string): PlanItem[] {
  const out: PlanItem[] = [];
  for (const r of rows ?? []) {
    const left = daysBetween(today, r.dueOn);
    if (!Number.isFinite(left) || left > DRAFT_TELL_DAYS || left <= DRAFT_TELL_UNTIL) continue;
    if (!r.periodClosed) continue;
    if (r.draftStatus === 'revisado' || r.draftStatus === 'presentado') continue;
    const what = DRAFT_KIND_LABEL[r.kind].replace(' (estimado)', '');
    out.push({
      area: 'vencimientos',
      title: `Borrador de ${what} listo para revisión del contador`,
      why: `«${r.title}» vence en ${plural(left, 'día')}. El borrador sale de las facturas de venta y de compra del periodo, con el detalle de cada cifra y lo que falta; ${r.ownerName ? `pásaselo a ${r.ownerName}` : 'pásaselo a tu contador'} para que lo revise y lo presente. Cortex no presenta nada ante la DIAN.`,
      proposedAction: null,
      effect: null,
      risk: 'low',
      counterparty: 'DIAN',
      dedupeKey: `borrador:${r.obligationId}`,
      href: `/impuestos/borrador/${r.obligationId}`,
    });
  }
  return out.slice(0, 5);
}

/** Lo que el piloto lee: las declaraciones con borrador que vencen en la ventana. */
export async function loadTaxDraftsSnapshot(
  db: SupabaseClient,
  today: string,
  names: Map<string, string>,
): Promise<SnapshotTaxDraft[]> {
  const profile = await readTaxProfile(db);
  if (!profile) return [];
  const rows = await listTaxObligations(db, {
    from: addDays(today, DRAFT_TELL_UNTIL + 1),
    to: addDays(today, DRAFT_TELL_DAYS),
    statuses: ['pendiente'],
    kinds: [...DRAFTABLE_OBLIGATION_KINDS],
    limit: 30,
  });
  const withTarget = rows.map((o) => ({ o, t: draftTargetFor(o) })).filter((x) => x.t !== null);
  if (!withTarget.length) return [];
  const statuses = await draftStatusByObligation(
    db,
    withTarget.map((x) => x.o.id),
  );
  const owner = profile.ownerUserId ? (names.get(profile.ownerUserId) ?? null) : null;
  return withTarget.map(({ o, t }) => ({
    obligationId: o.id,
    kind: t?.kind as DraftKind,
    title: o.title,
    dueOn: o.dueDate,
    periodClosed: (t?.period.to ?? today) < today,
    draftStatus: statuses.get(o.id) ?? null,
    ownerName: owner,
  }));
}
