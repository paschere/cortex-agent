/**
 * The plan and consumption vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither bundles for the browser. `commitments-shape.ts` and
 * `ToolsCatalog.tsx` hit the same wall and solved it the same way.
 *
 * These are copies, and copies drift. `plan-shape.test.ts` runs in Node, imports
 * the real modules and fails if the two ever disagree.
 *
 * The Spanish also lives here rather than in the package, because it is UI copy
 * and belongs next to the screens that read it.
 */

export const METERS = ['answers', 'documents'] as const;
export type MeterId = (typeof METERS)[number];

export const METER_STATES = ['ok', 'warning', 'grace', 'blocked'] as const;
export type MeterState = (typeof METER_STATES)[number];

export const ONBOARDING_GOALS = ['email', 'documents', 'deadlines', 'meetings'] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_STEPS = ['goal', 'source', 'knowledge', 'answer', 'team'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** What the meter is called on screen. Singular and plural, because both appear. */
export const METER_LABEL: Record<MeterId, { one: string; many: string; help: string }> = {
  answers: {
    one: 'respuesta',
    many: 'respuestas',
    help: 'Cada vez que Cortex te responde, en el chat, en WhatsApp o en una rutina.',
  },
  documents: {
    one: 'documento',
    many: 'documentos',
    help: 'Cada archivo, correo archivado o grabación que entra a Brain Knowledge. Una grabación cuenta como un documento, no por minutos.',
  },
};

/**
 * What each state means to the person reading it, not what it means to the code.
 *
 * `grace` deliberately does not say "te pasaste" and stop there. Somebody who
 * crossed the line mid-conversation needs to know two things in the same breath:
 * that nothing broke, and that it will if they keep going.
 */
export const METER_STATE_LABEL: Record<MeterState, string> = {
  ok: 'Al día',
  warning: 'Ya casi',
  grace: 'Margen de cortesía',
  blocked: 'Sin cupo',
};

/** Design-system tones. rose is only for something that has actually stopped. */
export const METER_STATE_TONE: Record<MeterState, 'emerald' | 'amber' | 'rose'> = {
  ok: 'emerald',
  warning: 'amber',
  grace: 'amber',
  blocked: 'rose',
};

/** The one question, and the four answers that change what happens next. */
export const GOAL_LABEL: Record<OnboardingGoal, { title: string; detail: string }> = {
  email: {
    title: 'Que lea mi correo y me diga qué está pendiente',
    detail: 'Conectas Gmail o Outlook y Cortex responde desde tus conversaciones reales.',
  },
  documents: {
    title: 'Que responda sobre nuestros contratos y documentos',
    detail: 'Subes lo que ya tienes y Cortex cita la frase exacta de dónde lo sacó.',
  },
  deadlines: {
    title: 'Que me avise de vencimientos y compromisos',
    detail: 'Lee las fechas de tus documentos y te avisa antes, no después.',
  },
  meetings: {
    title: 'Que resuma mis reuniones',
    detail: 'Trae las grabaciones de Google Meet y te deja el resumen y los acuerdos.',
  },
};

/**
 * The first question worth asking, per goal.
 *
 * Not decoration: an empty chat box is the last screen of a good onboarding and
 * the first screen of a bad one. These go straight into the box, and every one
 * of them is answerable only from the source the guide just had them connect —
 * which is the point. A suggestion the product cannot answer teaches the wrong
 * thing about it.
 */
export const GOAL_FIRST_QUESTION: Record<OnboardingGoal, string> = {
  email: '¿Qué me quedó pendiente de responder esta semana?',
  documents: '¿Qué dice nuestro contrato sobre plazos de pago?',
  deadlines: '¿Qué se nos vence en los próximos treinta días?',
  meetings: '¿Qué acordamos en la última reunión y quién quedó de hacer qué?',
};

/** Pesos colombianos, whole units, with the local thousands separator. */
export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')}`;
}

/** A count, in the same local format. Always rendered in the mono face. */
export function count(value: number): string {
  return value.toLocaleString('es-CO');
}

/** "150 respuestas" / "1 respuesta". */
export function meterAmount(meter: MeterId, value: number): string {
  const label = METER_LABEL[meter];
  return `${count(value)} ${value === 1 ? label.one : label.many}`;
}

/**
 * How full a bar should be drawn, 0–1.
 *
 * Capped for the BAR only. The percentage next to it is not capped, because a
 * workspace at 118% has a right to read 118% rather than a bar that has quietly
 * been full for two weeks.
 */
export function barFill(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(1, used / limit);
}

export function percent(used: number, limit: number | null): string | null {
  if (limit === null || limit <= 0) return null;
  return `${Math.round((used / limit) * 100)}%`;
}

/**
 * `2026-08` -> `agosto de 2026`.
 *
 * Built from the string rather than from a Date, and pinned to day 15 when one
 * is needed, because parsing `2026-08` as a date and formatting it west of
 * Greenwich is the classic way to render July.
 */
export function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  if (!year || !month) return period;
  const name = new Intl.DateTimeFormat('es-CO', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, 15)),
  );
  return `${name} de ${year}`;
}

/**
 * `2026-08-07T15:04:00Z` -> `07 ago 10:04`, in Bogotá.
 *
 * Assembled from `formatToParts` rather than from `.format()`, matching the
 * `stamp()` the clients and commitments screens already use: es-CO renders the
 * whole string as "7 de ago, 10:04", which is prose, and this is evidence — it
 * sits in the mono face in a column beside other timestamps, so the day needs
 * its leading zero and the separators need to be ours.
 */
export function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // es-CO drops the leading zero on the day whatever `day: '2-digit'` asks for,
  // so it is padded here. These stamps run down a column in the mono face, and
  // `tabular-nums` aligns digits — it cannot align a digit that is missing.
  return `${get('day').padStart(2, '0')} ${get('month').replace('.', '')} ${get('hour')}:${get('minute')}`;
}

/** Where a metered unit came from, in words. Unknown sources pass through. */
export const SOURCE_LABEL: Record<string, string> = {
  web: 'Chat',
  desktop: 'Escritorio',
  mcp: 'Claude / MCP',
  other: 'Otro',
  upload: 'Subido',
  gdrive: 'Google Drive',
  url: 'Enlace',
};
