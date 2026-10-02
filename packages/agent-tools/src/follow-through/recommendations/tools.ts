import { z } from 'zod';
import { bogotaToday } from '../../commitments/shape';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { kindStats, kindWeight } from './rank';
import { followUpSentence } from './report';
import {
  RECOMMENDATION_KIND_LABEL,
  RECOMMENDATION_OUTCOME_LABEL,
  RECOMMENDATION_SOURCE_LABEL,
  RECOMMENDATION_STATUS_LABEL,
  type RecommendationRecord,
  type RecommendationStatus,
} from './shape';
import { evaluateRecommendations, listRecommendations } from './store';

/**
 * `recommendations.list`: «¿QUÉ ME HAS RECOMENDADO Y QUÉ PASÓ?».
 *
 * Sólo lectura de cara a la persona. Antes de contestar se vuelve a juzgar lo
 * reciente (lo mismo que hace el barrido de cada mañana), para que la respuesta
 * no diga «todavía no se ve un pago» del pago que entró hace una hora. Eso
 * escribe sólo en `recommendations` —el libro de Cortex sobre sí mismo— y
 * nunca toca nada de la empresa.
 *
 * QUIÉN VE QUÉ. Lo que habla de una persona del equipo («repartir la carga de
 * Laura») sólo lo ven quien administra y esa persona: es la misma regla del
 * registro de trabajo. Lo que se recomendó a alguien en particular (lo que
 * espera SU aprobación) sólo lo ve esa persona. El resto es de la empresa.
 */

const STATUS_FILTER = ['all', 'followed', 'not_followed', 'in_progress', 'open'] as const;

function visibleTo(r: RecommendationRecord, viewerId: string, manager: boolean): boolean {
  if (r.createdFor && r.createdFor !== viewerId && r.kind === 'review_approvals') return false;
  if (r.subjectKind === 'person') return manager || r.subjectKey === viewerId;
  return true;
}

export const recommendationsList = registerTool({
  id: 'recommendations.list',
  description:
    "What Cortex recommended to this company and what happened after: each recommendation from the weekly review, the team work signals, the cash forecast alerts, the company pulse and Gerencia, with whether it was followed (with evidence: the collection email that went out, the reassignment, the routine that was changed) and the measured outcome afterwards (the client's payment within 30 days, the person's overdue count today vs then, the cash alert gone) — never claiming causality beyond «después de…». Also the hit rate per kind of recommendation (followed and good outcome), which Cortex uses to rank future recommendations. Use it for «¿qué me has recomendado y qué pasó?», «¿te hice caso?», «¿sirvieron tus recomendaciones?», «¿qué consejos funcionan aquí?». Read-only.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(7)
      .max(180)
      .default(60)
      .describe('How far back, in days. Default 60.'),
    status: z
      .enum(STATUS_FILTER)
      .default('all')
      .describe('Only followed, not followed, in progress or still open ones. Default all.'),
    limit: z.number().int().min(1).max(40).default(15),
  }),
  outputSchema: z.object({
    today: z.string(),
    items: z.array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        source: z.string(),
        kind: z.string(),
        kindLabel: z.string(),
        subject: z.string().nullable(),
        text: z.string(),
        status: z.string(),
        statusLabel: z.string(),
        outcome: z.string().nullable(),
        outcomeLabel: z.string().nullable(),
        story: z.string().nullable(),
      }),
    ),
    byKind: z.array(
      z.object({
        kind: z.string(),
        label: z.string(),
        evaluated: z.number(),
        followed: z.number(),
        hits: z.number(),
        weight: z.number(),
      }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const now = new Date();
    const today = bogotaToday(now);
    // Juzgar de nuevo antes de contestar. Si falla, se contesta con lo que hay.
    await evaluateRecommendations(ctx.db, { now }).catch(() => undefined);
    const since = new Date(now.getTime() - (input.days ?? 60) * 86_400_000).toISOString();
    const [all, manager] = await Promise.all([
      listRecommendations(ctx.db, { since, limit: 1000 }),
      isCompanyManager(ctx.db, ctx.userId).catch(() => false),
    ]);
    const visible = all.filter((r) => visibleTo(r, ctx.userId, manager));
    const wanted: RecommendationStatus | null =
      input.status && input.status !== 'all' ? input.status : null;
    const chosen = visible
      .filter((r) => !wanted || r.status === wanted)
      .slice(0, input.limit ?? 15);

    const stats = kindStats(visible);
    const byKind = [...stats.values()]
      .sort((a, b) => b.evaluated - a.evaluated || a.kind.localeCompare(b.kind))
      .map((s) => ({
        kind: s.kind,
        label: RECOMMENDATION_KIND_LABEL[s.kind] ?? s.kind,
        evaluated: s.evaluated,
        followed: s.followed,
        hits: s.hits,
        weight: kindWeight(s),
      }));

    const items = chosen.map((r) => {
      const story = followUpSentence(r, today)?.text ?? null;
      return {
        id: r.id,
        createdAt: r.createdAt,
        source: RECOMMENDATION_SOURCE_LABEL[r.source] ?? r.source,
        kind: r.kind,
        kindLabel: RECOMMENDATION_KIND_LABEL[r.kind] ?? r.kind,
        subject: r.subjectLabel,
        text: r.text,
        status: r.status,
        statusLabel: RECOMMENDATION_STATUS_LABEL[r.status] ?? r.status,
        outcome: r.outcome,
        outcomeLabel: r.outcome ? (RECOMMENDATION_OUTCOME_LABEL[r.outcome] ?? r.outcome) : null,
        story,
      };
    });

    const lines = items.map(
      (i) =>
        `- ${i.story ?? `${i.text} — ${i.statusLabel.toLowerCase()}${i.outcomeLabel ? `, ${i.outcomeLabel.toLowerCase()}` : ''}.`} _(${i.source})_`,
    );
    const rates = byKind
      .filter((k) => k.evaluated >= 3)
      .map(
        (k) =>
          `- ${k.label}: ${k.followed} de ${k.evaluated} seguidas, ${k.hits} con buen resultado después.`,
      );
    const markdown = [
      items.length
        ? `**Lo que te recomendé (últimos ${input.days ?? 60} días)**\n${lines.join('\n')}`
        : 'Todavía no tengo recomendaciones guardadas en ese período: empiezan a quedar con la revisión semanal, las señales del equipo y las alertas de la caja.',
      rates.length ? `**Qué tipo de consejo funciona aquí**\n${rates.join('\n')}` : '',
      'Lo que pasó después se mide (pagos en el libro, vencidos en el registro de trabajo, alertas de la caja), pero no prueba que haya pasado por la recomendación.',
    ]
      .filter(Boolean)
      .join('\n\n');

    return { today, items, byKind, markdown };
  },
});
