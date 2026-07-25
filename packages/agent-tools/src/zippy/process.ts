import { IntegrationError, ValidationError } from '@zipdev/core';
import { z } from 'zod';
import { registerTool } from '../index';

/**
 * zippy.process — server-side delegation to Zippy's own LLM (Gemini).
 *
 * Context offloading: instead of pulling a large document (or blob of text)
 * into the CALLING model's context, the heavy content is processed here — on
 * Zipdev's side, with Zipdev's model and keys — and only the distilled result
 * travels back. From Claude's perspective it is one tool call; the tokens the
 * source material consumes never leave Zippy.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_SOURCE_CHARS = 400_000;

export const zippyProcess = registerTool({
  id: 'zippy.process',
  description:
    "Delegate heavy text processing to Zippy's own server-side LLM instead of doing it yourself: summarize, extract structured data, classify, translate, or answer questions about a large source WITHOUT loading it into your context. Provide either documentId (a Knowledge Base document — Zippy reads all its chunks server-side) or content (raw text). Returns only the distilled result. Use this whenever the source material is large and you only need the analysis.",
  inputSchema: z.object({
    instruction: z
      .string()
      .min(5)
      .max(4000)
      .describe('What to do with the source, e.g. "Extract every rate mentioned, as a JSON array of {role, rate}"'),
    documentId: z
      .string()
      .uuid()
      .optional()
      .describe('KB document id — Zippy loads its full text server-side'),
    content: z.string().max(MAX_SOURCE_CHARS).optional().describe('Raw text to process (alternative to documentId)'),
    maxOutputChars: z.number().int().min(100).max(20000).default(4000),
  }),
  outputSchema: z.object({
    result: z.string(),
    sourceChars: z.number(),
    documentTitle: z.string().nullable(),
    model: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) throw new IntegrationError('GOOGLE_GENERATIVE_AI_API_KEY not configured', 'gemini');

    let source = input.content ?? '';
    let documentTitle: string | null = null;

    if (input.documentId) {
      const { data: doc } = await ctx.db
        .from('kb_documents')
        .select('title')
        .eq('id', input.documentId)
        .maybeSingle();
      if (!doc) throw new ValidationError(`KB document not found: ${input.documentId}`);
      documentTitle = doc.title as string;

      const { data: chunks, error } = await ctx.db
        .from('kb_chunks')
        .select('content, chunk_index')
        .eq('document_id', input.documentId)
        .order('chunk_index', { ascending: true });
      if (error) throw new Error(`Failed to load chunks: ${error.message}`);
      source = (chunks ?? []).map((c) => c.content as string).join('\n\n');
    }

    if (!source.trim()) {
      throw new ValidationError('Provide documentId or non-empty content.');
    }
    if (source.length > MAX_SOURCE_CHARS) source = source.slice(0, MAX_SOURCE_CHARS);

    const prompt =
      `You are Zippy, Zipdev's internal processing engine. Follow the instruction precisely and answer with ONLY the requested output — no preamble.\n\n` +
      `INSTRUCTION:\n${input.instruction}\n\n` +
      `SOURCE${documentTitle ? ` (document: "${documentTitle}")` : ''}:\n${source}`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: ctx.signal,
      },
    );
    if (!r.ok) throw new IntegrationError(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`, 'gemini');

    type GenerateResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const data = (await r.json()) as GenerateResponse;
    const text = (data.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new IntegrationError('Gemini returned an empty response', 'gemini');

    const max = input.maxOutputChars ?? 4000;
    return {
      result: text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text,
      sourceChars: source.length,
      documentTitle,
      model: GEMINI_MODEL,
    };
  },
});
