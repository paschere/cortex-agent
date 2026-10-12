import { isReadTool } from '@/lib/activity/sentences';
import type { BrainSource } from '@/lib/brain-sources-shape';
import { essentialArgs } from '@/lib/tool-args';
import { toolDisplayName } from '@/lib/tool-labels';

/**
 * LO QUE EL PANEL DERECHO CUENTA DE UN TURNO: FUENTES Y ACTIVIDAD.
 *
 * Funciones puras sobre lo que la pantalla ya tiene (las invocaciones del
 * mensaje, las fuentes del cerebro y las filas de auditoría que vienen con las
 * cifras del turno). Nada se mide aquí: se ordena y se redacta lo ya medido.
 */

export interface TurnInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
}

export interface TurnCall {
  toolId: string;
  ms: number | null;
  status: string;
  /** `confirmed` = lo aprobó una persona; `delegated` = lo hizo solo con permiso. */
  decision?: string | null;
  at?: string | null;
}

export type StepStatus = 'ok' | 'error' | 'waiting' | 'running';

export interface ActivityRow {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
  ms: number | null;
  approval: null | { kind: 'person' | 'delegated'; at: string | null };
}

export interface SourceRow {
  id: string;
  kind: 'brain' | 'tool';
  title: string;
  detail: string;
  href: string | null;
  external: boolean;
  weak?: boolean;
}

const URL_RE = /https?:\/\/[^\s"'<>)]+/;

function statusOf(inv: TurnInvocation): StepStatus {
  if (inv.state !== 'result') return 'running';
  const r = inv.result;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if ('__error' in o) return 'error';
    if (o.__requires_confirmation === true) return 'waiting';
  }
  return 'ok';
}

function firstUrl(args: unknown): string | null {
  if (!args) return null;
  const m = JSON.stringify(args).match(URL_RE);
  return m ? m[0].replace(/\\.*$/, '') : null;
}

/** Empareja, en orden y por herramienta, las filas de auditoría con las llamadas. */
export function matchCalls(
  invocations: readonly TurnInvocation[],
  calls: readonly TurnCall[] | undefined,
): Map<string, TurnCall> {
  const out = new Map<string, TurnCall>();
  const queues = new Map<string, TurnCall[]>();
  for (const c of calls ?? []) {
    const key = c.toolId.replaceAll('.', '_');
    queues.set(key, [...(queues.get(key) ?? []), c]);
  }
  for (const inv of invocations) {
    const next = queues.get(inv.toolName.replaceAll('.', '_'))?.shift();
    if (next) out.set(inv.toolCallId, next);
  }
  return out;
}

export function buildActivityRows(
  invocations: readonly TurnInvocation[],
  calls: readonly TurnCall[] | undefined,
): ActivityRow[] {
  const matched = matchCalls(invocations, calls);
  return invocations.map((inv) => {
    const call = matched.get(inv.toolCallId);
    const status = statusOf(inv);
    const approval: ActivityRow['approval'] =
      call?.decision === 'confirmed'
        ? { kind: 'person', at: call.at ?? null }
        : call?.decision === 'delegated'
          ? { kind: 'delegated', at: call.at ?? null }
          : null;
    return {
      id: inv.toolCallId,
      name: toolDisplayName(inv.toolName),
      summary: essentialArgs(inv.args),
      status,
      ms: call?.ms !== undefined && call.ms !== null && Number.isFinite(call.ms) ? call.ms : null,
      approval,
    };
  });
}

/** Lo que el turno leyó: el cerebro y las consultas (no lo que cambió algo). */
export function buildSourceRows(
  invocations: readonly TurnInvocation[],
  brain: readonly BrainSource[],
): SourceRow[] {
  const rows: SourceRow[] = brain.map((b) => ({
    id: `brain:${b.documentId}`,
    kind: 'brain',
    title: b.title,
    detail: ['Cerebro', b.age, b.spokenAt ? `min ${b.spokenAt}` : null].filter(Boolean).join(' · '),
    href: '/kb',
    external: false,
    weak: b.relevance === 'weak',
  }));
  for (const inv of invocations) {
    if (inv.state !== 'result' || !isReadTool(inv.toolName.replace('_', '.'))) continue;
    if (statusOf(inv) === 'error') continue;
    const url = firstUrl(inv.args);
    rows.push({
      id: `tool:${inv.toolCallId}`,
      kind: 'tool',
      title: toolDisplayName(inv.toolName),
      detail: essentialArgs(inv.args) || 'Consulta conectada',
      href: url,
      external: Boolean(url),
    });
  }
  return rows;
}

/** La conversación entera como Markdown, para bajarla o pegarla en otro lado. */
export function conversationMarkdown(
  title: string,
  messages: ReadonlyArray<{ role: string; content: string; createdAt?: Date | string }>,
): string {
  const out = [`# ${title.trim() || 'Conversación con Cortex'}`, ''];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const body = m.content.trim();
    if (!body) continue;
    out.push(`## ${m.role === 'user' ? 'Tú' : 'Cortex'}`, '', body, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export function markdownFileName(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'conversacion'}.md`;
}
