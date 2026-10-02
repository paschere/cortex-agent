import 'server-only';
import type { ApprovalGroupItem } from '@/components/approvals/ApprovalGroup';
import { confirmationSummary, toolLabel } from '@/lib/tool-labels';
import {
  ACTION_KIND_LABEL,
  APPROVAL_DISCARD_AFTER_DAYS,
  type ActionRow,
  type PendingGroup,
  type PendingLike,
  batchApproveLabel,
  daysWaitingPhrase,
  groupPendingApprovals,
  pendingGroupTitle,
  waitingAgePhrase,
} from '@cortex/agent-tools';

/**
 * Las pantallas de /approvals y /actions arman aquí, en el servidor, los grupos
 * de pendientes parecidos que dibuja `ApprovalGroup`. La regla de qué se parece
 * vive en packages/agent-tools/src/follow-through/group.ts (pura, con pruebas);
 * esto sólo le pone a cada elemento la frase que ya usa su tarjeta.
 */

export interface GroupView {
  key: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  items: ApprovalGroupItem[];
  ids: string[];
}

function describeCall(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return confirmationSummary(toolId, record);
  } catch {
    return toolLabel(toolId).label;
  }
}

function subtitleFor(group: PendingGroup<PendingLike>, now: Date): string {
  const age = waitingAgePhrase(group.oldestAt, now);
  const held = group.heldBack.length;
  return [
    'Misma herramienta, mismo tipo, mismos campos. Esto es lo que hace cada uno; aprobar el lote es aprobar exactamente esta lista.',
    age ? `El más viejo ${age}.` : null,
    held
      ? `${held === 1 ? 'Uno queda' : `${held} quedan`} fuera del lote: ${held === 1 ? 'revísalo' : 'revísalos'} en su tarjeta.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** /approvals: llamadas paradas, con la repetición de 0168 ya vista. */
export function approvalGroups(
  rows: ReadonlyArray<{ id: string; tool_id: string; input: unknown; created_at: string }>,
  repeatOf: ReadonlyMap<string, string>,
  now = new Date(),
): { groups: GroupView[]; singleIds: string[] } {
  const items: Array<PendingLike & { line: string }> = rows.map((r) => ({
    id: r.id,
    toolId: r.tool_id,
    input: r.input,
    createdAt: r.created_at,
    repeat: repeatOf.has(r.id),
    line: describeCall(r.tool_id, r.input),
  }));
  const { groups, singles } = groupPendingApprovals(items);
  return {
    groups: groups.map((g) => ({
      key: g.key,
      title: pendingGroupTitle(g),
      subtitle: subtitleFor(g, now),
      actionLabel: batchApproveLabel(g),
      ids: g.items.map((i) => i.id),
      items: g.items.map((i) => ({
        id: i.id,
        line: i.line,
        heldBack: i.repeat
          ? 'repite algo que ya se hizo'
          : g.batchable.some((b) => b.id === i.id)
            ? null
            : 'no cupo en este lote',
      })),
    })),
    singleIds: singles.map((s) => s.id),
  };
}

function actionLine(row: ActionRow): string {
  return `${ACTION_KIND_LABEL[row.kind] ?? 'Correo'} a ${row.recipient}`;
}

function actionDetail(row: ActionRow, now: Date): string {
  return [`«${row.subject}»`, waitingAgePhrase(row.created_at, now)].filter(Boolean).join(' · ');
}

/** ¿Lleva tanto esperando que conviene preguntar «¿lo descarto?»? */
export function isStaleProposal(row: Pick<ActionRow, 'created_at'>, now = new Date()): boolean {
  const created = Date.parse(row.created_at);
  return (
    Number.isFinite(created) && now.getTime() - created >= APPROVAL_DISCARD_AFTER_DAYS * 86_400_000
  );
}

/** /actions: los borradores parecidos, y aparte los que ya llevan días. */
export function actionGroups(
  rows: readonly ActionRow[],
  now = new Date(),
): { stale: GroupView | null; groups: GroupView[]; singleIds: string[] } {
  const staleRows = rows.filter((r) => isStaleProposal(r, now));
  const freshRows = rows.filter((r) => !isStaleProposal(r, now));

  const stale: GroupView | null = staleRows.length
    ? {
        key: 'viejos',
        title:
          staleRows.length === 1
            ? 'Un borrador lleva más de cinco días esperando. ¿Lo descarto?'
            : `${staleRows.length} borradores llevan más de cinco días esperando. ¿Los descarto?`,
        subtitle: `Las cifras que traen se están quedando viejas y a los siete días vencen solos. Descartarlos no envía nada; si alguno sigue valiendo, apruébalo en su tarjeta. El más viejo lleva ${daysWaitingPhrase(
          Math.max(...staleRows.map((r) => (now.getTime() - Date.parse(r.created_at)) / 3_600_000)),
        )}.`,
        actionLabel: staleRows.length === 1 ? 'Descartarlo' : `Descartar los ${staleRows.length}`,
        ids: staleRows.map((r) => r.id),
        items: staleRows.map((r) => ({
          id: r.id,
          line: actionLine(r),
          detail: actionDetail(r, now),
        })),
      }
    : null;

  const byId = new Map(freshRows.map((r) => [r.id, r]));
  const { groups, singles } = groupPendingApprovals(
    freshRows.map((r) => ({
      id: r.id,
      toolId: r.tool_id,
      kind: r.kind,
      input: r.tool_input,
      createdAt: r.created_at,
    })),
  );
  return {
    stale,
    groups: groups.map((g) => ({
      key: g.key,
      title: pendingGroupTitle(g),
      subtitle: subtitleFor(g, now),
      actionLabel: batchApproveLabel(g),
      ids: g.items.map((i) => i.id),
      items: g.items.map((i) => {
        const row = byId.get(i.id) as ActionRow;
        return {
          id: i.id,
          line: actionLine(row),
          detail: actionDetail(row, now),
          contentHash: row.content_hash,
          heldBack: g.batchable.some((b) => b.id === i.id) ? null : 'no cupo en este lote',
        };
      }),
    })),
    singleIds: singles.map((s) => s.id),
  };
}
