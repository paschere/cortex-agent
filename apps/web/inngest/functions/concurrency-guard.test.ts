import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE PLAN'S CEILING, ENFORCED BEFORE IT ENFORCES ITSELF.
 *
 * Inngest validates concurrency at SYNC time, and it does not reject the
 * offending function — it rejects the WHOLE APP. One function asking for six
 * unregisters every background job in the install: no scheduled routines, no
 * document ingestion, no dev tasks, no orchestrator runs. Nothing errors
 * anywhere; work simply stops happening, and the only symptom is a 400 from
 * `PUT /api/inngest` that nobody is looking at.
 *
 * That has already happened here once (`dev-task-status` asked for 10). So the
 * ceiling is asserted in CI, where a diff can be stopped, rather than
 * discovered in production by its silence.
 *
 * Read as text rather than by importing the functions: several of them pull in
 * `server-only` modules that cannot be loaded outside Next's runtime, and the
 * question — "what number is written in the source" — is a question about the
 * source anyway.
 */

/** The account's per-function ceiling. Raising this requires a plan change. */
const PLAN_CONCURRENCY_LIMIT = 5;

const HERE = fileURLToPath(new URL('.', import.meta.url));

function declaredLimits(source: string): number[] {
  const limits: number[] = [];
  const lines = source.split('\n');
  let insideList = false;

  for (const line of lines) {
    if (insideList) {
      // The list ends at its closing bracket, at any indentation.
      if (/^\s*\],?\s*$/.test(line)) insideList = false;
      else limits.push(...numbersIn(line));
      continue;
    }
    if (!line.includes('concurrency')) continue;
    if (/concurrency\s*:\s*\[/.test(line)) {
      insideList = true;
      continue;
    }
    // The single-object form: `concurrency: { limit: N }`.
    limits.push(...numbersIn(line));
  }
  return limits;
}

function numbersIn(line: string): number[] {
  return [...line.matchAll(/\blimit\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
}

function functionFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts')
    .sort();
}

describe('inngest concurrency', () => {
  it('never asks for more than the plan allows, because one greedy function unregisters them all', () => {
    const offenders: string[] = [];
    for (const file of functionFiles()) {
      for (const limit of declaredLimits(readFileSync(join(HERE, file), 'utf8'))) {
        if (limit > PLAN_CONCURRENCY_LIMIT) offenders.push(`${file}: limit ${limit}`);
      }
    }
    expect(
      offenders,
      `Inngest rejects the entire app at sync time if any function declares more than ${PLAN_CONCURRENCY_LIMIT}. Lower these, or upgrade the account first.`,
    ).toEqual([]);
  });

  it('reads both the single-object and the keyed-list forms', () => {
    expect(declaredLimits('  { id: "x", concurrency: { limit: 5 } },')).toEqual([5]);
    expect(
      declaredLimits(
        [
          '    concurrency: [',
          '      { key: "event.data.runId", limit: 1 },',
          '      { limit: 5 },',
          '    ],',
        ].join('\n'),
      ),
    ).toEqual([1, 5]);
  });

  it('ignores query limits, which have nothing to do with concurrency', () => {
    expect(declaredLimits('        limit: 2000,')).toEqual([]);
  });
});
