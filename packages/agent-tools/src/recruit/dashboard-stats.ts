import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const dashboardStats = registerTool({
  id: 'recruit.dashboard_stats',
  description:
    'Get the global recruitment dashboard statistics from the zipdev-matcher: active candidates, open positions, AI scoring accuracy, interview success, presentation totals, pipeline health by stage, top in-demand skills, and recent activity. Use for an at-a-glance health check of the whole recruitment funnel.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    stats: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async () => {
    const stats = await matcherFetch('/api/dashboard/stats', { method: 'GET' });

    const parts: string[] = ['### Recruitment dashboard'];
    const m = stats?.metrics;
    if (m) {
      if (m.activeCandidates)
        parts.push(
          `- Active candidates: ${m.activeCandidates.total} (new today: ${m.activeCandidates.newToday})`,
        );
      if (m.openPositions)
        parts.push(`- Open positions: ${m.openPositions.total} (urgent: ${m.openPositions.urgent})`);
      if (m.aiAccuracy) parts.push(`- AI accuracy: ${m.aiAccuracy.percentage}%`);
      if (m.interviewSuccess) parts.push(`- Interview success: ${m.interviewSuccess.percentage}%`);
    }
    const p = stats?.presentations;
    if (p) {
      parts.push(
        `- Presentations: ${p.total} total (pending ${p.pending}, accepted ${p.accepted}, rejected ${p.rejected})`,
      );
    }
    if (stats?.pipeline && typeof stats.pipeline === 'object') {
      const stages = Object.entries(stats.pipeline)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      if (stages) parts.push(`\n**Pipeline**\n${stages}`);
    }
    if (Array.isArray(stats?.topSkills) && stats.topSkills.length) {
      const skills = stats.topSkills
        .map((s: any) => `${s.name} (${s.demand_count})`)
        .join(', ');
      parts.push(`\n**Top skills**: ${skills}`);
    }

    return { stats, markdown: parts.join('\n') };
  },
});
