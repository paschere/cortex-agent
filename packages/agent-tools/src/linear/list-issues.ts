import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      priority: z.number(),
      state: z.object({ name: z.string(), type: z.string() }),
      assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
  truncated: z.boolean(),
});

// Cursor-paged. Capped so a large team can't run away; truncation is surfaced
// in the output and logged via ctx.logger rather than silently dropped.
const MAX_PAGES = 10; // 50 issues/page → up to 500 issues.
const PAGE_SIZE = 50;

const QUERY = `
  query Issues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        priority
        state {
          name
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

export const listIssues = registerTool({
  id: 'linear.list_issues',
  description:
    'List Linear issues with optional filters (teamId, cycleId, assigneeId, stateType). stateType is the workflow category: backlog, unstarted, started, completed, or canceled. Returns up to 500 issues; sets truncated=true if more exist.',
  inputSchema: z.object({
    teamId: z.string().optional(),
    cycleId: z.string().optional(),
    assigneeId: z.string().optional(),
    stateType: z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']).optional(),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const filter: Record<string, unknown> = {};
    if (input.teamId) filter.team = { id: { eq: input.teamId } };
    if (input.cycleId) filter.cycle = { id: { eq: input.cycleId } };
    if (input.assigneeId) filter.assignee = { id: { eq: input.assigneeId } };
    if (input.stateType) filter.state = { type: { eq: input.stateType } };

    type Node = {
      id: string;
      identifier: string;
      title: string;
      priority: number;
      state: { name: string; type: string };
      assignee: { id: string; name: string } | null;
    };
    type R = {
      issues: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    };

    const issues: z.infer<typeof Output>['issues'] = [];
    let after: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: R = await linearFetch<R>(ctx, QUERY, {
        filter,
        first: PAGE_SIZE,
        after,
      });
      for (const n of data.issues.nodes) {
        issues.push({
          id: n.id,
          identifier: n.identifier,
          title: n.title,
          priority: n.priority,
          state: { name: n.state.name, type: n.state.type },
          assignee: n.assignee ? { id: n.assignee.id, name: n.assignee.name } : null,
        });
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
      if (page === MAX_PAGES - 1 && data.issues.pageInfo.hasNextPage) {
        truncated = true;
        ctx.logger.info(
          { tool: 'linear.list_issues', maxPages: MAX_PAGES, fetched: issues.length },
          'linear.list_issues hit page cap; results truncated',
        );
      }
    }

    return { issues, truncated };
  },
});
