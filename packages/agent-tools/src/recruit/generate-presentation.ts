import { z } from "zod";
import { registerTool } from "../index";
import { matcherFetch } from "./client";
import {
  SOURCE,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
} from "./shape";

export const generatePresentation = registerTool({
  id: "recruit.generate_presentation",
  description:
    "Generate an AI-written candidate presentation (Cortex-format HTML) from the candidate's skills, experience, education and latest score insights. This CREATES/updates a stored presentation (version-bumped, createdBy='AI') and therefore requires confirmation. It produces no file and nothing anyone can be sent — if the user wants something to hand to a client, use presentations.create_pdf, which writes the draft itself when there is not one yet and comes back with a download link. Use THIS tool only to refresh the stored draft on its own; to just read an existing one, use recruit.get_presentation. " +
    "The HTML body is not returned (it is tens of thousands of characters) — you get the version, size and timestamps back; pass includeHtml if you genuinely need to quote the document. " +
    "PROVENANCE: the resulting document is AI-written and unreviewed. Say so when you hand it over — never present it as a recruiter-authored or client-approved write-up.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    jobId: z.string().optional(),
    includeHtml: z.boolean().default(false),
  }),
  outputSchema: z.object({
    presentation: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input) => {
    // Endpoint takes the candidateId path param only (no body); jobId is unused server-side.
    const data = await matcherFetch(
      `/api/candidates/${encodeURIComponent(input.candidateId)}/presentation/generate`,
      { method: "POST" },
    );
    const p = data?.presentation ?? null;
    const htmlChars =
      typeof p?.htmlContent === "string" ? p.htmlContent.length : 0;

    const presentation = p
      ? {
          id: p.id ?? null,
          candidateId: input.candidateId,
          version: p.version ?? null,
          createdBy: p.createdBy ?? "AI",
          lastEditedBy: p.lastEditedBy ?? "AI",
          updatedAt: p.updatedAt ?? null,
          htmlChars,
          ...(input.includeHtml ? { htmlContent: p.htmlContent ?? null } : {}),
          source: {
            origin: SOURCE.aiScoring,
            readFrom: SOURCE.matcher,
            lastUpdatedAt: p.updatedAt ?? null,
          },
          links: { matcher: matcherLink(`/candidates/${input.candidateId}`) },
        }
      : null;

    const meta = buildMeta({
      endpoint: `/api/candidates/${input.candidateId}/presentation/generate`,
      returned: presentation ? 1 : 0,
      truncated: !!(htmlChars && !input.includeHtml),
      provenance: {
        "presentation text": `${SOURCE.aiScoring} — AI-written from the candidate's matcher profile and latest score insights`,
        "version, timestamps": `${SOURCE.matcher} — stored presentation record`,
      },
      dataQuality: [
        "This document was just written by AI and has not been reviewed by a recruiter or seen by the client.",
        ...(htmlChars && !input.includeHtml
          ? [
              `The HTML body (${htmlChars} chars) was omitted; pass includeHtml to read it.`,
            ]
          : []),
      ],
    });

    const markdown = presentation
      ? [
          `**Presentation generated for candidate \`${input.candidateId}\`** — version ${presentation.version ?? "N/A"}, ${htmlChars} characters, written by AI.`,
          `Last updated ${presentation.updatedAt ?? "just now"}. It has not been reviewed by a human yet.`,
          "",
          provenanceFooter(meta),
        ].join("\n")
      : [
          `Presentation generation for candidate \`${input.candidateId}\` returned no presentation. Response: ${JSON.stringify(data).slice(0, 200)}`,
          "",
          provenanceFooter(meta),
        ].join("\n");

    return { presentation, meta, markdown };
  },
});
