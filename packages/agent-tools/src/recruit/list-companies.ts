import { z } from "zod";
import { registerTool } from "../index";
import { internalFetch, matcherFetch, qs } from "./client";
import {
  SOURCE,
  type ToolMeta,
  buildMeta,
  matcherLink,
  metaFromServer,
  metaSchema,
  provenanceFooter,
} from "./shape";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(companies: any[], meta: ToolMeta): string {
  if (companies.length === 0)
    return ["No clients matched.", "", provenanceFooter(meta)].join("\n");
  const lines: string[] = [];
  lines.push(`**${companies.length} client(s)**`);
  lines.push("");
  lines.push(
    "| Client | Industry | Requisitions (open/total) | Candidates in pipelines |",
  );
  lines.push("| --- | --- | --- | --- |");
  for (const c of companies) {
    const r = c.requisitions ?? {};
    lines.push(
      `| ${c.name} | ${c.industry ?? "—"} | ${r.openNotClosed ?? "—"}/${r.total ?? "—"} | ${r.candidatesInPipelines ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push(provenanceFooter(meta));
  return lines.join("\n");
}

export const listCompanies = registerTool({
  id: "recruit.list_companies",
  description:
    'List the client companies in the recruitment system, each with how many requisitions they have, how many are still open, and how many candidates sit in their pipelines — enough to answer "which clients are we actively hiring for" in one call. ' +
    "Supports search, includeInactive, and limit/offset (max 200, default 50); check meta.truncated before concluding you have the full client list. " +
    "PROVENANCE: client records live in the matcher service DB (not in Workable), and every count is computed live from the matcher. Read meta.dataQuality out loud when it matters: many requisitions are not linked to any client, so per-client totals are a floor, not a census.",
  inputSchema: z.object({
    search: z.string().optional(),
    includeInactive: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    companies: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    // zod `.default()` is applied at parse time, so the handler's input type
    // still marks these optional — pin them once here.
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const lean = await internalFetch<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      companies: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any;
    }>(
      `/api/internal/recruit/companies${qs({
        search: input.search,
        includeInactive: input.includeInactive,
        limit,
        offset,
      })}`,
    );

    if (lean.available) {
      const meta = metaFromServer(
        lean.data.meta,
        "/api/internal/recruit/companies",
      );
      return {
        companies: lean.data.companies,
        meta,
        markdown: renderMarkdown(lean.data.companies, meta),
      };
    }

    const data = await matcherFetch("/api/companies");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[] = Array.isArray(data) ? data : (data?.companies ?? []);
    if (input.search) {
      const s = input.search.toLowerCase();
      rows = rows.filter((c) =>
        String(c?.name ?? "")
          .toLowerCase()
          .includes(s),
      );
    }
    const totalAvailable = rows.length;
    const companies = rows.slice(offset, offset + limit).map((c) => ({
      id: c?.id ?? null,
      name: c?.name ?? "(unnamed)",
      industry: c?.industry ?? null,
      isActive: true,
      requisitions: {
        total: null,
        openNotClosed: null,
        candidatesInPipelines: null,
      },
      source: {
        origin: SOURCE.matcher,
        readFrom: SOURCE.matcher,
        lastUpdatedAt: null,
      },
      links: {
        matcher: c?.id ? matcherLink(`/positions?companyId=${c.id}`) : null,
      },
    }));

    const meta = buildMeta({
      endpoint: "/api/companies",
      degraded: true,
      degradedReason: lean.reason,
      totalAvailable,
      returned: companies.length,
      limit,
      offset,
      truncated: offset + companies.length < totalAvailable,
      provenance: {
        "name, industry": `${SOURCE.matcher} — client records maintained in the matcher, not in Workable`,
      },
      dataQuality: [
        "Requisition and candidate counts per client are not available on this endpoint — they are null, not zero.",
        "Only active clients are returned by this endpoint regardless of includeInactive.",
      ],
    });

    return { companies, meta, markdown: renderMarkdown(companies, meta) };
  },
});
