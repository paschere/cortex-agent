import { createHash } from 'node:crypto';
import type { SheetData } from '@cortex/agent-tools/src/kb/spreadsheets';

/** Exact readable-content identity, not fuzzy business-entity matching. */
export function feedFingerprint(input: {
  text: string;
  tables?: SheetData[];
  sourceUrl?: string | null;
  truncated?: boolean;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        truncated: input.truncated ?? false,
        // Keep distinct source URLs separate so deduplication never loses provenance.
        sourceUrl: input.sourceUrl ?? null,
        content: input.tables?.length ? input.tables : input.text.replace(/\r\n/g, '\n').trim(),
      }),
    )
    .digest('hex');
}
