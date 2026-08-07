import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PAID WORK BELONGS INSIDE A STEP. ASSERTED IN CI, BECAUSE IT WAS NOT.
 *
 * Inngest memoises what happens inside `step.run` and RE-EXECUTES everything
 * outside it on every attempt. `ingest-document` declared `retries: 3` and
 * called `embedDocuments(...)` in the function body, outside every step. So any
 * failure after that line — a database write, a status update, a network blip —
 * re-embedded the entire document from scratch, up to four times. Because the
 * embedder batches internally, a failure partway through also threw away every
 * batch already paid for and bought them again. A transcribed hour of audio is
 * thousands of chunks. One document exhausted the account.
 *
 * Nothing failed. No test broke, no type was wrong, no log line said anything
 * unusual. The only symptom was the bill, and the bill arrives last.
 *
 * So this is written as a check on the SHAPE of these files rather than on any
 * one of them: an embedding call reachable outside a step, in a directory where
 * every function retries, is the bug — whichever function grows it next.
 *
 * Read as text rather than by importing the functions, for the same reason
 * `concurrency-guard.test.ts` does: several of them pull in `server-only`
 * modules that cannot load outside Next's runtime, and "where in the source is
 * this call" is a question about the source anyway.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Anything that spends money with a third party per call. */
const PAID_CALLS = [
  'embedDocuments(',
  'embedInBatches(',
  'embedQuery(',
  'transcribeAudio(',
  // Two model calls over a whole document (migration 0076): classify it, then
  // read its fields. Same failure shape as the embeddings — outside a step, a
  // retry pays for both again — so it is guarded the same way.
  'extractDocumentData(',
];

function functionFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts')
    .sort();
}

/**
 * Blank out string literals, template literals and comments, preserving every
 * character position. Paren matching below has to ignore a `(` that lives in a
 * sentence, and the indices must still line up with the original source.
 */
function blankLiterals(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) out[i++] = ' ';
      out[i++] = ' ';
      out[i++] = ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i++] = ' ';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') out[i++] = ' ';
        if (i < source.length) out[i++] = ' ';
      }
      out[i++] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Half-open [start, end) spans covering the argument list of every step.run. */
function stepRanges(blanked: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = 'step.run(';
  let from = 0;
  for (;;) {
    const at = blanked.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < blanked.length; i++) {
      if (blanked[i] === '(') depth++;
      else if (blanked[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([at, i]);
    from = at + marker.length;
  }
  return ranges;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('inngest embedding cost', () => {
  it('never calls a paid provider outside a step, because a retry would pay again', () => {
    const offenders: string[] = [];

    for (const file of functionFiles()) {
      const source = readFileSync(join(HERE, file), 'utf8');
      const blanked = blankLiterals(source);
      const ranges = stepRanges(blanked);

      for (const call of PAID_CALLS) {
        let from = 0;
        for (;;) {
          const at = blanked.indexOf(call, from);
          if (at === -1) break;
          from = at + call.length;
          // The import statement itself is not a call site.
          if (blanked.slice(0, at).trimEnd().endsWith('import')) continue;
          const inside = ranges.some(([s, e]) => at > s && at < e);
          if (!inside) {
            offenders.push(`${file}:${lineOf(source, at)} — ${call.slice(0, -1)}`);
          }
        }
      }
    }

    expect(
      offenders,
      'Inngest re-executes everything outside step.run on every retry, so a paid call there is charged once per attempt. Move it inside a step, and persist its result before the next one is bought.',
    ).toEqual([]);
  });

  it('decides whether an embedding failure is worth retrying, instead of throwing blindly', () => {
    // A rate limit clears by waiting. An exhausted quota does not, and throwing
    // it into a retrying function spends the budget — and, on a provider that
    // charges for accepted requests, the money — to be told the same thing four
    // times. Every function that embeds must consult `retryable`.
    const missing: string[] = [];
    for (const file of functionFiles()) {
      const source = readFileSync(join(HERE, file), 'utf8');
      const embeds = PAID_CALLS.slice(0, 3).some((c) => source.includes(c));
      if (embeds && !source.includes('.retryable')) missing.push(file);
    }
    expect(
      missing,
      'These functions embed but never look at EmbedFailure.retryable, so they will retry an exhausted quota.',
    ).toEqual([]);
  });

  it('stamps every vector it writes with the model that produced it', () => {
    // Two models' vectors are coordinates in unrelated spaces; mixed in one
    // column they rank against each other and return confident nonsense. The
    // column exists (migration 0074) — this is the check that it is filled in.
    const missing: string[] = [];
    for (const file of functionFiles()) {
      const source = readFileSync(join(HERE, file), 'utf8');
      if (!source.includes('embedding:')) continue;
      if (!source.includes('embedding_model')) missing.push(file);
    }
    expect(
      missing,
      'These functions write kb_chunks.embedding without kb_chunks.embedding_model, which makes the vector unsearchable and invisible to the reindexer.',
    ).toEqual([]);
  });
});
