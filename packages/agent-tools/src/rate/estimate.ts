import { z } from "zod";
import { registerTool } from "../index";
import { callEstimator } from "./client";

const MonthlyRateRange = z.object({ min: z.number(), max: z.number() });

export const rateEstimate = registerTool({
  id: "rate.estimate",
  description:
    "Estimate the monthly USD rate to quote for a LATAM staffing role that does not exist yet — pick the role, seniority, region and years, get a min/max range with notes. Uses the internal 2026-Q1 pricing table. " +
    "Quotes at the standard 33% margin unless a different one is asked for — say which margin the number carries, and that it can be changed. " +
    "This is a PRICE GUIDE, not a record of anything: it does not know what the company actually charges any client today. For the real bill rate on a person the company already staffs, use bamboo.get_employee; for a whole client or division, bamboo.compensation_report. Never present an estimate from here as what a client is being charged.",
  inputSchema: z.object({
    role: z.enum([
      "frontend",
      "backend",
      "fullstack",
      "data",
      "devops",
      "qa",
      "pm",
      "designer",
      "mobile",
      "ml_engineer",
      "security",
      "sre",
      "other",
    ]),
    openRole: z
      .string()
      .optional()
      .describe('Free-text role description; used when role is "other"'),
    seniority: z.enum(["junior", "mid", "senior", "lead"]),
    region: z.enum(["mx", "latam", "br", "ar", "co", "cl", "pe"]),
    yearsExperience: z.number().int().min(0).max(40),
    margin: z
      .number()
      .min(0)
      .max(95)
      .optional()
      .describe(
        "Margin to quote at, as a percentage. Leave it out to use the standard 33%.",
      ),
  }),
  outputSchema: z.object({
    monthlyRateUsd: MonthlyRateRange,
    notes: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => callEstimator(input, ctx),
});
