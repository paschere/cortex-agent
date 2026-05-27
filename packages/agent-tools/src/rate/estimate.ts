import { z } from 'zod';
import { registerTool } from '../index';
import { callEstimator } from './client';

const MonthlyRateRange = z.object({ min: z.number(), max: z.number() });

export const rateEstimate = registerTool({
  id: 'rate.estimate',
  description:
    'Estimate monthly USD rate for a LATAM staffing role. Returns a min/max range with notes. Uses the Zipdev 2026-Q1 pricing table.',
  inputSchema: z.object({
    role: z.enum(['frontend', 'backend', 'fullstack', 'data', 'devops', 'qa', 'pm', 'designer']),
    seniority: z.enum(['junior', 'mid', 'senior', 'lead']),
    region: z.enum(['mx', 'latam', 'br', 'ar', 'co', 'cl', 'pe']),
    yearsExperience: z.number().int().min(0).max(40),
  }),
  outputSchema: z.object({
    monthlyRateUsd: MonthlyRateRange,
    notes: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => callEstimator(input, ctx),
});
