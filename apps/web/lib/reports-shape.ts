/**
 * The reports vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once: green locally, red in Vercel.
 *
 * `commitments-shape.ts`, `kb-relevance-shape.ts` and `ToolsCatalog.tsx` all hit
 * the same wall and solved it the same way. Types are fine to import (they
 * erase); values are not.
 *
 * These are copies, and copies drift. `reports-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

/**
 * The three the builder can compute from a kind plus parameters. This is what
 * the picker offers, and it is deliberately narrower than the list below: a
 * saved chat chart has no parameters to re-run, so a fourth card offering to
 * "generate" one would be a button that cannot work.
 */
export const GENERATED_REPORT_KINDS = ['expiries', 'fleet', 'client_activity'] as const;
export type GeneratedReportKind = (typeof GENERATED_REPORT_KINDS)[number];

/**
 * Every kind a STORED report may have — the three above, the chat chart, and the
 * parte semanal. Neither of the last two is a recipe: the chart was drawn from
 * numbers that already existed, and the parte belongs to one specific week and
 * is claimed by the Monday cron (migration 0100), so a "generar" button for
 * either would be a button that cannot work.
 */
export const REPORT_KINDS = [...GENERATED_REPORT_KINDS, 'chart', 'weekly'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  expiries: 'Vencimientos',
  fleet: 'Estado de la flota',
  client_activity: 'Actividad por cliente',
  chart: 'Gráfico del chat',
  weekly: 'Parte semanal',
};

/**
 * The one-liner under each report on the picker. Shorter than the tool
 * description the model reads: a person choosing from three cards needs the
 * difference between them, not the caveats.
 */
export const REPORT_KIND_PITCH: Record<ReportKind, string> = {
  expiries: 'Qué se vence, cuándo, y cuánto cuesta si se pasa.',
  fleet: 'SOAT, tecnomecánica y comparendos de cada placa.',
  client_activity: 'Qué tiene comprometido cada contraparte y qué se le vence primero.',
  chart: 'Un gráfico que salió de una conversación y alguien decidió conservar.',
  weekly: 'Lo que pasó la semana pasada y lo que viene. Llega solo cada lunes.',
};

/** Lucide icon names, resolved by the client component's own map. */
export const REPORT_KIND_ICON: Record<ReportKind, string> = {
  expiries: 'CalendarClock',
  fleet: 'Truck',
  client_activity: 'Building2',
  chart: 'ChartNoAxesColumn',
  weekly: 'CalendarDays',
};

export function isReportKind(value: string): value is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value);
}

/** Narrower guard for the one surface that may only accept a buildable kind. */
export function isGeneratedReportKind(value: string): value is GeneratedReportKind {
  return (GENERATED_REPORT_KINDS as readonly string[]).includes(value);
}
