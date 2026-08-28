/**
 * The measurement, run by hand.
 *
 * It lives as a test rather than as a script in `scripts/` for one reason: the
 * suite, the chunker, the embedder and the tool catalogue are all TypeScript
 * inside this package, and the repository's `.mjs` scripts talk to Postgres
 * directly and import nothing from here. A test file is the only runner already
 * wired to this code, and inventing a build step so a script could reach it
 * would be more machinery than the job deserves.
 *
 *   set -a; source .env.local; set +a
 *   EVAL_MEASURE=1 pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
 *
 * Then commit `src/evaluation/fixtures/<model>.json`. It costs a fraction of a
 * cent — voyage-4-lite's free allowance covers it outright — and the file it
 * writes says what it spent. It takes ten to twenty minutes, and the time is
 * not the API: an account with no payment method is capped at three requests a
 * minute, and one question is one request. With a card on file it is under a
 * minute.
 *
 * SKIPPED BY DEFAULT, AND THE SKIP IS THE POINT. CI has no provider key, and a
 * gate that reaches a paid API is a gate that fails on somebody else's outage.
 */

import { describe, expect, it } from 'vitest';
import { listTools } from '../../registry';
import type { SelectableTool } from '../../tool-selection';
import { corpusChunks } from '../corpus';
import { measure } from '../measure';
import { suiteDigest, suiteQueries } from '../suite';
import '../../index';

const enabled = process.env.EVAL_MEASURE === '1';

describe.skipIf(!enabled)('measuring the suite against the live API', () => {
  it(
    'embeds the corpus, the questions and the tools, and writes the fixture',
    async () => {
      const tools = listTools() as unknown as SelectableTool[];
      const fixture = await measure({ tools, write: true, log: (l) => console.log(l) });

      expect(fixture.suiteDigest).toBe(suiteDigest());
      expect(fixture.chunks).toHaveLength(corpusChunks().length);
      expect(Object.keys(fixture.queries)).toHaveLength(suiteQueries().length);
      expect(Object.keys(fixture.tools).length).toBeGreaterThan(40);

      // A measurement in which everything scores the same is a measurement of
      // nothing — a broken key returning zeros, or every text embedded
      // identically. Cheap sanity that the numbers came from somewhere.
      const spread = Object.values(fixture.queries).flat();
      expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(0.2);

      console.log(
        `Medición lista: ${fixture.usage.tokens} tokens, USD ${fixture.usage.usd.toFixed(6)}.`,
      );
    },
    45 * 60_000,
  );
});
