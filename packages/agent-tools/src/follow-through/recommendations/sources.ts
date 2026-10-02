import type { ForecastAlert } from '../../ledger/types';
import type { ManagementCase } from '../../management/shape';
import { pluralType } from '../../work/metrics';
import type { TeamWorkReport, WorkPerson } from '../../work/types';
import { type RecommendationDraft, subjectKeyOf } from './shape';

/**
 * DE CADA FUENTE A UNA RECOMENDACIÓN CON SUJETO.
 *
 * Las fuentes ya dicen sus consejos en español (las señales del equipo, las
 * alertas de la caja, el próximo paso de un asunto). Esto no los reescribe: les
 * pone tipo, sujeto, efecto esperado y las cifras del momento, que es lo que
 * hace falta para preguntar después «¿se hizo? ¿y qué pasó?». Puro.
 *
 * Sólo entra lo que pide atención: una señal informativa («Andrés va más
 * rápido que su semana pasada») es un reconocimiento, no un consejo, y medir si
 * «se siguió» no tiene sentido.
 */

function nameOf(people: readonly WorkPerson[], id: string | null | undefined): string | null {
  if (!id) return null;
  return people.find((p) => p.id === id)?.name ?? null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Las señales del equipo que piden hacer algo (warn o critical). */
export function draftsFromWorkSignals(report: TeamWorkReport): RecommendationDraft[] {
  const people = report.people.map((p) => p.person);
  const out: RecommendationDraft[] = [];
  for (const s of report.signals) {
    if (s.severity === 'info') continue;
    const e = s.evidence ?? {};
    const text = (s.suggestion?.trim() || s.message).slice(0, 600);
    const name = nameOf(people, s.personId) ?? (typeof e.person === 'string' ? e.person : null);
    switch (s.kind) {
      case 'overloaded':
        if (!s.personId || !name) continue;
        out.push({
          source: 'work_signals',
          kind: 'rebalance_person',
          subjectKind: 'person',
          subjectKey: s.personId,
          subjectLabel: name,
          text,
          headline: s.workType
            ? `repartir los ${pluralType(s.workType)} de ${name}`
            : `repartir la carga de ${name}`,
          suggestedAction: null,
          severity: s.severity,
          baseline: {
            workType: s.workType ?? null,
            open: num(e.openNow),
            overdue: num(e.overdueNow),
          },
        });
        break;
      case 'overdue_pile':
        if (!s.personId || !name) continue;
        out.push({
          source: 'work_signals',
          kind: 'clear_overdue_person',
          subjectKind: 'person',
          subjectKey: s.personId,
          subjectLabel: name,
          text,
          headline: `sacar los vencidos de ${name}`,
          suggestedAction: null,
          severity: s.severity,
          baseline: { workType: null, open: num(e.openNow), overdue: num(e.overdueNow) },
        });
        break;
      case 'unassigned_pile': {
        const type = typeof e.workType === 'string' ? e.workType : (s.workType ?? null);
        out.push({
          source: 'work_signals',
          kind: 'assign_unassigned',
          subjectKind: 'company',
          subjectKey: type ? subjectKeyOf(type) || 'sin-tipo' : 'todo',
          subjectLabel: type,
          text,
          headline: type
            ? `asignar los ${pluralType(type)} sin responsable`
            : 'asignar lo que no tiene responsable',
          suggestedAction: null,
          severity: s.severity,
          baseline: { workType: type, count: num(e.unassigned) },
        });
        break;
      }
      case 'stale_item': {
        const first = s.itemIds?.[0];
        const title = typeof e.item1 === 'string' ? e.item1 : null;
        if (!first || !title) continue;
        out.push({
          source: 'work_signals',
          kind: 'revive_stale',
          subjectKind: 'item',
          subjectKey: first,
          subjectLabel: title,
          text,
          headline: `mover «${title.slice(0, 80)}», que estaba quieto`,
          suggestedAction: null,
          severity: s.severity,
          baseline: { workType: s.workType ?? null, stale: num(e.stale) },
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** La caja: en rojo, bajo el mínimo, o un cliente que paga tarde. */
export function draftsFromForecastAlerts(
  alerts: readonly ForecastAlert[],
  opts: { createdFor?: string | null } = {},
): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];
  for (const a of alerts) {
    if (a.severity === 'info') continue;
    if (a.kind === 'negative_cash' || a.kind === 'low_cash') {
      out.push({
        source: 'forecast',
        kind: 'cash_alert',
        subjectKind: 'company',
        subjectKey: a.kind,
        subjectLabel: null,
        text: a.message,
        headline:
          a.kind === 'negative_cash'
            ? 'mirar la caja, que se iba a quedar en rojo'
            : 'mirar la caja, que iba a bajar del mínimo',
        suggestedAction: { toolId: 'ledger.forecast', input: {} },
        severity: a.severity,
        baseline: { alertKind: a.kind, week: a.week ?? null },
        createdFor: opts.createdFor ?? null,
      });
    } else if (a.kind === 'late_payer' && a.counterpartyName) {
      out.push({
        source: 'forecast',
        kind: 'collect_counterparty',
        subjectKind: 'counterparty',
        subjectKey: subjectKeyOf(a.counterpartyName),
        subjectLabel: a.counterpartyName,
        text: a.message,
        headline: `cobrarle a tiempo a ${a.counterpartyName}`,
        suggestedAction: null,
        severity: a.severity,
        baseline: {},
        createdFor: opts.createdFor ?? null,
      });
    }
  }
  return out.filter((d) => d.subjectKey);
}

/**
 * Gerencia: los asuntos que hoy piden moverse (plazo vencido o revisión que
 * llegó) con el próximo paso que escribió la propia empresa. Uno por asunto y
 * semana.
 */
export function draftsFromManagementCases(
  cases: readonly ManagementCase[],
  today: string,
  limit = 20,
): RecommendationDraft[] {
  return cases
    .filter((c) => {
      const d = c.data;
      if (!['open', 'working', 'blocked'].includes(d.state)) return false;
      return d.dueOn < today || d.nextReviewOn <= today;
    })
    .sort((a, b) => a.data.dueOn.localeCompare(b.data.dueOn) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((c) => ({
      source: 'management' as const,
      kind: 'management_case' as const,
      subjectKind: 'item' as const,
      subjectKey: c.id,
      subjectLabel: c.data.title,
      text: `«${c.data.title}»: ${c.data.nextAction}`.slice(0, 600),
      headline: `mover «${c.data.title.slice(0, 80)}» en Gerencia`,
      suggestedAction: null,
      severity: (c.data.dueOn < today && c.data.impact === 'high' ? 'critical' : 'warn') as
        | 'critical'
        | 'warn',
      baseline: { revision: (c as { revision?: number }).revision ?? null, state: c.data.state },
      createdFor: c.data.ownerId,
    }));
}

/**
 * El pulso de cada mañana: «Para hoy: quien más debe: Nexa…». Es la misma
 * recomendación que la revisión del lunes («cóbrale primero a Nexa»), así que
 * comparte su identidad (tipo, sujeto, semana): dicha por los dos lados queda
 * una sola fila, la primera.
 */
export function draftsFromPulseFacts(
  facts: ReadonlyArray<{ key: string; value: number | null; display: string }>,
  opts: { createdFor?: string | null } = {},
): RecommendationDraft[] {
  const overdue = facts.find((f) => f.key === 'cartera_vencida');
  const top = facts.find((f) => f.key === 'top_deudores.0');
  if (!overdue || (overdue.value ?? 0) <= 0 || !top) return [];
  const cells = top.display.split(' · ').map((c) => c.trim());
  const name = cells[0];
  const owes = cells[cells.length - 1];
  if (!name || name === '—' || cells.length < 2) return [];
  const key = subjectKeyOf(name);
  if (!key) return [];
  return [
    {
      source: 'pulse',
      kind: 'collect_counterparty',
      subjectKind: 'counterparty',
      subjectKey: key,
      subjectLabel: name,
      text: `Quien más debe: ${top.display}. Cartera vencida: ${overdue.display}.`,
      headline: `cobrarle primero a ${name}`,
      suggestedAction: null,
      severity: 'warn',
      baseline: { owes: owes ?? null, overdue: overdue.value },
      createdFor: opts.createdFor ?? null,
    },
  ];
}
