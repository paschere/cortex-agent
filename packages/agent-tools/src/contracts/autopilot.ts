import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { addDays, daysBetween } from '../commitments/shape';
import { contractTerm, deriveContractStatus, plural } from './shape';
import { listContracts } from './store';

/**
 * Lo que el piloto automático (0176) mira de los contratos: las VENTANAS DE
 * AVISO PREVIO. Sólo CUENTA («para que sepas»): decidir si se renueva un
 * contrato es del dueño, nunca de una rutina.
 *
 * El recordatorio al responsable dos días antes ya lo da el recolector de
 * vencimientos (el aviso previo es un compromiso, `notice_commitment_id`):
 * aquí se cuenta desde que se abre la ventana (15 días) hasta ese momento, y
 * los contratos que terminan sin renovación automática, por si hay que
 * prorrogarlos.
 */

export interface SnapshotContractNotice {
  id: string;
  title: string;
  counterparty: string | null;
  renewal: string;
  noticeDeadline: string | null;
  currentEnd: string | null;
  hasNoticeCommitment: boolean;
}

/** Cuántos días antes empieza a contarse. */
export const CONTRACT_NOTICE_WINDOW_DAYS = 15;
const CAP = 8;

export async function loadContractSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotContractNotice[]> {
  const rows = await listContracts(db, { statuses: ['firmado', 'vigente', 'vencido'], limit: 500 });
  const horizon = addDays(today, CONTRACT_NOTICE_WINDOW_DAYS);
  const out: SnapshotContractNotice[] = [];
  for (const r of rows) {
    if (deriveContractStatus(r, today) !== 'vigente') continue;
    const term = contractTerm(r, today);
    const notice = r.renewal !== 'ninguna' ? term.noticeDeadline : null;
    const noticeSoon = notice && notice >= today && notice <= horizon;
    const endSoon = r.renewal !== 'automatica' && term.currentEnd && term.currentEnd <= horizon;
    if (!noticeSoon && !endSoon) continue;
    out.push({
      id: r.id,
      title: r.title,
      counterparty: r.counterparty_name,
      renewal: r.renewal,
      noticeDeadline: noticeSoon ? notice : null,
      currentEnd: term.currentEnd,
      hasNoticeCommitment: !!r.notice_commitment_id,
    });
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function collectContractNotices(
  items: SnapshotContractNotice[] | undefined,
  today: string,
): PlanItem[] {
  const out: PlanItem[] = [];
  for (const c of (items ?? []).slice(0, CAP * 2)) {
    const href = `/contratos/${c.id}`;
    if (c.noticeDeadline) {
      const left = daysBetween(today, c.noticeDeadline);
      // A dos días o menos, el recordatorio al responsable sale del compromiso.
      if (left <= 2 && c.hasNoticeCommitment) continue;
      out.push({
        area: 'vencimientos',
        title: `Aviso de no renovación de «${clip(c.title, 60)}»: ${left === 0 ? 'hoy es el último día' : `quedan ${plural(left, 'día')}`}`,
        why: `${c.counterparty ? `El contrato con ${clip(c.counterparty, 60)}` : 'El contrato'} ${
          c.renewal === 'automatica' ? 'se renueva solo' : 'se puede prorrogar'
        } al terminar el ${c.currentEnd}. Si no quieres que siga, el aviso por escrito tiene que salir a más tardar el ${c.noticeDeadline}. Confirma el plazo y la forma de aviso en el contrato firmado; la carta de no prórroga se arma desde la ficha del contrato.`,
        proposedAction: null,
        effect: null,
        risk: 'medium',
        counterparty: c.counterparty,
        dedupeKey: `contrato:aviso:${c.id}:${c.noticeDeadline}`,
        href,
      });
    } else if (c.currentEnd) {
      const left = daysBetween(today, c.currentEnd);
      out.push({
        area: 'vencimientos',
        title: `«${clip(c.title, 60)}» termina ${left === 0 ? 'hoy' : `en ${plural(left, 'día')}`}`,
        why: `${c.counterparty ? `El contrato con ${clip(c.counterparty, 60)}` : 'El contrato'} termina el ${c.currentEnd} y no se renueva solo. Si la relación sigue, hace falta una prórroga u otrosí firmado; si termina, revisa qué queda por liquidar o entregar.`,
        proposedAction: null,
        effect: null,
        risk: 'low',
        counterparty: c.counterparty,
        dedupeKey: `contrato:fin:${c.id}:${c.currentEnd}`,
        href,
      });
    }
    if (out.length >= CAP) break;
  }
  return out;
}
