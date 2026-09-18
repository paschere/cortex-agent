import { z } from 'zod';

// TypeSafe HTTP contract: https://docs.typesafe.ai/api (2026-09-18).
// Deliberately opt-in: adding a key alone must not send company data to a new provider.
export function jevEnabled(
  feature: 'web_search' | 'browser_repair' | 'browser_navigation',
): boolean {
  const flag = `JEV_${feature.toUpperCase()}`;
  return process.env[flag] === 'on' && Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('noul'), noul: probability }),
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        confidence: probability,
        probabilities: z.record(probability),
      }),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

/** No retries, response bodies in logs, credentials in URLs, or custom endpoints. */
export async function evaluateJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<z.infer<typeof responseSchema> | null> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key || signal?.aborted) return null;
  const body = JSON.stringify({ model: process.env.JEV_MODEL || 'jev-latest', state, questions });
  if (body.length > 80_000 || Object.keys(questions).length > 20) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 2000);
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    for (const [id, question] of Object.entries(questions)) {
      const answer = parsed.data.answers[id];
      if (!answer || answer.type !== question.type) return null;
      if (question.type === 'choice' && answer.type === 'choice') {
        const keys = Object.keys(question.criteria);
        if (
          !Object.hasOwn(question.criteria, answer.choice) ||
          keys.length !== Object.keys(answer.probabilities).length ||
          keys.some((option) => !Object.hasOwn(answer.probabilities, option)) ||
          Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02
        )
          return null;
      }
    }
    return parsed.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
