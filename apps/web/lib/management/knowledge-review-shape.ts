import { z } from 'zod';
export const findingSchema = z.object({
  issue: z.string().min(1).max(600),
  leftQuote: z.string().min(15).max(600),
  rightQuote: z.string().min(15).max(600),
  leftChunk: z.string().uuid(),
  rightChunk: z.string().uuid(),
  question: z.string().min(1).max(500),
});
export type Finding = z.infer<typeof findingSchema>;
export type KnowledgeReview = {
  id: string;
  left_document: string;
  right_document: string;
  finding: Finding & { decision: string };
  resolution: string;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
};
export function hasExactEvidence(
  f: Finding,
  left: { id: string; content: string }[],
  right: { id: string; content: string }[],
) {
  return (
    left.some((c) => c.id === f.leftChunk && c.content.includes(f.leftQuote)) &&
    right.some((c) => c.id === f.rightChunk && c.content.includes(f.rightQuote))
  );
}
