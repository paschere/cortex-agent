import type { SheetData } from '@cortex/agent-tools/src/kb/spreadsheets';
import type { FeedUseRecommendation } from './intelligence';

export const FEED_ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
};
export const FEED_MAX_BYTES = 10 * 1024 * 1024;
export const FEED_MAX_TEXT = 200_000;
export interface FeedEntry {
  id: string;
  filename: string;
  feed_kind: 'file' | 'url' | 'text';
  source_url: string | null;
  created_at: string;
  purge_at: string;
  byte_size: number;
  conversation_id: string | null;
  promoted_document_id: string | null;
  feed_truncated: boolean;
}
export interface FeedDetail extends FeedEntry {
  recommendation?: FeedUseRecommendation;
  extracted_text: string;
  feed_tables: SheetData[] | null;
}

export function feedMime(name: string, declared: string): string | null {
  const mime = declared.toLowerCase().split(';')[0] ?? '';
  const extension = `.${name.split('.').pop()?.toLowerCase()}`;
  const match = Object.entries(FEED_ACCEPT).find(([, extensions]) =>
    extensions.includes(extension),
  );
  // Browser MIME reports for CSV vary; extensions choose only known parsers.
  return match?.[0] ?? (mime in FEED_ACCEPT ? mime : null);
}
