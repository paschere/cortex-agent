import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const ENDPOINT = 'https://api.linear.app/graphql';

/**
 * POST a GraphQL query/mutation to the Linear API and return the unwrapped
 * `data` payload. Token via ctx.integrations.getAccessToken('linear'). Maps 401
 * and GraphQL `errors` to IntegrationError.
 */
export async function linearFetch<T>(
  ctx: ToolContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('linear');
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('Linear 401', 'linear');
  if (!r.ok) throw new IntegrationError(`Linear ${r.status}: ${await r.text()}`, 'linear');
  const json = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new IntegrationError(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`, 'linear');
  }
  return json.data as T;
}
