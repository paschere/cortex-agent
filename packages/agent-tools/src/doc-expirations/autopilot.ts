import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { daysBetween } from '../commitments/shape';
import { EXPIRATION_KIND_LABEL, deriveExpirationStatus } from './kinds';
import { listExpirations } from './store';

/**
 * Lo que el piloto automático (0176) mira de los documentos que vencen.
 *
 * Los AVISOS DE RENOVACIÓN no salen de aquí: un papel confirmado ya tiene su
 * vencimiento en `commitments`, y de ahí los dan el vigilante diario (a
 * `renewal_lead_days`), el recolector de vencimientos del piloto (dos días
 * antes) y el resumen diario de vencidos. Repetirlos aquí sería el ruido que
 * enseña a no abrir la campana.
 *
 * Lo que SÓLO este módulo sabe, y por eso se recolecta aquí:
 *
 *   1. REMIND — a quien subió (o responde por) documentos cuya fecha leída
 *      espera confirmación: mientras nadie la confirme, nadie la vigila. Uno
 *      por persona, y la clave cambia sólo cuando llega un documento nuevo,
 *      así que no se repite cada mañana.
 *   2. TELL — al dueño, los papeles VENCIDOS sin renovación cargada, en una
 *      línea con el más viejo; y los que esperan confirmación sin nadie a
 *      quien recordárselo.
 *
 * Todo con reglas y cifras; ningún texto lo escribe un modelo.
 */

export interface SnapshotExpiration {
  id: string;
  title: string;
  kind: string;
  expiresOn: string | null;
  status: string;
  needsReview: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: string;
}

const HREF = '/documentos-vencen';
const REVIEW_HREF = '/documentos-vencen?tab=revisar';
const CAP = 10;

/** La fotografía: lo abierto y lo que espera confirmación. */
export async function loadExpirationSnapshot(
  db: SupabaseClient,
  today: string,
  names: Map<string, string>,
): Promise<SnapshotExpiration[]> {
  const rows = await listExpirations(db, { limit: 500 });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    expiresOn: r.expires_on,
    status: deriveExpirationStatus(r, today),
    needsReview: r.needs_review,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_user_id ? (names.get(r.owner_user_id) ?? null) : null,
    createdAt: r.created_at,
  }));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function collectDocumentExpirations(
  items: SnapshotExpiration[] | undefined,
  today: string,
): PlanItem[] {
  const out: PlanItem[] = [];
  if (!items || items.length === 0) return out;

  // 1. Lo que espera confirmación, por persona.
  const pending = items.filter((e) => e.needsReview && e.status !== 'descartado');
  const byOwner = new Map<string, SnapshotExpiration[]>();
  const orphan: SnapshotExpiration[] = [];
  for (const e of pending) {
    if (!e.ownerUserId) {
      orphan.push(e);
      continue;
    }
    byOwner.set(e.ownerUserId, [...(byOwner.get(e.ownerUserId) ?? []), e]);
  }
  for (const [ownerId, list] of [...byOwner.entries()].slice(0, CAP)) {
    const sorted = list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const newest = sorted[0] as SnapshotExpiration;
    const names = sorted
      .slice(0, 3)
      .map((e) => `«${clip(e.title, 50)}»`)
      .join(', ');
    const why = `${plural(list.length, 'documento tiene', 'documentos tienen')} una fecha de vencimiento leída que nadie ha confirmado (${names}${list.length > 3 ? '…' : ''}). Sin confirmar, no se vigila ni avisa.`;
    const dedupeKey = `docvence:revisar:${ownerId}:${newest.id}`;
    out.push({
      area: 'vencimientos',
      title: `Recordarle a ${newest.ownerName ?? 'su responsable'} que confirme ${plural(list.length, 'vencimiento', 'vencimientos')}`,
      why,
      proposedAction: {
        toolId: 'autopilot.remind',
        input: {
          person: ownerId,
          title: clip(
            `Confirma ${plural(list.length, 'fecha de vencimiento', 'fechas de vencimiento')}`,
            160,
          ),
          body: clip(`${why} Revísalas en Documentos que vencen: un clic por documento.`, 600),
          href: REVIEW_HREF,
          key: dedupeKey,
        },
      },
      effect: 'internal_notice',
      risk: 'low',
      dedupeKey,
      href: REVIEW_HREF,
    });
  }
  if (orphan.length > 0) {
    out.push({
      area: 'vencimientos',
      title: `${plural(orphan.length, 'vencimiento leído', 'vencimientos leídos')} sin responsable por confirmar`,
      why: `${plural(orphan.length, 'documento', 'documentos')} con fecha de vencimiento leída no ${orphan.length === 1 ? 'tiene' : 'tienen'} a nadie que lo confirme (p. ej. «${clip((orphan[0] as SnapshotExpiration).title, 60)}»). Asígnalos o confírmalos en Documentos que vencen.`,
      proposedAction: null,
      effect: null,
      risk: 'medium',
      dedupeKey: `docvence:huerfanos:${today}`,
      href: REVIEW_HREF,
    });
  }

  // 2. Vencidos sin renovación, en una línea.
  const lapsed = items
    .filter((e) => !e.needsReview && e.status === 'vencido' && e.expiresOn)
    .map((e) => ({ e, left: daysBetween(today, e.expiresOn as string) }))
    .sort((a, b) => a.left - b.left);
  if (lapsed.length > 0) {
    const oldest = lapsed[0] as { e: SnapshotExpiration; left: number };
    out.push({
      area: 'vencimientos',
      title: `${plural(lapsed.length, 'documento vencido', 'documentos vencidos')} sin renovación cargada`,
      why: `${plural(lapsed.length, 'papel venció', 'papeles vencieron')} y no ha llegado su renovación; el más viejo es «${clip(oldest.e.title, 70)}» (${EXPIRATION_KIND_LABEL[oldest.e.kind as keyof typeof EXPIRATION_KIND_LABEL] ?? oldest.e.kind}), vencido hace ${plural(-oldest.left, 'día', 'días')}. Al subir el documento renovado, el aviso se cierra solo.`,
      proposedAction: null,
      effect: null,
      risk: 'medium',
      dedupeKey: `docvence:vencidos:${today}`,
      href: HREF,
    });
  }
  return out;
}
