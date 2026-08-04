import { IntegrationError, ValidationError } from "@cortex/core";
import { generateText } from "ai";
import { z } from "zod";
import { registerTool } from "../index";
import { getVisibleDocument } from "../kb/spaces";
import { UTILITY_MODEL, utilityModel } from "../model";

/**
 * cortex.process — server-side delegation to Cortex's own LLM.
 *
 * Context offloading: instead of pulling a large document (or blob of text)
 * into the CALLING model's context, the heavy content is processed here — on
 * Cortex's side, with Cortex's model and keys — and only the distilled result
 * travels back. From the caller's perspective it is one tool call; the tokens
 * the source material consumes never leave Cortex.
 */

const MAX_SOURCE_CHARS = 400_000;

export const cortexProcess = registerTool({
  id: "cortex.process",
  description:
    "Delegate heavy text processing to Cortex's own server-side LLM instead of doing it yourself: summarize, extract structured data, classify, translate, or answer questions about a large source WITHOUT loading it into your context. Provide either documentId (a Knowledge Base document — Cortex reads all its chunks server-side) or content (raw text). Returns only the distilled result. Use this whenever the source material is large and you only need the analysis.",
  inputSchema: z.object({
    instruction: z
      .string()
      .min(5)
      .max(4000)
      .describe(
        'What to do with the source, e.g. "Extract every rate mentioned, as a JSON array of {role, rate}"',
      ),
    documentId: z
      .string()
      .uuid()
      .optional()
      .describe("KB document id — Cortex loads its full text server-side"),
    content: z
      .string()
      .max(MAX_SOURCE_CHARS)
      .optional()
      .describe("Raw text to process (alternative to documentId)"),
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
    if (!process.env.ANTHROPIC_API_KEY)
      throw new IntegrationError(
        "ANTHROPIC_API_KEY not configured",
        "anthropic",
      );

    let source = input.content ?? "";
    let documentTitle: string | null = null;

    if (input.documentId) {
      // This is a second door into the Knowledge Base: it reads a document's
      // ENTIRE text from an id, without going through search. Search hits hand
      // out document ids, so without this check an id seen once would be enough
      // to read a document out of a space the caller cannot see. getVisibleDocument
      // reports someone else's document as missing rather than as forbidden.
      const doc = await getVisibleDocument(
        ctx.db,
        ctx.userId,
        input.documentId,
      );
      documentTitle = doc.title;

      const { data: chunks, error } = await ctx.db
        .from("kb_chunks")
        .select("content, chunk_index")
        .eq("document_id", input.documentId)
        .order("chunk_index", { ascending: true });
      if (error) throw new Error(`Failed to load chunks: ${error.message}`);
      source = (chunks ?? []).map((c) => c.content as string).join("\n\n");
    }

    if (!source.trim()) {
      throw new ValidationError("Provide documentId or non-empty content.");
    }
    if (source.length > MAX_SOURCE_CHARS)
      source = source.slice(0, MAX_SOURCE_CHARS);

    const sourceLabel = documentTitle ? ` (document: "${documentTitle}")` : "";
    const prompt = `You are Cortex, the company's internal processing engine. Follow the instruction precisely and answer with ONLY the requested output — no preamble.\n\nINSTRUCTION:\n${input.instruction}\n\nSOURCE${sourceLabel}:\n${source}`;

    // No `temperature`: Claude Opus 5 rejects sampling parameters outright
    // (400). Determinism comes from the instruction, not from the knob.
    let text: string;
    try {
      const generated = await generateText({
        model: utilityModel(),
        prompt,
        // The caller caps the answer in characters; give the model enough
        // tokens to reach that cap, since thinking counts against the budget.
        maxTokens: 8_000,
        abortSignal: ctx.signal,
      });
      text = generated.text.trim();
    } catch (err) {
      throw new IntegrationError(
        `Claude request failed: ${err instanceof Error ? err.message : String(err)}`,
        "anthropic",
      );
    }
    if (!text)
      throw new IntegrationError(
        "Claude returned an empty response",
        "anthropic",
      );

    const max = input.maxOutputChars ?? 4000;
    return {
      result: text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text,
      sourceChars: source.length,
      documentTitle,
      model: UTILITY_MODEL,
    };
  },
});
