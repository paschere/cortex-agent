import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const AssigneeOut = z.object({
  assigneeId: z.string(),
  name: z.string(),
  total: z.number(),
  // WIP = issues whose workflow state type is 'started' (in progress).
  wip: z.number(),
});

const Output = z.object({
  assignees: z.array(AssigneeOut),
  unassigned: z.number(),
  truncated: z.boolean(),
});

// Count open (non-completed, non-canceled) issues per assignee for a team to
// show load per person. Paged and capped; truncation is logged, never silent.
const QUERY = `
  query TeamWorkload($teamId: ID!, $first: Int!, $after: String) {
    issues(
      filter: {
        team: { id: { eq: $teamId } }
        state: { type: { nin: ["completed", "canceled"] } }
      }
      first: $first
      after: $after
    ) {
      nodes {
        id
        state {
          type
        }
        assignee {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const MAX_PAGES = 10; // 100 issues/page → up to 1000 open issues aggregated.
const PAGE_SIZE = 100;

export const workloadStats = registerTool({
  id: 'linear.workload_stats',
  description:
    'Workload per assignee for a team: count of open issues and how many are in progress (WIP) per person, plus unassigned count. Use to spot overloaded teammates.',
  inputSchema: z.object({ teamId: z.string().min(1) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 8 },
  handler: async (input, ctx) => {
    type R = {
      issues: {
        nodes: Array<{
          id: string;
          state: { type: string };
          assignee: { id: string; name: string } | null;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    const byAssignee = new Map<string, { name: string; total: number; wip: number }>();
    let unassigned = 0;
    let after: string | null = null;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data: R = await linearFetch<R>(ctx, QUERY, {
        teamId: input.teamId,
        first: PAGE_SIZE,
        after,
      });
      for (const n of data.issues.nodes) {
        if (!n.assignee) {
          unassigned += 1;
          continue;
        }
        const entry = byAssignee.get(n.assignee.id) ?? { name: n.assignee.name, total: 0, wip: 0 };
        entry.total += 1;
        if (n.state.type === 'started') entry.wip += 1;
        byAssignee.set(n.assignee.id, entry);
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
      if (page === MAX_PAGES - 1 && data.issues.pageInfo.hasNextPage) {
        truncated = true;
        ctx.logger.info(
          { tool: 'linear.workload_stats', teamId: input.teamId, maxPages: MAX_PAGES },
          'linear.workload_stats hit page cap; counts truncated',
        );
      }
    }

    const assignees = [...byAssignee.entries()]
      .map(([assigneeId, v]) => ({ assigneeId, name: v.name, total: v.total, wip: v.wip }))
      .sort((a, b) => b.total - a.total);

    return { assignees, unassigned, truncated };
  },
});
