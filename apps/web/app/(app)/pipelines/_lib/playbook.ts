/**
 * Pure helpers shared by the pipeline builder (client) and the pipeline pages
 * (server). No imports from the tool registry or the DB live here so the whole
 * module can cross the server/client boundary.
 *
 * `renderPlaybook` is a line-for-line mirror of the string assembly inside
 * pipeline.run (packages/agent-tools/src/pipeline/tools.ts) — if that renderer
 * changes, change this one with it. It is what powers the builder's
 * "what the agent will actually see" preview.
 */

export interface ParamDef {
  name: string;
  description?: string;
  required?: boolean;
}

export interface StepDef {
  title: string;
  detail: string;
  tools?: string[];
  checkpoint?: boolean;
}

/** Tool catalog entry handed from a server page to the builder as a prop. */
export interface BuilderTool {
  id: string;
  description: string;
  family: string;
  /** true = write action, gated behind human confirmation at run time. */
  requiresConfirmation: boolean;
}

export interface PipelineDraft {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  intro: string;
  steps: StepDef[];
  params: ParamDef[];
}

/** Same placeholder grammar as the pipeline tools: {{ paramName }}. */
function placeholderRegex(): RegExp {
  return /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
}

/** Every distinct {{placeholder}} used across the given texts, in order. */
export function extractPlaceholders(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(placeholderRegex())) {
      const name = m[1];
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

/** All texts a placeholder may legally appear in — intro + step title/detail. */
export function placeholderSources(intro: string, steps: StepDef[]): string[] {
  return [intro, ...steps.flatMap((s) => [s.title, s.detail])];
}

/** Mirrors `render()` in pipeline.run: unknown args stay as {{name}}. */
export function renderText(text: string, args: Record<string, string>): string {
  return text.replace(placeholderRegex(), (_, p: string) => args[p] ?? `{{${p}}}`);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** Unicode combining diacritics, stripped after NFD so "café" -> "cafe". */
const COMBINING_MARKS = /\p{M}/gu;

/** "Weekly Client Report!" -> "weekly-client-report" (slug grammar of pipeline.create). */
export function slugify(name: string): string {
  return slugifyInput(name).replace(/-+$/, '');
}

/**
 * Same normalisation, but a trailing dash survives — otherwise typing a dash
 * in the slug field would delete it on the next keystroke.
 */
export function slugifyInput(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 49);
}

/**
 * Exactly the playbook string pipeline.run returns — same head markers, same
 * indentation, same tail instruction. Used for the builder's live preview.
 */
export function renderPlaybook(opts: {
  emoji: string;
  name: string;
  intro: string;
  steps: StepDef[];
  runNumber: number;
  args?: Record<string, string>;
  runId?: string;
}): string {
  const args = opts.args ?? {};
  const emoji = opts.emoji || '⚡';
  const intro = renderText(opts.intro ?? '', args);
  const runId = opts.runId ?? '<runId>';

  const renderedSteps = opts.steps
    .map((s, i) => {
      const head = s.checkpoint
        ? `⛔ STEP ${i + 1} — CHECKPOINT: ${renderText(s.title, args)}`
        : `▪ STEP ${i + 1}: ${renderText(s.title, args)}`;
      const toolsLine = (s.tools ?? []).length > 0 ? `\n   Tools: ${(s.tools ?? []).join(', ')}` : '';
      const gate = s.checkpoint
        ? "\n   HARD STOP: present your findings and WAIT for the user's explicit decision before continuing."
        : '';
      return `${head}\n   ${renderText(s.detail, args)}${toolsLine}${gate}`;
    })
    .join('\n\n');

  const tail = `Execute now, step by step, reporting progress after each step. Confirmation-gated tools still require approval. When finished (or if the user abandons), call pipeline.finish_run with runId="${runId}" and a one-line outcome summary.`;

  return `${emoji} PIPELINE: ${opts.name} (run #${opts.runNumber})\n\n${
    intro ? `${intro}\n\n` : ''
  }${renderedSteps}\n\n${tail}`;
}

const FAMILY_LABELS: Record<string, string> = {
  hubspot: 'HubSpot',
  recruit: 'Recruiting',
  workable: 'Workable',
  kb: 'Knowledge Base',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  gsheets: 'Google Sheets',
  gdrive: 'Google Drive',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  rate: 'Rates',
  payroll: 'Payroll',
  web: 'Web',
  format: 'Formatting',
  people: 'People',
  growth: 'Growth Signals',
  pipeline: 'Pipelines',
  schedule: 'Schedules',
  sales: 'Sales',
  cortex: 'Cortex',
  zipdev: 'Zipdev',
};

export function familyOf(id: string): string {
  return id.split('.')[0] ?? id;
}

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** The sentence a user says to Cortex to launch this pipeline. */
export function runSentence(
  slug: string,
  params: ParamDef[],
  values: Record<string, string>,
): string {
  const parts = params
    .filter((p) => p.required !== false || (values[p.name] ?? '').trim().length > 0)
    .map((p) => `${p.name}: ${(values[p.name] ?? '').trim() || '…'}`);
  return `Run the "${slug}" pipeline${parts.length > 0 ? ` with ${parts.join(', ')}` : ''}`;
}
