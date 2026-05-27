const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents';

const BATCH_SIZE = 100;

interface BatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

/**
 * Embed an array of texts using Gemini text-embedding-004.
 * Batches up to 100 texts per request.
 * Returns an array of 768-dimensional vectors in the same order as input.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];

  const key = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: batch.map((t) => ({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: t }] },
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Embed request failed ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as BatchEmbedResponse;
    for (const embedding of data.embeddings) {
      results.push(embedding.values);
    }
  }

  return results;
}
