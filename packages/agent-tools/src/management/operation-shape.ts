import { z } from 'zod';
import { type ManagementCase, managementDate, managementLink, managementPriority } from './shape';
const text = (max: number) => z.string().trim().min(10).max(max);
export const operationPlanSchema = z
  .object({
    notifyInApp: z.boolean().default(false),
    name: z.string().trim().min(3).max(120),
    outcome: text(1500),
    measurement: text(1000),
    baseline: text(1000),
    target: text(1000),
    boundaries: text(1500),
    source: text(1500),
    ownerId: z.string().uuid(),
    startOn: managementDate,
    goalId: z.string().uuid().nullable(),
    caseIds: z.array(z.string().uuid()).min(1).max(30),
  })
  .refine((p) => new Set(p.caseIds).size === p.caseIds.length, 'No repitas asuntos.');
export type OperationPlan = z.infer<typeof operationPlanSchema>;
export type Operation = {
  id: string;
  data: OperationPlan;
  state: 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  created_at: string;
  updated_at: string;
};
export const decisionSchema = z.object({
  question: text(1000),
  options: z
    .array(z.object({ label: z.string().trim().min(3).max(180), consequence: text(1000) }))
    .min(2)
    .max(4),
  evidence: managementLink,
  uncertainty: text(1000),
  dueOn: managementDate,
});
export const checkpointSchema = z.object({
  day: z.union([z.literal(7), z.literal(14), z.literal(21), z.literal(30)]),
  measurement: text(1000),
  observation: text(1500),
  evidence: managementLink,
  nextAction: text(1000),
  lesson: text(1500),
});
export type OperationEvent = {
  id: string;
  revision: number;
  actor_id: string;
  kind: string;
  data: OperationCommand & { caseRevisionAfter?: number };
  created_at: string;
};
export const operationCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), plan: operationPlanSchema }),
  z.object({ kind: z.literal('pause'), note: text(1000) }),
  z.object({ kind: z.literal('cancel'), note: text(1000) }),
  z.object({ kind: z.literal('resume'), note: text(1000) }),
  z.object({ kind: z.literal('complete'), note: text(1500) }),
  z.object({ kind: z.literal('decision'), decision: decisionSchema }),
  z.object({
    kind: z.literal('resolve'),
    decisionId: z.string().uuid(),
    option: z.number().int().min(0).max(3),
    note: text(1500),
  }),
  z.object({ kind: z.literal('checkpoint'), checkpoint: checkpointSchema }),
  z.object({
    kind: z.literal('progress'),
    caseId: z.string().uuid(),
    caseRevision: z.number().int().min(1),
    status: z.enum(['accepted', 'progress', 'blocked']),
    note: text(1000),
    nextReviewOn: managementDate,
  }),
]);
export type OperationCommand = z.infer<typeof operationCommandSchema>;
export function operationDay(startOn: string, today: string) {
  return (
    Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${startOn}T12:00:00Z`)) / 86400000) +
    1
  );
}
export function operationInbox(
  cases: ManagementCase[],
  userId: string,
  today: string,
  isAdmin: boolean,
) {
  const sorted = [...cases].sort(
    (a, b) =>
      managementPriority(b, today, cases).score - managementPriority(a, today, cases).score ||
      a.id.localeCompare(b.id),
  );
  return {
    decisions: sorted.filter((c) => c.data.state === 'review' && isAdmin),
    blocked: sorted.filter(
      (c) =>
        !['verified', 'cancelled'].includes(c.data.state) &&
        (c.data.state === 'blocked' ||
          !c.data.ownerId ||
          !!(
            c.data.dependsOn &&
            !cases.some((d) => d.id === c.data.dependsOn && d.data.state === 'verified')
          )),
    ),
    mine: sorted.filter(
      (c) => c.data.ownerId === userId && ['open', 'working'].includes(c.data.state),
    ),
    working: sorted.filter((c) => ['open', 'working', 'review'].includes(c.data.state)),
    verified: sorted.filter((c) => c.data.state === 'verified'),
  };
}
