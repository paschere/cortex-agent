import { z } from "zod";
import { registerTool } from "../index";
import {
  SOURCE,
  buildMeta,
  metaSchema,
  provenanceFooter,
} from "../recruit/shape";
import {
  NoPresentationError,
  type StoredPresentation,
  readPresentation,
  renderPdf,
  writePresentation,
} from "./client";
import {
  DEFAULT_EXPIRY_DAYS,
  expiresIn,
  formatBytes,
  storePdf,
} from "./storage";

/**
 * Derive the person's name from the filename the matcher chose
 * (`Jane_Doe_Presentation.pdf`).
 *
 * The alternative is GET /api/candidates/<id>, which returns the resume text,
 * the extracted-profile JSON and the raw scoring rationale — hundreds of KB —
 * to learn two words we already have. This is only ever used as a label.
 */
function nameFromFilename(filename: string, fallback: string): string {
  const stem = filename.replace(/\.pdf$/i, "").replace(/_?Presentation$/i, "");
  const name = stem.replace(/_/g, " ").trim();
  return name || fallback;
}

export const createPdf = registerTool({
  id: "presentations.create_pdf",
  description: [
    'Produce the candidate presentation as a downloadable PDF and hand back a link the user can click. This is the deliverable behind "send me her presentation", "I need the PDF for the client", "prepare a write-up for this candidate".',
    `What it does, in order: if the candidate has no presentation yet (or regenerate is set) it has one written first, renders it to a PDF on the company letterhead, stores it, and returns a download link on our own domain that expires in ${DEFAULT_EXPIRY_DAYS} days.`,
    'BEFORE YOU CALL IT: make sure you know WHICH person. If the user named a role rather than a person, use presentations.pick_candidate first and ask them to choose. Then tell them plainly what you are about to do — "I\'ll write up Ana and turn it into a PDF, one moment" — and get their go-ahead; this step is confirmation-gated because it creates a stored document and a shareable file. If a presentation already exists, do NOT pass regenerate unless the user asked for a fresh one; reusing it is free and keeps whatever a recruiter has edited.',
    "AFTERWARDS: give them the link in plain language and say the document was written by AI and has not been reviewed, and when the link stops working. Never mention this step, the candidate id, the storage path or the token.",
    "PROVENANCE: the text is AI-written from the matcher profile and the latest scoring insights; the PDF is the branded render of exactly that stored draft, pinned at the version reported here.",
  ].join(" "),
  inputSchema: z.object({
    candidateId: z
      .string()
      .min(1)
      .describe("The person the presentation is about."),
    jobId: z
      .string()
      .optional()
      .describe(
        "The requisition this presentation is for, recorded alongside the file.",
      ),
    regenerate: z
      .boolean()
      .default(false)
      .describe(
        "Rewrite the presentation before rendering, replacing the current draft with a new AI version. Only when the user asked for it.",
      ),
  }),
  outputSchema: z.object({
    downloadUrl: z.string(),
    filename: z.string(),
    sizeBytes: z.number().int(),
    expiresAt: z.string(),
    version: z.number().int().nullable(),
    createdBy: z.string().nullable(),
    candidateName: z.string(),
    regenerated: z.boolean(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const { candidateId, jobId } = input;

    const existing = await readPresentation(candidateId);
    const mustWrite = input.regenerate || !existing;

    let presentation: StoredPresentation | null = existing;
    if (mustWrite) {
      presentation = await writePresentation(candidateId);
      if (!presentation) {
        throw new Error(
          `The matcher could not write a presentation for candidate ${candidateId}. There may not be enough profile data yet.`,
        );
      }
    }

    let rendered: Awaited<ReturnType<typeof renderPdf>>;
    try {
      rendered = await renderPdf(candidateId, jobId);
    } catch (err) {
      // Only reachable when the draft vanished between the read and the render.
      if (err instanceof NoPresentationError) {
        throw new Error(
          `There is no presentation to turn into a PDF for candidate ${candidateId}. Re-run with regenerate to have one written first.`,
        );
      }
      throw err;
    }

    const candidateName = nameFromFilename(rendered.filename, "This candidate");

    const stored = await storePdf(ctx, {
      candidateId,
      candidateName,
      jobId: jobId ?? null,
      version: presentation?.version ?? null,
      filename: rendered.filename,
      bytes: rendered.bytes,
    });

    const humanReviewed =
      !!presentation?.lastEditedBy && presentation.lastEditedBy !== "AI";

    const meta = buildMeta({
      endpoint: `/api/candidates/${candidateId}/presentation/export`,
      returned: 1,
      version: presentation?.version ?? null,
      regenerated: mustWrite,
      provenance: {
        "presentation text": `${SOURCE.aiScoring} — AI-written from the candidate's matcher profile and latest score insights`,
        "PDF layout": `${SOURCE.matcher} — rendered by the matcher service's letterhead export`,
        "download link":
          "Cortex — stored in private storage, link expires",
      },
      dataQuality: [
        humanReviewed
          ? `This presentation was last edited by ${presentation?.lastEditedBy}; the underlying draft is still AI-written.`
          : "This document was written by AI and has NOT been reviewed by a recruiter. Say so when you hand it over.",
        `The download link stops working ${expiresIn(stored.expiresAt)} (${stored.expiresAt}). Anyone holding the link can download the file — treat it as confidential.`,
      ],
    });

    const markdown = [
      `[Download ${candidateName} — presentation.pdf](${stored.downloadUrl})`,
      "",
      `${formatBytes(stored.sizeBytes)} · version ${presentation?.version ?? "?"}${
        mustWrite ? " (just written)" : ""
      } · link expires ${expiresIn(stored.expiresAt)}.`,
      humanReviewed
        ? "_Written by AI and edited by a recruiter — worth a last read before it goes to the client._"
        : "_Written by AI and not yet reviewed by anyone — read it before sending it to a client._",
      "",
      provenanceFooter(meta),
    ].join("\n");

    ctx.logger.info(
      {
        candidateId,
        version: presentation?.version ?? null,
        sizeBytes: stored.sizeBytes,
        storagePath: stored.storagePath,
      },
      "presentations.create_pdf stored a presentation PDF",
    );

    return {
      downloadUrl: stored.downloadUrl,
      filename: stored.filename,
      sizeBytes: stored.sizeBytes,
      expiresAt: stored.expiresAt,
      version: presentation?.version ?? null,
      createdBy: presentation?.createdBy ?? null,
      candidateName,
      regenerated: mustWrite,
      meta,
      markdown,
    };
  },
});
