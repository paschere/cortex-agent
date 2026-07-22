import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const CycleOut = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  isCurrent: z.boolean(),
  total: z.number(),
  completed: z.number(),
  // Velocity here = completed issue count for the cycle. Linear cycle progress
  // (0–1) is derived as completed/total when total > 0.
  progress: z.number(),
});

const Output = z.object({
  cycles: z.array(CycleOut),
  truncated: z.boolean(),
});

// Resolve the team's current and most recent (last) cycle, then count issues by
// completion within each. Issue counts are paged and capped per cycle.
const CYCLES_QUERY = `
  query TeamCycles($teamId: String!) {
    team(id: $teamId) {
      cycles(first: 50, orderBy: updatedAt) {
        nodes {
          id
          number
          name
          startsAt
          endsAt
        }
      }
      activeCycle {
        id
      }
    }
  }
`;

const ISSUES_QUERY = `
  query CycleIssues($cycleId: ID!, $first: Int!, $after: String) {
    issues(filter: { cycle: { id: { eq: $cycleId } } }, first: $first, after: $after) {
      nodes {
        id
        state {
          type
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const MAX_PAGES = 8; // 100 issues/page → up to 800 issues counted per cycle.
const PAGE_SIZE = 100;

export const cycleStats = registerTool({
  id: 'linear.cycle_stats',
  description:
    'Cycle velocity for a team: completed vs total issues for the current and last cycle, plus progress. Use to explain sprint throughput.',
  inputSchema: z.object({ teamId: z.string().min(1) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 8 },
  handler: async (input, ctx) => {
    type CyclesR = {
      team: {
        cycles: {
          nodes: Array<{
            id: string;
            number: number;
            name: string | null;
            startsAt: string;
            endsAt: string;
          }>;
        };
        activeCycle: { id: string } | null;
      };
    };
    const cyclesData = await linearFetch<CyclesR>(ctx, CYCLES_QUERY, { teamId: input.teamId });
    const activeId = cyclesData.team.activeCycle?.id ?? null;

    // Pick current cycle (active) and the most recent prior cycle by number.
    const sorted = [...cyclesData.team.cycles.nodes].sort((a, b) => b.number - a.number);
    const current = activeId
      ? sorted.find((c) => c.id === activeId) ?? sorted[0]
      : sorted[0];
    const last = current ? sorted.find((c) => c.number < current.number) : undefined;
    const scope = [current, last].filter((c): c is NonNullable<typeof c> => Boolean(c));

    let truncated = false;
    type IssuesR = {
      issues: {
        nodes: Array<{ id: string; state: { type: string } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    const cycles: z.infer<typeof CycleOut>[] = [];
    for (const cycle of scope) {
      let total = 0;
      let completed = 0;
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data: IssuesR = await linearFetch<IssuesR>(ctx, ISSUES_QUERY, {
          cycleId: cycle.id,
          first: PAGE_SIZE,
          after,
        });
        for (const n of data.issues.nodes) {
          total += 1;
          if (n.state.type === 'completed') completed += 1;
        }
        if (!data.issues.pageInfo.hasNextPage) break;
        after = data.issues.pageInfo.endCursor;
        if (page === MAX_PAGES - 1 && data.issues.pageInfo.hasNextPage) {
          truncated = true;
          ctx.logger.info(
            { tool: 'linear.cycle_stats', cycleId: cycle.id, maxPages: MAX_PAGES, counted: total },
            'linear.cycle_stats hit page cap; counts truncated',
          );
        }
      }
      cycles.push({
        id: cycle.id,
        number: cycle.number,
        name: cycle.name ?? null,
        startsAt: cycle.startsAt,
        endsAt: cycle.endsAt,
        isCurrent: cycle.id === activeId,
        total,
        completed,
        progress: total > 0 ? completed / total : 0,
      });
    }

    return { cycles, truncated };
  },
});
