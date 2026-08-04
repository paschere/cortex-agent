import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

export interface EstimateInput {
  role: string;
  seniority: 'junior' | 'mid' | 'senior' | 'lead';
  region: 'mx' | 'latam' | 'br' | 'ar' | 'co' | 'cl' | 'pe';
  yearsExperience: number;
  /** Percentage. Omitted lets the estimator apply the company's standard margin. */
  margin?: number;
}

export interface EstimateOutput {
  monthlyRateUsd: { min: number; max: number };
  notes: string;
}

export async function callEstimator(
  body: EstimateInput,
  ctx: ToolContext,
): Promise<EstimateOutput> {
  const url = `${process.env.RATE_ESTIMATOR_URL}/api/internal/estimate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RATE_ESTIMATOR_SERVICE_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!r.ok) {
    throw new IntegrationError(`Rate estimator ${r.status}: ${await r.text()}`, 'rate-estimator');
  }
  return r.json() as Promise<EstimateOutput>;
}
