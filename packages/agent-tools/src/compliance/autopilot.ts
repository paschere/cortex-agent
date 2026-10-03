import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { addDays, daysBetween } from '../commitments/shape';
import { isItemOverdue, pqrsDeadline } from './ops';
import { deadlinePhrase } from './pqrs';
import { PQRS_KIND_LABEL, PQRS_OPEN, type PqrsKind } from './shape';
import { listComplianceItems, listPqrs } from './store';

/**
 * Lo que el piloto automático (0176) mira de cumplimiento.
 *
 *   PQRS POR VENCER (pregunta): a 3 días hábiles o menos del plazo legal, o
 *     vencidas. Propone recordárselo a quien la tiene asignada, con riesgo
 *     alto: un plazo legal que se pasa no lo decide una rutina sola, así que
 *     siempre queda para que el dueño lo apruebe. Sin responsable, sólo se
 *     cuenta.
 *   OBLIGACIONES DE LA LISTA POR VENCER (cuenta): lo que vence en 15 días o
 *     venció hace menos de 30, una línea por cosa.
 *
 * Todo con reglas y cifras; ningún texto lo escribe un modelo.
 */

export interface SnapshotComplianceItem {
  id: string;
  title: string;
  dueOn: string;
  dueNeedsConfirmation: boolean;
  overdue: boolean;
  href: string;
}

export interface SnapshotPqrs {
  id: string;
  radicado: string;
  kind: string;
  subject: string;
  requester: string;
  due: string;
  left: number;
  assignedUserId: string | null;
  assignedName: string | null;
}

export interface ComplianceAutopilotSnapshot {
  items: SnapshotComplianceItem[];
  pqrs: SnapshotPqrs[];
}

export const COMPLIANCE_WINDOW_DAYS = 15;
export const PQRS_ASK_WITHIN_BUSINESS_DAYS = 3;

export async function loadComplianceSnapshot(
  db: SupabaseClient,
  today: string,
  names: Map<string, string>,
): Promise<ComplianceAutopilotSnapshot> {
  const [items, pqrs] = await Promise.all([
    listComplianceItems(db, { statuses: ['pendiente', 'en_curso'], limit: 1000 }),
    listPqrs(db, { statuses: [...PQRS_OPEN], limit: 500 }),
  ]);
  const horizon = addDays(today, COMPLIANCE_WINDOW_DAYS);
  const floor = addDays(today, -30);
  return {
    items: items
      .filter((i) => i.applies !== 'no' && i.due_on && i.due_on <= horizon && i.due_on >= floor)
      .map((i) => ({
        id: i.id,
        title: i.title,
        dueOn: i.due_on as string,
        dueNeedsConfirmation: i.due_needs_confirmation,
        overdue: isItemOverdue(i, today),
        href:
          i.linked_href && !i.linked_href.startsWith('/cumplimiento')
            ? i.linked_href
            : '/cumplimiento',
      })),
    pqrs: pqrs
      .map((p) => {
        const d = pqrsDeadline(p, today);
        return {
          id: p.id,
          radicado: p.radicado,
          kind: p.kind,
          subject: p.subject,
          requester: p.requester_name,
          due: d.due,
          left: d.left,
          assignedUserId: p.assigned_user_id,
          assignedName: p.assigned_user_id ? (names.get(p.assigned_user_id) ?? null) : null,
        };
      })
      .filter((p) => p.left <= PQRS_ASK_WITHIN_BUSINESS_DAYS),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function collectPqrsDeadlines(
  snapshot: ComplianceAutopilotSnapshot | undefined,
): PlanItem[] {
  const out: PlanItem[] = [];
  const rows = (snapshot?.pqrs ?? []).slice().sort((a, b) => a.left - b.left);
  for (const p of rows.slice(0, 10)) {
    const phrase = deadlinePhrase(p.left).text;
    const label = PQRS_KIND_LABEL[p.kind as PqrsKind] ?? 'PQRS';
    const why = `${label} ${p.radicado} de ${clip(p.requester, 60)} («${clip(p.subject, 80)}»): ${phrase}, plazo legal ${p.due}. Responder tarde un derecho de petición tiene consecuencias: que no se pase.`;
    const dedupeKey = `pqrs:${p.id}:${p.due}`;
    const href = `/cumplimiento?tab=pqrs&pqrs=${p.id}`;
    if (!p.assignedUserId) {
      out.push({
        area: 'vencimientos',
        title: `${p.radicado} ${phrase} y nadie la tiene asignada`,
        why: `${why} Asígnala en Cumplimiento.`,
        proposedAction: null,
        effect: null,
        risk: 'high',
        counterparty: p.requester,
        dedupeKey,
        href,
      });
      continue;
    }
    out.push({
      area: 'vencimientos',
      title: `Recordarle a ${p.assignedName ?? 'su responsable'} la ${label.toLowerCase()} ${p.radicado} (${phrase})`,
      why,
      proposedAction: {
        toolId: 'autopilot.remind',
        input: {
          person: p.assignedUserId,
          title: clip(`${p.radicado}: ${phrase}`, 160),
          body: clip(
            `${why} Respóndela desde Cumplimiento → PQRS; si no alcanzas, avisa la ampliación antes de que venza.`,
            600,
          ),
          href,
          key: dedupeKey,
        },
      },
      effect: 'internal_notice',
      // Alto a propósito: el plazo es legal y el dueño decide.
      risk: 'high',
      counterparty: p.requester,
      dedupeKey,
      href,
    });
  }
  return out;
}

export function collectComplianceDue(
  snapshot: ComplianceAutopilotSnapshot | undefined,
  today: string,
): PlanItem[] {
  const out: PlanItem[] = [];
  const rows = (snapshot?.items ?? []).slice().sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  for (const i of rows.slice(0, 6)) {
    const left = daysBetween(today, i.dueOn);
    const when =
      left < 0
        ? `venció hace ${-left} ${left === -1 ? 'día' : 'días'}`
        : left === 0
          ? 'vence hoy'
          : `vence en ${left} ${left === 1 ? 'día' : 'días'}`;
    out.push({
      area: 'vencimientos',
      title: `${clip(i.title, 80)} ${when}`,
      why: `De la lista de cumplimiento: ${i.title}, ${when} (${i.dueOn}${i.dueNeedsConfirmation ? ', fecha por confirmar' : ''}). Al hacerlo, márcalo cumplido con su evidencia.`,
      proposedAction: null,
      effect: null,
      risk: i.overdue ? 'medium' : 'low',
      dedupeKey: `cumplimiento:${i.id}:${i.dueOn}`,
      href: i.href,
    });
  }
  return out;
}
