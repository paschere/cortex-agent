import type { ActivityEvent } from './types';

/** `metadata.detail` (packages/agent-tools/src/audit-detail.ts), leído sin fiarse de su forma. */
export interface EventDetail {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  before: Record<string, unknown> | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function detailOf(event: Pick<ActivityEvent, 'metadata'>): EventDetail {
  const d = obj(event.metadata?.detail);
  return {
    input: obj(d?.input) ?? {},
    result: obj(d?.result) ?? {},
    before: obj(d?.before),
  };
}

export function str(v: unknown, max = 80): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** «ana@x.com», «ana@x.com y otro», «ana@x.com y 2 más». */
export function people(v: unknown): string | null {
  const list = Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string'
      ? [v]
      : // `sanitizeForAudit` guarda las listas largas como { items, total }.
        Array.isArray(obj(v)?.items)
        ? (obj(v)?.items as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
  if (list.length === 0) return null;
  const first = list[0] as string;
  if (list.length === 1) return first;
  return list.length === 2 ? `${first} y ${list[1]}` : `${first} y ${list.length - 1} más`;
}
