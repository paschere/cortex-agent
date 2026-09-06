import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const managementStates = [
  'open',
  'working',
  'blocked',
  'review',
  'verified',
  'cancelled',
] as const;
export type ManagementState = (typeof managementStates)[number];
export const managementStateLabels: Record<ManagementState, string> = {
  open: 'Por organizar',
  working: 'En gestión',
  blocked: 'Bloqueado',
  review: 'Por verificar',
  verified: 'Cerrado con evidencia',
  cancelled: 'Descartado',
};
export const managementDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
  }, 'La fecha no existe.');
export const managementLink = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    if (
      /^\/(commitments|goals|errands|actions|approvals|browser|payments|reports)(\/|\?|$)/.test(
        v,
      ) &&
      !v.includes('\\')
    )
      return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Usa una URL HTTPS o un enlace interno de trabajo.');
export const managementEvidenceSchema = z.object({
  reference: managementLink,
  observation: text(2000),
  observedOn: managementDate,
});
export const managementCaseSchema = z.object({
  title: text(180),
  objective: text(2000),
  successCriteria: text(2000),
  ownerId: z.string().uuid().nullable(),
  dueOn: managementDate,
  nextReviewOn: managementDate,
  impact: z.enum(['high', 'medium', 'low']),
  nextAction: text(1000),
  blocker: z.string().trim().max(1000).default(''),
  state: z.enum(managementStates).default('open'),
  sourceKey: z.string().max(160).nullable().default(null),
  sourceUrl: managementLink.nullable().default(null),
  dependsOn: z.string().uuid().nullable().default(null),
  evidence: managementEvidenceSchema.nullable().default(null),
  reviewNote: z.string().trim().max(2000).default(''),
});
export type ManagementCaseData = z.infer<typeof managementCaseSchema>;
export interface ManagementCase {
  id: string;
  data: ManagementCaseData;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
export const managementPlaybookSchema = z.object({
  name: text(120),
  purpose: text(1500),
  trigger: text(1000),
  inputs: text(2000),
  steps: text(4000),
  successCriteria: text(2000),
  exceptions: text(2000),
  authority: text(1500),
  browserUrl: managementLink.nullable().default(null),
});
export type ManagementPlaybookData = z.infer<typeof managementPlaybookSchema>;
export const managementProfileSchema = z.object({
  scope: text(3000),
  priorities: text(3000),
  successMeasures: text(3000),
  escalationOwnerId: z.string().uuid().nullable(),
  reviewAfterDays: z.number().int().min(1).max(30),
  playbooks: z.array(managementPlaybookSchema).max(20),
});
export type ManagementProfileData = z.infer<typeof managementProfileSchema>;
export interface ManagementProfile {
  data: ManagementProfileData;
  revision: number;
  updated_at: string;
}
export const defaultManagementProfile: ManagementProfileData = {
  scope: 'Operaciones administrativas: compromisos, trámites y seguimiento de pendientes.',
  priorities: 'Atender vencimientos, resolver bloqueos y verificar resultados antes de cerrar.',
  successMeasures:
    'Cumplimiento de plazos, tiempo de resolución y cierres con evidencia verificable.',
  escalationOwnerId: null,
  reviewAfterDays: 2,
  playbooks: [],
};
export interface ManagementSignal {
  key: string;
  title: string;
  reason: string;
  href: string;
  dueOn: string | null;
  ownerId: string | null;
  impact: 'high' | 'medium' | 'low';
}
export interface ManagementEvent {
  id: string;
  actor_id: string;
  case_id: string;
  revision: number;
  created_at: string;
  data: ManagementCaseData;
}
export function managementPriority(
  item: ManagementCase,
  today: string,
  all: ManagementCase[] = [],
) {
  const d = item.data;
  if (d.state === 'verified' || d.state === 'cancelled')
    return { score: -1, reasons: ['Asunto cerrado'] };
  const reasons: string[] = [];
  let score = { high: 30, medium: 15, low: 0 }[d.impact];
  if (d.impact === 'high') reasons.push('Impacto alto declarado');
  if (d.dueOn < today) {
    score += 100;
    reasons.push('Plazo vencido');
  } else if (d.dueOn === today) {
    score += 60;
    reasons.push('Vence hoy');
  }
  if (d.state === 'blocked') {
    score += 50;
    reasons.push('Bloqueo declarado');
  }
  if (!d.ownerId) {
    score += 25;
    reasons.push('Falta responsable');
  }
  if (d.nextReviewOn <= today) {
    score += 20;
    reasons.push('Seguimiento pendiente');
  }
  if (d.state === 'review') {
    score += 35;
    reasons.push('Falta verificar el resultado');
  }
  if (d.dependsOn && !all.some((c) => c.id === d.dependsOn && c.data.state === 'verified')) {
    score += 40;
    reasons.push('Depende de un asunto sin verificar');
  }
  return { score, reasons: reasons.length ? reasons : ['Dentro del plazo'] };
}

export function validateManagementTransition(
  previous: ManagementCaseData | null,
  next: ManagementCaseData,
  canVerify: boolean,
  today: string,
) {
  if (!previous && next.state !== 'open') throw new Error('Un asunto nuevo empieza por organizar.');
  if (next.state !== 'open' && next.state !== 'cancelled' && !next.ownerId)
    throw new Error('Asigna un responsable antes de avanzar.');
  if (next.state === 'blocked' && !next.blocker) throw new Error('Explica qué impide avanzar.');
  if (next.state === 'review' || next.state === 'verified') {
    if (!next.evidence)
      throw new Error('Adjunta una referencia y explica qué resultado demuestra.');
    if (next.evidence.observedOn > today)
      throw new Error('La evidencia no puede tener una fecha futura.');
  }
  if (
    next.state === 'verified' &&
    (!canVerify || previous?.state !== 'review' || !next.reviewNote)
  ) {
    throw new Error(
      'Un administrador debe revisar la evidencia y registrar su veredicto antes de cerrar.',
    );
  }
  if (next.state === 'cancelled' && !next.reviewNote)
    throw new Error('Explica por qué se descarta el asunto.');
  if (previous && ['verified', 'cancelled'].includes(previous.state) && next.state !== 'open') {
    throw new Error('Reabre el asunto antes de modificar un cierre.');
  }
}

/** Deterministic, company-shared daily report. No personal source excerpts. */
export function managementDailyReport(
  cases: ManagementCase[],
  people: { id: string; name: string | null; email: string }[],
  profile: ManagementProfileData,
  today: string,
  truncated = false,
) {
  const name = (id: string | null) =>
    people.find((p) => p.id === id)?.name ||
    people.find((p) => p.id === id)?.email ||
    'Sin responsable';
  const clean = (value: string) =>
    value
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\[\]<>*_`]/g, '')
      .slice(0, 250);
  const active = cases.filter((c) => !['verified', 'cancelled'].includes(c.data.state));
  const attention = active
    .filter(
      (c) =>
        c.data.dueOn <= today ||
        c.data.nextReviewOn <= today ||
        ['blocked', 'review'].includes(c.data.state) ||
        !c.data.ownerId ||
        !!(
          c.data.dependsOn &&
          !cases.some((d) => d.id === c.data.dependsOn && d.data.state === 'verified')
        ),
    )
    .sort(
      (a, b) =>
        managementPriority(b, today, cases).score - managementPriority(a, today, cases).score ||
        a.id.localeCompare(b.id),
    );
  const closed = cases.filter(
    (c) =>
      c.data.state === 'verified' &&
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(c.updated_at)) === today,
  );
  return [
    `# Parte de gerencia · ${today}`,
    `${active.length} asuntos abiertos · ${attention.length} requieren atención · ${closed.length} cierres registrados hoy.`,
    truncated
      ? 'Vista parcial: se alcanzó el límite de lectura. Las cifras pueden estar incompletas.'
      : '',
    '## Lo que requiere atención',
    attention.length
      ? attention
          .slice(0, 20)
          .map(
            (c) =>
              `- **${clean(c.data.title)}** — ${clean(name(c.data.ownerId))}. Plazo: ${c.data.dueOn}. ${managementPriority(c, today, cases).reasons.join('; ')}. Próximo paso: ${clean(c.data.nextAction)}`,
          )
          .join('\n')
      : 'Sin asuntos que requieran atención según los registros consultados.',
    attention.length > 20 ? `Hay ${attention.length - 20} asuntos adicionales en Gerencia.` : '',
    `Escalamiento acordado: ${clean(name(profile.escalationOwnerId))}. Este parte identifica al responsable; no envía mensajes a esa persona.`,
    'Consulta Gerencia para revisar evidencia, reasignar o registrar avances. Este parte consulta asuntos compartidos; no ejecuta trámites ni verifica resultados automáticamente.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A reviewed case must not hide a live source still reporting a pending task. */
export function managementSourceConflicts(signals: ManagementSignal[], cases: ManagementCase[]) {
  return signals.flatMap((signal) => {
    // Goal readings describe a frozen historical period; closing corrective work cannot rewrite it.
    if (signal.key.startsWith('goal:')) return [];
    const item = cases.find(
      (c) => c.data.sourceKey === signal.key && ['verified', 'cancelled'].includes(c.data.state),
    );
    return item ? [{ signal, caseId: item.id }] : [];
  });
}
