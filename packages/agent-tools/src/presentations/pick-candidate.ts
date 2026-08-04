import { z } from "zod";
import { registerTool } from "../index";
import { internalFetch, matcherFetch, qs } from "../recruit/client";
import {
  SOURCE,
  type ToolMeta,
  buildMeta,
  matcherLink,
  metaFromServer,
  metaSchema,
  provenanceFooter,
} from "../recruit/shape";
import { type StoredPresentation, tryReadPresentation } from "./client";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/**
 * Presentation status is one extra matcher round-trip PER CANDIDATE (the
 * matcher has no bulk "who already has a write-up" endpoint), so it is capped
 * and run in a small pool. Above the cap the flag comes back as 'unknown'
 * rather than making the picker slow enough to feel broken.
 */
const STATUS_LOOKUP_CAP = 25;
const STATUS_CONCURRENCY = 5;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

type PresentationStatus =
  | { state: "none" }
  | { state: "unknown" }
  | {
      state: "exists";
      version: number | null;
      author: string | null;
      humanReviewed: boolean;
      updatedAt: string | null;
    };

function statusFrom(p: StoredPresentation | null): PresentationStatus {
  if (!p) return { state: "none" };
  return {
    state: "exists",
    version: p.version,
    author: p.createdBy,
    // A draft still marked AI on both fields has never been touched by a person.
    humanReviewed: !!p.lastEditedBy && p.lastEditedBy !== "AI",
    updatedAt: p.updatedAt,
  };
}

function statusLabel(s: PresentationStatus): string {
  if (s.state === "none") return "none yet";
  if (s.state === "unknown") return "not checked";
  const when = s.updatedAt ? String(s.updatedAt).slice(0, 10) : "unknown date";
  return `v${s.version ?? "?"} · ${when}${s.humanReviewed ? " · reviewed" : " · AI, unreviewed"}`;
}

function score(v: unknown): string {
  return typeof v === "number" ? String(Math.round(v)) : "—";
}

/** The lean endpoint sends `name`; the legacy public one sends first/last. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function displayName(c: any): string | null {
  if (typeof c?.name === "string" && c.name.trim()) return c.name.trim();
  const joined = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();
  return joined || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(rows: any[], jobLabel: string, meta: ToolMeta): string {
  if (rows.length === 0) {
    return [
      `There are no candidates on ${jobLabel} yet, so there is nobody to prepare a presentation for.`,
      "",
      provenanceFooter(meta),
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(
    `**Candidates on ${jobLabel}** — ${rows.length} shown, best match first.`,
  );
  lines.push("");
  lines.push("| # | Candidate | Stage | Match | Experience | Presentation |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.name ?? "(unnamed)"} | ${r.stage ?? "—"} | ${score(r.matchScore)} | ${
        r.experienceYears != null ? `${r.experienceYears}y` : "—"
      } | ${statusLabel(r.presentation as PresentationStatus)} |`,
    );
  });
  lines.push("");
  lines.push(
    "Ask the user which of these people they want the presentation for before creating anything.",
  );
  lines.push("");
  lines.push(provenanceFooter(meta));
  return lines.join("\n");
}

export const pickCandidate = registerTool({
  id: "presentations.pick_candidate",
  description:
    'Show who is on a requisition so you can ask the user WHICH person they want a presentation for. This is the step before presentations.create_pdf whenever the request names a role rather than a person — "prepare a presentation for the .NET opening", "send the client someone for the backend role". ' +
    "Returns one compact row per candidate: name, pipeline stage, match score, years of experience, and whether a presentation already exists (with its version, date, and whether a human has reviewed it or it is still the raw AI draft). Read-only — it creates nothing and costs the user nothing. " +
    'HOW TO USE IT IN CONVERSATION: resolve the role first (recruit.list_requisitions), call this, then ask the user to choose in plain language — "I have four people on that role: Ana, Luis, Marta and Diego. Ana and Luis already have a write-up from last week. Who should I prepare?" Never read out ids, scores nobody asked for, or the name of this step. If someone already has a presentation, say so and offer to reuse it rather than silently rewriting it. ' +
    'Capped at 50 rows (default 10); check meta.truncated before implying this is the whole pipeline. Presentation status is only looked up for the first 25 rows — beyond that it reads "not checked", which is not the same as "none". ' +
    "PROVENANCE: candidates and stages come from the Cortex matcher; match scores are Cortex AI output, not an ATS field; presentation drafts are AI-written unless a recruiter has edited them.",
  inputSchema: z.object({
    jobId: z
      .string()
      .min(1)
      .describe("The requisition to list candidates for."),
    stage: z
      .string()
      .optional()
      .describe(
        "Optional pipeline stage filter, e.g. CLIENT_MANAGER or RECRUITER_INTERVIEW.",
      ),
    minScore: z.number().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
    includePresentationStatus: z
      .boolean()
      .default(true)
      .describe(
        "Set false to skip the per-candidate presentation lookup and answer faster.",
      ),
  }),
  outputSchema: z.object({
    job: z.any(),
    candidates: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;

    const query = qs({
      jobId: input.jobId,
      stage: input.stage,
      minScore: input.minScore,
      sort: "score",
      limit,
      offset,
    });

    const lean = await internalFetch<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any;
    }>(`/api/internal/recruit/candidates${query}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let job: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any[] = [];
    let meta: ToolMeta;

    if (lean.available) {
      job = lean.data.job ?? null;
      raw = lean.data.candidates ?? [];
      meta = metaFromServer(lean.data.meta, "/api/internal/recruit/candidates");
    } else {
      // Fallback to the fat public list. It carries resumes and raw scoring
      // JSON, so only the four fields the picker shows are kept.
      const data = await matcherFetch(
        `/api/candidates?jobId=${encodeURIComponent(input.jobId)}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let all: any[] = Array.isArray(data) ? data : (data?.candidates ?? []);
      if (input.stage) {
        const s = input.stage.toUpperCase();
        all = all.filter((c) => String(c?.status ?? "").toUpperCase() === s);
      }
      if (input.minScore != null) {
        all = all.filter(
          (c) =>
            typeof c?.matchScore === "number" &&
            c.matchScore >= (input.minScore as number),
        );
      }
      const totalAvailable = all.length;
      raw = all.slice(offset, offset + limit);
      job = { id: input.jobId, title: null };
      meta = buildMeta({
        endpoint: "/api/candidates",
        degraded: true,
        degradedReason: lean.reason,
        totalAvailable,
        returned: raw.length,
        limit,
        offset,
        truncated: offset + raw.length < totalAvailable,
      });
    }

    const base = raw.map((c) => ({
      candidateId: c?.candidateId ?? c?.id ?? null,
      name: displayName(c),
      stage: c?.stage ?? c?.status ?? null,
      matchScore:
        c?.scores?.combined ??
        (typeof c?.matchScore === "number" ? c.matchScore : null),
      experienceYears: c?.experienceYears ?? c?.totalExperienceYears ?? null,
      topSkills: Array.isArray(c?.topSkills) ? c.topSkills.slice(0, 6) : [],
      links: {
        matcher: c?.candidateId
          ? matcherLink(`/candidates/${c.candidateId}`)
          : null,
      },
    }));

    const statuses: PresentationStatus[] = input.includePresentationStatus
      ? await mapPool(base, STATUS_CONCURRENCY, async (row, i) => {
          if (i >= STATUS_LOOKUP_CAP || !row.candidateId)
            return { state: "unknown" as const };
          return statusFrom(await tryReadPresentation(String(row.candidateId)));
        })
      : base.map(() => ({ state: "unknown" as const }));

    const candidates = base.map((row, i) => ({
      ...row,
      presentation: statuses[i] ?? { state: "unknown" as const },
    }));

    const withPresentation = candidates.filter(
      (c) => c.presentation.state === "exists",
    ).length;
    const unreviewed = candidates.filter(
      (c) => c.presentation.state === "exists" && !c.presentation.humanReviewed,
    ).length;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = meta as any;
    m.provenance = {
      "name, stage, experienceYears": `${SOURCE.matcher} — pipeline state maintained by recruiters`,
      matchScore: `${SOURCE.aiScoring} — derived, never an ATS field`,
      "presentation.*": `${SOURCE.matcher} — stored presentation record; author "AI" means nobody has reviewed it`,
    };
    if (!input.includePresentationStatus) {
      meta.dataQuality.push(
        'Presentation status was not looked up on this call — "not checked" does not mean "none".',
      );
    } else if (candidates.length > STATUS_LOOKUP_CAP) {
      meta.dataQuality.push(
        `Presentation status was only checked for the first ${STATUS_LOOKUP_CAP} of ${candidates.length} candidates.`,
      );
    }
    if (unreviewed > 0) {
      meta.dataQuality.push(
        `${unreviewed} of the ${withPresentation} existing presentations are the raw AI draft, never reviewed by a recruiter.`,
      );
    }

    const label = job?.title ? `"${job.title}"` : "this requisition";
    return {
      job: job
        ? { id: job.id ?? input.jobId, title: job.title ?? null }
        : { id: input.jobId },
      candidates,
      meta,
      markdown: renderMarkdown(candidates, label, meta),
    };
  },
});
