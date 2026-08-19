import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { screenMemory } from './sensitive';
import { forgetMemoriesMatching, listMemories, rememberMemory } from './store';
import { MEMORY_LIMIT, MEMORY_MAX_CHARS } from './types';

/**
 * The explicit path: the person says "acuérdate de que…" and it is written
 * immediately, no approval step. They just told Cortex; asking them to confirm
 * what they said one second ago is theatre.
 *
 * The derived path — the nightly job in apps/web/inngest/functions/memory-derive.ts
 * — writes SUGGESTIONS instead, because a belief nobody consented to is one the
 * person cannot debug from the outside.
 */

export const cortexRemember = registerTool({
  id: 'cortex.remember',
  description:
    'Remember something about the person you are talking to, so you stop needing to be told it. Use this when they tell you a standing preference, a rule to follow from now on, what one of their words means, or a stable fact about them and their work — and only when it should hold beyond this conversation. Write it as one short sentence in the third person, the way you would want to read it later: "prefers costs in USD", not "the user said USD". This is NOT for storing documents, notes or work products (save those to a Brain Knowledge space), NOT for company-wide facts everyone should know (those belong in a company space, or only the person who told you benefits), and NOT for anything sensitive — no passwords or keys, no pay figures, no emails or phone numbers.',
  inputSchema: z.object({
    memory: z
      .string()
      .min(3)
      .max(MEMORY_MAX_CHARS)
      .describe('One short sentence about the person, in the third person.'),
    kind: z
      .enum(['instruction', 'preference', 'vocabulary', 'fact'])
      .default('fact')
      .describe(
        'instruction = a rule to follow from now on. preference = how they like things done. vocabulary = what one of their words or names means. fact = stable context about them or their work.',
      ),
  }),
  outputSchema: z.object({
    remembered: z.string(),
    kind: z.enum(['instruction', 'preference', 'vocabulary', 'fact']),
    /** How full the always-on set is, so Cortex can say when something fell out. */
    total: z.number().int(),
    limit: z.number().int(),
    evicted: z.array(z.string()),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Screened here rather than only in the schema: the same rule has to apply
    // to a memory the nightly job proposes and to one accepted from /settings,
    // and a zod refinement would only cover this one door.
    const screen = screenMemory(input.memory);
    if (!screen.ok)
      throw new ValidationError(screen.message ?? 'That cannot be stored as a memory.');

    const before = await listMemories(ctx.db, ctx.userId);
    const activeBefore = new Set(before.filter((m) => m.status === 'active').map((m) => m.content));

    const id = await rememberMemory(ctx.db, {
      userId: ctx.userId,
      content: input.memory.trim(),
      kind: input.kind,
      source: 'explicit',
      status: 'active',
      conversationId: ctx.conversationId ?? null,
    });
    if (!id) throw new ValidationError('I could not save that one — try wording it differently.');

    const after = await listMemories(ctx.db, ctx.userId);
    const active = after.filter((m) => m.status === 'active');
    // Being at the cap is not an error, but it IS something the person needs to
    // hear: something they asked Cortex to remember has stopped being loaded.
    const evicted = after
      .filter((m) => m.status === 'archived' && activeBefore.has(m.content))
      .map((m) => m.content);

    return {
      remembered: input.memory.trim(),
      kind: input.kind,
      total: active.length,
      limit: MEMORY_LIMIT,
      evicted,
    };
  },
});

export const cortexForget = registerTool({
  id: 'cortex.forget',
  description:
    'Forget something you remembered about the person. Use it when they say it is wrong or no longer true. Pass the words that identify it — every memory of theirs containing those words is deleted, and you should say back exactly which ones went so they can tell you if you took the wrong one.',
  inputSchema: z.object({
    about: z
      .string()
      .min(2)
      .max(MEMORY_MAX_CHARS)
      .describe('Words identifying the memory to drop, e.g. "USD" or "never CC the client".'),
  }),
  outputSchema: z.object({
    forgotten: z.array(z.string()),
    remaining: z.number().int(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const gone = await forgetMemoriesMatching(ctx.db, ctx.userId, input.about);
    const left = await listMemories(ctx.db, ctx.userId);
    return {
      forgotten: gone.map((m) => m.content),
      remaining: left.filter((m) => m.status === 'active').length,
    };
  },
});
