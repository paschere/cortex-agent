import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

/**
 * Active waiting for the async matching run started by recruit.find_matches.
 *
 * UX contract: the calling model starts matching, then calls this tool — the
 * user sees one "working…" step while the server polls. If matching finishes
 * within the window, the pool stats come back ready to present. If not, the
 * tool returns ready=false with progress so far; the model narrates progress
 * ("still scoring, N candidates so far…") and simply calls again. Works
 * identically in the web chat and over MCP.
 */
export const recruitWaitForMatches = registerTool({
  id: 'recruit.wait_for_matches',
  description:
    "Wait for candidate matching to produce results (use right after recruit.find_matches). Polls server-side for up to ~40 seconds and returns the candidate pool stats when ready. If it returns ready=false, tell the user it's still working (in plain words, e.g. 'sigo puliendo la lista — ya hay N candidatos evaluados') and call this tool again. Never tell the user to check later themselves.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    maxWaitSeconds: z.number().int().min(5).max(45).default(40),
    /** Candidate count from the previous attempt, to detect fresh progress. */
    previousCount: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    ready: z.boolean(),
    elapsedSeconds: z.number(),
    totalCandidates: z.number(),
    scoredCandidates: z.number(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insights: z.any().nullable(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const started = Date.now();
    const deadline = started + (input.maxWaitSeconds ?? 40) * 1000;
    const POLL_EVERY_MS = 8000;

    let total = 0;
    let scored = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastInsights: any = null;

    for (;;) {
      try {
        const data = await matcherFetch(`/api/jobs/${encodeURIComponent(input.jobId)}/insights`);
        lastInsights = data;
        const s = data?.stats ?? {};
        total = Number(s.totalCandidates ?? 0);
        scored = Number(s.candidatesWithAI ?? 0);

        // Ready = there are scored candidates and the pool stopped growing
        // since the caller's last look (or everything visible is scored).
        const grewPastPrevious = scored > (input.previousCount ?? 0);
        const settled = total > 0 && scored >= total;
        if (settled || (grewPastPrevious && scored >= 5)) {
          return {
            ready: true,
            elapsedSeconds: Math.round((Date.now() - started) / 1000),
            totalCandidates: total,
            scoredCandidates: scored,
            insights: lastInsights,
          };
        }
      } catch {
        // Transient matcher hiccup — keep polling until the window closes.
      }

      if (Date.now() + POLL_EVERY_MS > deadline) {
        return {
          ready: scored > 0,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
          totalCandidates: total,
          scoredCandidates: scored,
          insights: scored > 0 ? lastInsights : null,
        };
      }
      await new Promise((r) => {
        const t = setTimeout(r, POLL_EVERY_MS);
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
      if (ctx.signal?.aborted) {
        return {
          ready: false,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
          totalCandidates: total,
          scoredCandidates: scored,
          insights: null,
        };
      }
    }
  },
});
