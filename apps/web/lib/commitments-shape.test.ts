import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMITMENT_KINDS as CANONICAL_KINDS,
  KIND_LABEL as CANONICAL_LABEL,
  DEFAULT_NOTICE_DAYS as CANONICAL_NOTICE_DAYS,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { COMMITMENT_KINDS, DEFAULT_NOTICE_DAYS, KIND_LABEL } from './commitments-shape';

/**
 * `commitments-shape.ts` restates three values the browser needs, because
 * importing them from the package drags a Node builtin into the client bundle.
 * This test is the other half of that bargain: it runs in Node, so it may import
 * the real module, and it fails the moment the two disagree.
 *
 * Without it the copy is a silent fork — someone adds a kind to the package, the
 * new-commitment dialog never offers it, and nothing anywhere goes red.
 */
describe('commitment vocabulary mirrored for the client', () => {
  it('lists exactly the kinds the package defines, in the same order', () => {
    expect([...COMMITMENT_KINDS]).toEqual([...CANONICAL_KINDS]);
  });

  it('carries the same default notice window for every kind', () => {
    expect(DEFAULT_NOTICE_DAYS).toEqual(CANONICAL_NOTICE_DAYS);
  });

  it('carries the same Spanish label for every kind', () => {
    expect(KIND_LABEL).toEqual(CANONICAL_LABEL);
  });
});

/**
 * THE THIRD COPY, AND THE ONE NOBODY WAS CHECKING.
 *
 * `kind` is also a CHECK constraint in Postgres, and until now nothing compared
 * it to the TypeScript list. That gap is the exact shape of the most expensive
 * bug this repository has had: migration 0064 added a NOT NULL column and never
 * revisited the function that wrote to that table, so for weeks Cortex could not
 * save a single memory — and nobody noticed, because reading still worked.
 *
 * A kind added to the list but not to the CHECK fails the same way: the dialog
 * offers it, somebody picks it, and the insert is rejected by the database with
 * a message about a constraint. A kind added to the CHECK but not to the list is
 * quieter still — rows exist that no screen can name.
 *
 * Read out of the migrations rather than out of a live database on purpose: this
 * has to fail in CI, on a laptop, with no Postgres running.
 */
describe('the CHECK constraint in Postgres', () => {
  it('allows exactly the kinds the package defines', () => {
    const migrations = join(
      fileURLToPath(new URL('../../../', import.meta.url)),
      'infra/supabase/migrations',
    );

    // Narrowed to THIS table's constraint, not to any `check (kind in …)`.
    // Other tables have a `kind` too — `payment_reports` constrains it to
    // payment/reversal/adjustment — and a looser pattern reads whichever
    // migration happens to be newest, which made this test fail for a reason
    // that had nothing to do with commitments.
    const texts = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .reverse()
      .map((f) => readFileSync(join(migrations, f), 'utf8'));

    // A later migration may drop and recreate it by name; the original is
    // inline in the `create table`, where the name is implicit.
    const named =
      /constraint\s+commitments_kind_check[\s\S]*?check\s*\(\s*kind\s+in\s*\(([\s\S]*?)\)\s*\)/i;
    const inline =
      /create table[^;]*?public\.commitments[\s\S]*?check\s*\(\s*kind\s+in\s*\(([\s\S]*?)\)\s*\)/i;

    let listed: string | undefined;
    for (const text of texts) {
      listed = named.exec(text)?.[1] ?? inline.exec(text)?.[1];
      if (listed) break;
    }

    expect(listed, 'no migration constrains commitments.kind').toBeDefined();

    const inSql = [...(listed ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...CANONICAL_KINDS].sort());
  });
});
