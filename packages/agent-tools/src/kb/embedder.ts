const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

const BATCH_SIZE = 100;

/**
 * Must match the pgvector column dimension (vector(768) in 0003_kb.sql).
 * gemini-embedding-001 natively outputs 3072 dims; we request 768 via
 * outputDimensionality. Truncated outputs are NOT L2-normalized by the API,
 * so we normalize here — cosine search (<=>) is scale-invariant, but this
 * keeps the vectors safe for any future dot-product use.
 */
const DIMENSIONS = 768;

interface BatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

function l2Normalize(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

/**
 * Embed an array of texts using Gemini gemini-embedding-001 (successor to the
 * retired text-embedding-004). Batches up to 100 texts per request.
 * Returns an array of 768-dimensional unit vectors in the same order as input.
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
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: t }] },
          outputDimensionality: DIMENSIONS,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Embed request failed ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as BatchEmbedResponse;
    for (const embedding of data.embeddings) {
      results.push(l2Normalize(embedding.values));
    }
  }

  return results;
}
