import { ValidationError } from "@cortex/core";
import { z } from "zod";
import { registerTool } from "../index";
import { callEstimator } from "./client";
import type { EstimateInput } from "./client";

type Role = EstimateInput["role"];
type Seniority = EstimateInput["seniority"];
type Region = EstimateInput["region"];

const ROLES: Role[] = [
  "frontend",
  "backend",
  "fullstack",
  "data",
  "devops",
  "qa",
  "pm",
  "designer",
];
const SENIORITY_LEVELS: Seniority[] = ["junior", "mid", "senior", "lead"];
const REGIONS: Region[] = ["mx", "latam", "br", "ar", "co", "cl", "pe"];

/** Very lightweight heuristic extraction — good-enough for MVP. */
function extractFields(text: string): {
  role?: Role;
  seniority?: Seniority;
  region?: Region;
  yearsExperience?: number;
} {
  const lower = text.toLowerCase();

  const role = ROLES.find((r) => lower.includes(r));

  const seniority = SENIORITY_LEVELS.find((s) => {
    if (s === "mid")
      return (
        lower.includes("mid-level") ||
        lower.includes("mid level") ||
        lower.includes(" mid ")
      );
    return lower.includes(s);
  });

  const region = REGIONS.find((r) => new RegExp(`\\b${r}\\b`).test(lower));

  const yearsMatch = lower.match(
    /(\d+)\s*(?:\+\s*)?years?\s*(?:of\s*)?(?:experience|exp)/,
  );
  const yearsExperience =
    yearsMatch?.[1] != null ? parseInt(yearsMatch[1] as string, 10) : undefined;

  return { role, seniority, region, yearsExperience };
}

export const rateEstimateFromDocument = registerTool({
  id: "rate.estimate_from_document",
  description:
    "Same price guide as rate.estimate, but starting from the already-extracted text of a job description or RFP: it detects role, seniority, region and years from the wording and falls back to provided defaults for anything it cannot find. Use it only when you are holding the document text; if you already know the four fields, call rate.estimate directly. " +
    "Like rate.estimate, this is a quote for a role that does not exist yet — it is not what the company charges any client today. Real bill rates live in BambooHR (bamboo.get_employee, bamboo.compensation_report).",
  inputSchema: z.object({
    documentText: z.string().min(1),
    defaults: z
      .object({
        role: z
          .enum([
            "frontend",
            "backend",
            "fullstack",
            "data",
            "devops",
            "qa",
            "pm",
            "designer",
          ])
          .optional(),
        seniority: z.enum(["junior", "mid", "senior", "lead"]).optional(),
        region: z
          .enum(["mx", "latam", "br", "ar", "co", "cl", "pe"])
          .optional(),
        yearsExperience: z.number().int().min(0).max(40).optional(),
      })
      .optional(),
  }),
  outputSchema: z.object({
    monthlyRateUsd: z.object({ min: z.number(), max: z.number() }),
    notes: z.string(),
    extracted: z.object({
      role: z.string(),
      seniority: z.string(),
      region: z.string(),
      yearsExperience: z.number(),
    }),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const extracted = extractFields(input.documentText);
    const defaults = input.defaults ?? {};

    const role = (extracted.role ?? defaults.role) as Role | undefined;
    const seniority = (extracted.seniority ?? defaults.seniority) as
      | Seniority
      | undefined;
    const region = (extracted.region ?? defaults.region ?? "latam") as Region;
    const yearsExperience =
      extracted.yearsExperience ?? defaults.yearsExperience ?? 0;

    if (!role) {
      throw new ValidationError(
        'Could not extract role from document. Provide a "defaults.role" to override.',
      );
    }
    if (!seniority) {
      throw new ValidationError(
        'Could not extract seniority from document. Provide a "defaults.seniority" to override.',
      );
    }

    const estimate = await callEstimator(
      { role, seniority, region, yearsExperience },
      ctx,
    );

    return {
      ...estimate,
      extracted: { role, seniority, region, yearsExperience },
    };
  },
});
