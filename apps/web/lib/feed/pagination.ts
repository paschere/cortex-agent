import { z } from 'zod';
const path = z
  .string()
  .trim()
  .max(160)
  .regex(/^$|^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine((v) => !v.split('.').some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)));
export const feedPaginationSchema = z.object({
  recordsPath: path,
  cursorInput: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  nextCursorPath: path.refine((v) => v.length > 0),
  maxPages: z.number().int().min(1).max(10).default(5),
});
export type FeedPagination = z.infer<typeof feedPaginationSchema>;
export function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path ? path.split('.') : []) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
/** Bounded cursor pagination. Never follows a provider URL or accepts a script. */
export async function collectFeedPages(
  config: FeedPagination,
  input: Record<string, unknown>,
  read: (input: Record<string, unknown>) => Promise<{ data: unknown; truncated?: boolean }>,
) {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let nextInput = { ...input };
  let pages = 0;
  let partial = false;
  while (pages < config.maxPages) {
    const response = await read(nextInput);
    pages++;
    const records = valueAtPath(response.data, config.recordsPath);
    if (!Array.isArray(records))
      throw new Error(
        'La ruta de registros no contiene una lista. Revisa la documentación de la API.',
      );
    const remaining = 1000 - rows.length;
    rows.push(...records.slice(0, remaining));
    if (records.length > remaining) partial = true;
    const next = valueAtPath(response.data, config.nextCursorPath);
    if (
      response.truncated ||
      records.length > 1000 ||
      (rows.length >= 1000 && next != null && next !== '')
    )
      partial = true;
    if (next == null || next === '') return { data: rows, truncated: partial, pages };
    if ((typeof next !== 'string' && typeof next !== 'number') || String(next).length > 4000)
      throw new Error('El cursor de la API no es compatible.');
    const key = String(next);
    if (seen.has(key) || rows.length >= 1000) return { data: rows, truncated: true, pages };
    seen.add(key);
    nextInput = { ...input, [config.cursorInput]: next };
  }
  return { data: rows, truncated: true, pages };
}
