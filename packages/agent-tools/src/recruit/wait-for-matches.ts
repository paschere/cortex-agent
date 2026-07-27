import { z } from 'zod';
import { registerTool } from '../index';
import { internalFetch, matcherFetch, qs } from './client';
import {
  SOURCE,
  type ToolMeta,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
} from './shape';

/**
 * Active waiting for the async matching run started by recruit.find_matches.
 *
 * UX contract: the calling model starts matching, then calls this tool — the
 * user sees one "working…" step while the server polls. If matching finishes
 * within the window, the pool stats come back ready to present. If not, the
 * tool returns ready=false with progress so far; the model narrates progress
 * ("still scoring, N candidates so far…") and simply calls again. Works
 * identically in the web chat and over MCP.
 *
 * Readiness used to be a GUESS: it polled /api/jobs/[id]/insights — which
 * loads every application with its insights, interview analyses and recruiter
 * ratings plus a TestGorilla join, ~1.2 s on a 329-candidate pool — and
 * declared victory once the scored count had crept past the caller's previous
 * number and cleared five. That fires mid-run on a big pool and gives the user
 * half a shortlist presented as the whole one.
 *
 * The matching run already records its own state on the job row (syncStatus
 * ZIPDEV_MOTOR → COMPLETED/ERROR, plus a find_matches_completed step carrying
 * the run's totals), so /api/internal/recruit/match-status answers "is it done"
 * definitively in a couple of cheap counts. Because each poll is now ~100 ms
 * instead of ~1.2 s, the interval drops from 8 s to 5 s: the same 40-second
 * window notices completion sooner without costing the matcher more.
 */

const POLL_EVERY_MS = 5_000;
/** Keep the whole call comfortably inside MCP clients' tool-call timeout. */
const DEFAULT_MAX_WAIT_S = 40;

interface MatchStatus {
  state: 'idle' | 'running' | 'completed' | 'error';
  ready: boolean;
  progressText: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  pool: { totalCandidates: number; scoredCandidates: number; withAiInsights: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastRun: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: any;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(
  state: string,
  pool: any,
  lastRun: any,
  elapsed: number,
  meta: ToolMeta,
): string {
  const lines: string[] = [];
  if (state === 'completed') {
    lines.push(
      `**Matching finished** — ${pool.scoredCandidates} of ${pool.totalCandidates} candidates scored.`,
    );
    if (lastRun?.recommended != null) {
      lines.push(
        `The run recommended ${lastRun.recommended} candidate(s) out of ${lastRun.evaluated ?? '?'} evaluated.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const top: any[] = Array.isArray(lastRun?.topCandidates) ? lastRun.topCandidates : [];
    if (top.length) {
      lines.push('');
      lines.push('| # | Candidate | Score | Matched skills |');
      lines.push('| --- | --- | --- | --- |');
      top.forEach((c, i) => {
        lines.push(
          `| ${i + 1} | ${c.name ?? '—'} | ${typeof c.score === 'number' ? Math.round(c.score) : '—'} | ${c.matchedSkills ?? '—'} |`,
        );
      });
    }
  } else if (state === 'error') {
    lines.push(`**Matching failed** after ${elapsed}s.`);
  } else if (state === 'running') {
    lines.push(
      `**Still matching** (${elapsed}s so far) — ${pool.scoredCandidates} of ${pool.totalCandidates} candidates scored.`,
    );
  } else {
    lines.push(
      `No matching run recorded for this requisition; the pool holds ${pool.totalCandidates} candidate(s).`,
    );
  }
  lines.push('');
  lines.push(provenanceFooter(meta));
  return lines.join('\n');
}

export const recruitWaitForMatches = registerTool({
  id: 'recruit.wait_for_matches',
  description:
    "Wait for candidate matching to finish (use right after recruit.find_matches). Polls the run's real status server-side for up to ~40 seconds and returns the pool when it is genuinely complete, together with the run's own top candidates. " +
    'Read `state`: "completed" means done — present the shortlist; "running" means call this tool again after telling the user in plain words that it is still working ("sigo puliendo la lista — ya hay N candidatos evaluados"); "error" means the run failed, say so; "idle" means no run has been recorded and any pool present came from the ATS sync instead. Never tell the user to check back themselves, and never present a "running" pool as the finished shortlist. ' +
    'PROVENANCE: scores and rankings here are Zipdev AI scoring — derived, not Workable ATS data and not client feedback. Cite that, and cite meta.fetchedAt, when you present results.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    maxWaitSeconds: z.number().int().min(5).max(45).default(DEFAULT_MAX_WAIT_S),
    /** Candidate count from the previous attempt; used only by the legacy fallback. */
    previousCount: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    state: z.enum(['idle', 'running', 'completed', 'error']),
    ready: z.boolean(),
    elapsedSeconds: z.number(),
    totalCandidates: z.number(),
    scoredCandidates: z.number(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lastRun: z.any().nullable(),
    error: z.string().nullable(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const started = Date.now();
    const deadline = started + (input.maxWaitSeconds ?? DEFAULT_MAX_WAIT_S) * 1000;
    const elapsed = () => Math.round((Date.now() - started) / 1000);

    let pool = { totalCandidates: 0, scoredCandidates: 0, withAiInsights: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastRun: any = null;
    let state: 'idle' | 'running' | 'completed' | 'error' = 'idle';
    let error: string | null = null;
    let leanAvailable = true;
    let leanReason = '';

    for (;;) {
      if (leanAvailable) {
        const res = await internalFetch<MatchStatus>(
          `/api/internal/recruit/match-status${qs({ jobId: input.jobId })}`,
        );
        if (res.available) {
          state = res.data.state;
          pool = res.data.pool;
          lastRun = res.data.lastRun ?? null;
          error = res.data.error ?? null;
          if (state !== 'running') break;
        } else {
          leanAvailable = false;
          leanReason = res.reason;
        }
      }

      if (!leanAvailable) {
        // Legacy fallback: the expensive insights aggregate, with the old
        // "scored count grew and cleared five" heuristic. It cannot see the
        // run's real state, so it can only report progress.
        try {
          const data = await matcherFetch(`/api/jobs/${encodeURIComponent(input.jobId)}/insights`);
          const s = data?.stats ?? {};
          pool = {
            totalCandidates: Number(s.totalCandidates ?? 0),
            scoredCandidates: Number(s.candidatesWithAI ?? 0),
            withAiInsights: Number(s.candidatesWithAI ?? 0),
          };
          const settled = pool.totalCandidates > 0 && pool.scoredCandidates >= pool.totalCandidates;
          const grew = pool.scoredCandidates > (input.previousCount ?? 0);
          if (settled || (grew && pool.scoredCandidates >= 5)) {
            state = 'completed';
            break;
          }
          state = 'running';
        } catch {
          // Transient matcher hiccup — keep polling until the window closes.
        }
      }

      if (Date.now() + POLL_EVERY_MS > deadline) break;
      await sleep(POLL_EVERY_MS, ctx.signal);
      if (ctx.signal?.aborted) break;
    }

    const meta = buildMeta({
      endpoint: leanAvailable ? '/api/internal/recruit/match-status' : '/api/jobs/:id/insights',
      degraded: !leanAvailable,
      degradedReason: leanReason,
      returned: pool.scoredCandidates,
      truncated: state === 'running',
      elapsedSeconds: elapsed(),
      links: { matcher: matcherLink(`/jobs/${input.jobId}`) },
      provenance: {
        'state, lastRun.*': `${SOURCE.matcher} — written by the matching run itself onto the job record`,
        'pool.*': `${SOURCE.matcher} — live counts over the job's application rows`,
        'lastRun.topCandidates[].score': `${SOURCE.aiScoring} — derived, never an ATS field`,
      },
      dataQuality: [
        ...(state === 'running'
          ? [
              'Matching is still running — this pool is incomplete. Do not present it as the final shortlist.',
            ]
          : []),
        ...(!leanAvailable
          ? [
              'Completion here is inferred from the scored count, not from the run\'s own status, so it can fire before the run truly finishes. Treat "completed" as "results so far".',
            ]
          : []),
      ],
    });

    return {
      state,
      ready: state === 'completed' || (state === 'idle' && pool.scoredCandidates > 0),
      elapsedSeconds: elapsed(),
      totalCandidates: pool.totalCandidates,
      scoredCandidates: pool.scoredCandidates,
      lastRun,
      error,
      meta,
      markdown: renderMarkdown(state, pool, lastRun, elapsed(), meta),
    };
  },
});
