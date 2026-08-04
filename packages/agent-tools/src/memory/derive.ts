import { screenMemory } from './sensitive';
import type { MemoryKind, MemorySource } from './types';

/**
 * Turning a person's own history into candidate memories.
 *
 * Everything in this file is PURE — rows in, candidates out — so the whole
 * derivation is unit-testable without a database, and so the nightly job in
 * apps/web/inngest/functions/memory-derive.ts stays a thin shell around it.
 *
 * The important split: the BEHAVIOURAL signals below need no model at all.
 * `audit_events` already records who called which tool, whether it worked and
 * when, per call. Which tools somebody actually uses, the hours they work and
 * what keeps failing for them are counting problems, not inference problems.
 * Asking an LLM to guess them would be slower, cost money, and be wrong
 * sometimes — for facts that are sitting in a table.
 *
 * (`input_hash` is a hash, so tool ARGUMENTS are not minable from audit. What
 * someone actually said lives in `messages`, and that is the only part a model
 * is used for.)
 */

export interface MemoryCandidate {
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  /** Why this was proposed, shown to the person before they accept it. */
  note: string;
  conversationId?: string | null;
}

export interface AuditSignalRow {
  tool_id: string;
  status: string;
  created_at: string;
}

/** Turns that are not tool calls; counting them would drown every real signal. */
const NON_TOOL_IDS = new Set(['__agent_turn']);

const FAMILY_LABELS: Record<string, string> = {
  hubspot: 'the CRM',
  recruit: 'the talent pool',
  workable: 'the ATS',
  gmail: 'email',
  gcal: 'the calendar',
  gsheets: 'spreadsheets',
  gdrive: 'Drive',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  growth: 'growth signals',
  payroll: 'payroll',
  bamboo: 'BambooHR',
  people: 'the team roster',
  rate: 'the rate calculator',
  kb: 'Brain Knowledge',
  apollo: 'prospect research',
  pipeline: 'pipelines',
  schedule: 'routines',
  web: 'web research',
  presentations: 'candidate presentations',
  meetings: 'meeting notes',
  sales: 'proposals',
};

function familyOfToolId(toolId: string): string {
  return toolId.split('.')[0] ?? toolId;
}

function label(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

/** Local hour-of-day in the person's own timezone, or null if unparseable. */
function localHour(iso: string, timeZone: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(at);
    const n = Number.parseInt(hour, 10);
    return Number.isFinite(n) ? n % 24 : null;
  } catch {
    return null;
  }
}

/** Enough history that a pattern is a pattern and not last Tuesday. */
const MIN_CALLS_FOR_HOURS = 40;
const MIN_CALLS_FOR_FAMILY = 10;
const MIN_CALLS_FOR_FAILURE = 6;
const FAILURE_RATE = 0.5;

/**
 * Compute what the audit trail already knows. Never guesses — every candidate
 * here is a count with a threshold under it, and its `note` says which count.
 */
export function behaviouralCandidates(rows: AuditSignalRow[], timeZone: string): MemoryCandidate[] {
  const calls = rows.filter((r) => !NON_TOOL_IDS.has(r.tool_id));
  if (calls.length === 0) return [];

  const out: MemoryCandidate[] = [];

  // --- which tools they actually use ---------------------------------------
  const byFamily = new Map<string, { total: number; errors: number }>();
  for (const row of calls) {
    const family = familyOfToolId(row.tool_id);
    const entry = byFamily.get(family) ?? { total: 0, errors: 0 };
    entry.total += 1;
    if (row.status === 'error') entry.errors += 1;
    byFamily.set(family, entry);
  }

  const used = [...byFamily.entries()]
    .filter(([, v]) => v.total >= MIN_CALLS_FOR_FAMILY)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3);

  if (used.length >= 2) {
    const names = used.map(([f]) => label(f));
    const last = names.pop();
    out.push({
      content: `Their work mostly runs through ${names.join(', ')} and ${last} — lead there before offering anything else.`,
      kind: 'fact',
      source: 'behavioural',
      note: `Counted from your own activity: ${used
        .map(([f, v]) => `${label(f)} ${v.total}×`)
        .join(', ')}.`,
    });
  }

  // --- when they work -------------------------------------------------------
  if (calls.length >= MIN_CALLS_FOR_HOURS) {
    const hours = calls
      .map((r) => localHour(r.created_at, timeZone))
      .filter((h): h is number => h !== null)
      .sort((a, b) => a - b);
    if (hours.length >= MIN_CALLS_FOR_HOURS) {
      const lo = hours[Math.floor(hours.length * 0.1)];
      const hi = hours[Math.min(hours.length - 1, Math.floor(hours.length * 0.9))];
      // A span of the whole day is not a working pattern, it is noise.
      if (lo !== undefined && hi !== undefined && hi - lo >= 2 && hi - lo <= 14) {
        out.push({
          content: `They work roughly ${lo}:00–${hi}:00 ${timeZone} — assume that when you talk about timing or schedule anything.`,
          kind: 'fact',
          source: 'behavioural',
          note: `Counted from when you actually work: 80% of your ${hours.length} recent actions fall in that window.`,
        });
      }
    }
  }

  // --- what keeps failing for them ------------------------------------------
  // Phrased as an instruction, not as a fact, because the useful part is what
  // Cortex should DO about it. Worth surfacing even though it may go stale: it
  // is a suggestion the person can reject in one click, and a connection that
  // has been broken for a fortnight is exactly the thing nobody reports.
  for (const [family, v] of byFamily) {
    if (v.total >= MIN_CALLS_FOR_FAILURE && v.errors / v.total >= FAILURE_RATE) {
      out.push({
        content: `${label(family)} keeps failing for them — check it works before promising anything that depends on it.`,
        kind: 'instruction',
        source: 'behavioural',
        note: `${v.errors} of your last ${v.total} actions there failed.`,
      });
      break; // One is a useful warning; a list of them is a status page.
    }
  }

  return out;
}

/**
 * Last gate before anything is proposed: drop what is already known, already
 * refused, or must never be stored at all.
 *
 * `known` should carry every content string the person already has in ANY
 * status — the database enforces this too (0051 refuses a suggestion that
 * duplicates an existing row), but filtering here keeps the model's proposals
 * from silently evaporating and makes the job's own logs honest about how many
 * candidates were really new.
 */
export function usableCandidates(
  candidates: MemoryCandidate[],
  known: Iterable<string>,
  max: number,
): MemoryCandidate[] {
  const seen = new Set([...known].map((c) => c.trim().toLowerCase()));
  const out: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    if (out.length >= max) break;
    const content = candidate.content.trim();
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    if (!screenMemory(content).ok) continue;
    seen.add(key);
    out.push({ ...candidate, content });
  }
  return out;
}
