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

export const getPresentation = registerTool({
  id: "recruit.get_presentation",
  description:
    "Get the latest stored candidate presentation for a candidate, if one exists. Returns its version, who wrote and last edited it, when it was last updated and how large it is — but NOT the HTML body by default, because a presentation runs to tens of thousands of characters and a model rarely needs the markup. Pass includeHtml only when you must read or quote the document itself. " +
    "A null presentation is normal, not an error: it means none has been created yet. Read-only — use recruit.generate_presentation to create one. " +
    "PROVENANCE: presentations are stored in the Cortex matcher DB; `createdBy` / `lastEditedBy` tell you whether the text was AI-written or edited by a human, and `updatedAt` how fresh it is. Say which when you describe it.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    includeHtml: z.boolean().default(false),
  }),
  outputSchema: z.object({
    presentation: z.any().nullable(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const data = await matcherFetch(
      `/api/candidates/${encodeURIComponent(input.candidateId)}/presentation`,
    );
    const p = data?.presentation ?? null;
    const htmlChars =
      typeof p?.htmlContent === "string" ? p.htmlContent.length : 0;

    const presentation = p
      ? {
          id: p.id ?? null,
          candidateId: input.candidateId,
          jobId: p.jobId ?? null,
          version: p.version ?? null,
          createdBy: p.createdBy ?? null,
          lastEditedBy: p.lastEditedBy ?? null,
          createdAt: p.createdAt ?? null,
          updatedAt: p.updatedAt ?? null,
          presentedToCompany: p.presentedToCompany ?? false,
          presentedAt: p.presentedAt ?? null,
          companyDecision: p.companyDecision ?? null,
          clientSentiment: p.clientSentiment ?? null,
          billRate: p.billRate ?? null,
          pdfUrl: p.pdfUrl ?? null,
          htmlChars,
          ...(input.includeHtml ? { htmlContent: p.htmlContent ?? null } : {}),
          source: {
            origin: p.createdBy === "AI" ? SOURCE.aiScoring : SOURCE.matcher,
            readFrom: SOURCE.matcher,
            lastUpdatedAt: p.updatedAt ?? null,
          },
          links: { matcher: matcherLink(`/candidates/${input.candidateId}`) },
        }
      : null;

    const meta = buildMeta({
      endpoint: `/api/candidates/${input.candidateId}/presentation`,
      returned: presentation ? 1 : 0,
      truncated: !!(htmlChars && !input.includeHtml),
      provenance: {
        "version, createdBy, lastEditedBy, updatedAt": `${SOURCE.matcher} — stored presentation record`,
        "companyDecision, clientSentiment, billRate": `${SOURCE.matcher} — recorded from the client's review`,
        htmlContent:
          'AI-written by default (createdBy "AI"), then optionally edited by a recruiter',
      },
      dataQuality: [
        ...(htmlChars && !input.includeHtml
          ? [
              `The HTML body (${htmlChars} chars) was omitted; pass includeHtml to read it.`,
            ]
          : []),
        ...(p && p.createdBy === "AI" && !p.lastEditedBy
          ? [
              "This presentation is AI-written and has not been reviewed by a human.",
            ]
          : []),
      ],
    });

    const markdown = presentation
      ? [
          `**Presentation for candidate \`${input.candidateId}\`** — version ${presentation.version ?? "N/A"} (created by ${presentation.createdBy ?? "N/A"}, last edited by ${presentation.lastEditedBy ?? "N/A"}).`,
          `Document is ${htmlChars} characters${presentation.presentedToCompany ? `, presented to the client${presentation.presentedAt ? ` on ${String(presentation.presentedAt).slice(0, 10)}` : ""}` : ", not yet presented to the client"}. Last updated ${presentation.updatedAt ?? "N/A"}.`,
          "",
          provenanceFooter(meta),
        ].join("\n")
      : [
          `No presentation exists yet for candidate \`${input.candidateId}\`. Use recruit.generate_presentation to create one.`,
          "",
          provenanceFooter(meta),
        ].join("\n");

    return { presentation, meta, markdown };
  },
});
