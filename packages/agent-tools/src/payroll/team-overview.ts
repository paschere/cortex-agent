import { z } from 'zod';
import { registerTool } from '../index';
import { fetchTeamOverview } from './client';
import { BAMBOO_BOUNDARY_NOTE } from './sensitive';

const ClientCount = z.object({ client: z.string(), count: z.number() });
const DivisionCount = z.object({ division: z.string(), count: z.number() });
const CurrencyCount = z.object({ currency: z.string(), count: z.number() });

export const payrollTeamOverview = registerTool({
  id: 'payroll.team_overview',
  description: [
    'Counts only, no names and no money: total active members, how many are assigned to clients, internal staff, new hires, plus breakdowns by division (Tech/Non-tech/Internal), by client, and by currency. Use it for "how many assigned team members are there" and staffing-distribution questions.',
    'Takes no filters — for a headcount narrowed to one client, division, location or job title, bamboo.headcount does that; for the list of who those people actually are, use payroll.team_assignments.',
    BAMBOO_BOUNDARY_NOTE,
  ].join(' '),
  inputSchema: z.object({}),
  outputSchema: z.object({
    asOf: z.string(),
    totals: z.object({
      totalUsers: z.number(),
      active: z.number(),
      assignedToClients: z.number(),
      internal: z.number(),
      newHires: z.number(),
    }),
    byDivision: z.array(DivisionCount),
    byClient: z.array(ClientCount),
    byCurrency: z.array(CurrencyCount),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => fetchTeamOverview(ctx),
});
