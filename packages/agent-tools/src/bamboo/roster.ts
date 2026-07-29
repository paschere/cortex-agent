import type { ToolContext } from '../types';
import { bambooFetch } from './client';
import type { BambooResult } from './client';
import { ROSTER_FIELDS, type ReportRow, str } from './shape';

/**
 * The custom-report endpoint is the only way to read a chosen set of fields for
 * everybody in one request, so it backs every roster-shaped tool here — the
 * same endpoint the payroll app's nightly sync uses.
 *
 * `onlyCurrent: true` restricts historical/tabular fields to the row in effect
 * today. Without it BambooHR returns one report row per historical revision and
 * a person who has had four raises appears four times.
 */
export async function fetchReport(
  ctx: ToolContext,
  fields: string[],
): Promise<BambooResult<ReportRow[]>> {
  const res = await bambooFetch<{ employees?: ReportRow[] }>(ctx, 'POST', '/reports/custom', {
    params: { format: 'JSON' },
    body: { fields, onlyCurrent: true },
  });
  if (!res.ok) return res;
  return { ok: true, data: res.data.employees ?? [] };
}

export interface PersonQuery {
  name?: string;
  email?: string;
  employeeId?: string;
}

export type Resolution =
  | { kind: 'found'; row: ReportRow }
  | { kind: 'none'; reason: string }
  | { kind: 'ambiguous'; reason: string; candidates: string[] };

function normalise(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      // Accents are dropped on both sides so "Mariana Perez" matches the accented
      // spelling BambooHR actually stores.
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Find one person from a name, a work email or an internal id.
 *
 * People ask for colleagues by name, so name is the primary path and an
 * ambiguous name is reported as ambiguous rather than resolved to whichever row
 * came back first. Silently picking one of two people called "Juan" and then
 * quoting their salary is the failure mode worth spending a round-trip on.
 */
export async function resolveEmployee(
  ctx: ToolContext,
  query: PersonQuery,
  extraFields: string[] = [],
): Promise<BambooResult<Resolution>> {
  const fields = [...new Set([...ROSTER_FIELDS, ...extraFields])];
  const res = await fetchReport(ctx, fields);
  if (!res.ok) return res;
  const rows = res.data;

  if (query.employeeId) {
    const row = rows.find((r) => String(r.id) === String(query.employeeId));
    return {
      ok: true,
      data: row
        ? { kind: 'found', row }
        : { kind: 'none', reason: 'There is nobody in BambooHR with that record.' },
    };
  }

  if (query.email) {
    const wanted = normalise(query.email);
    const row = rows.find((r) => normalise(str(r.workEmail) ?? '') === wanted);
    return {
      ok: true,
      data: row
        ? { kind: 'found', row }
        : {
            kind: 'none',
            reason: `Nobody in BambooHR has ${query.email} as their work email.`,
          },
    };
  }

  const wanted = normalise(query.name ?? '');
  if (!wanted) {
    return {
      ok: true,
      data: { kind: 'none', reason: 'I need a name or a work email to look someone up.' },
    };
  }

  const named = rows.filter((r) => str(r.displayName));
  const exact = named.filter((r) => normalise(str(r.displayName) as string) === wanted);
  const partial = exact.length
    ? exact
    : named.filter((r) => normalise(str(r.displayName) as string).includes(wanted));

  if (partial.length === 0) {
    return {
      ok: true,
      data: {
        kind: 'none',
        reason: `I could not find anyone called "${query.name}" in BambooHR. Worth checking the spelling, or trying their work email.`,
      },
    };
  }

  if (partial.length > 1) {
    // Someone who left and someone who is here are not equally likely to be the
    // person being asked about, so an unambiguous active match wins.
    const active = partial.filter((r) => str(r.status) === 'Active');
    if (active.length === 1)
      return { ok: true, data: { kind: 'found', row: active[0] as ReportRow } };
    const pool = active.length ? active : partial;
    const candidates = pool.slice(0, 8).map((r) => {
      const title = str(r.jobTitle);
      const dept = str(r.department);
      const where = [title, dept].filter(Boolean).join(', ');
      return where ? `${str(r.displayName)} (${where})` : (str(r.displayName) as string);
    });
    return {
      ok: true,
      data: {
        kind: 'ambiguous',
        reason: `More than one person matches "${query.name}". Which one did you mean?`,
        candidates,
      },
    };
  }

  return { ok: true, data: { kind: 'found', row: partial[0] as ReportRow } };
}
