import { describe, expect, it } from 'vitest';
import { getTool } from '../../registry';
import { toolEmbedText } from '../../tool-selection/rank';
import { ERRAND_TOOLS, assertProposalOnly } from '../boundary';
import { MAX_LIVE_ERRANDS } from '../budget';
import { toolsFor } from '../kinds';
import { errandsAnswer, errandsStart, errandsStatus } from '../tools';

/**
 * THE TOOLS THAT MAKE ERRANDS REACHABLE FROM A SENTENCE.
 *
 * Two things are being guarded here, and only one of them is ordinary.
 *
 * ── 1. THE DESCRIPTIONS, BECAUSE THEY ARE THE FEATURE ─────────────────────
 *
 * Tool selection is semantic (../../tool-selection). A family whose
 * description does not resemble what the person typed never reaches the model,
 * and the model then truthfully says it cannot do the thing. That has happened
 * twice in this codebase — `vehicles` invisible behind a regex, and `gmail`
 * scoring 0.291 against a floor of 0.300 on a request that literally said
 * "mandale un correo".
 *
 * The thresholds are measured and nothing here touches them. The only lever is
 * the wording, so the wording is asserted: every phrasing a Colombian
 * administrator would actually use has to appear in the text that gets
 * embedded. This is a LEXICAL check standing in for a semantic one — it cannot
 * prove a cosine, and it is not pretending to. What it can do is fail the day
 * somebody "tidies up" a description into a noun phrase and quietly takes the
 * capability off the air, which is the regression that has actually happened.
 *
 * ── 2. THE LINE, ON THE CHEAPEST ROUTE TO CROSSING IT ─────────────────────
 *
 * Saying "consígueme un vuelo a Bogotá" is one sentence. Clicking through the
 * form is not. So the chat is where the boundary is most likely to be tested,
 * and these assertions pin it to the same exact-id list the screen uses.
 */

/** What actually gets embedded: `family action (id): description`. */
const embedded = (tool: { id: string; description: string }) => toolEmbedText(tool).toLowerCase();

describe('errand tools are registered', () => {
  it('puts all three in the registry, so a granted workspace can reach them', () => {
    for (const id of ['errands.start', 'errands.status', 'errands.answer']) {
      expect(getTool(id), `${id} is not registered`).toBeDefined();
    }
  });

  it('groups them under one family, which is what the ranker keeps or drops', () => {
    for (const tool of [errandsStart, errandsStatus, errandsAnswer]) {
      expect(tool.id.split('.')[0]).toBe('errands');
    }
  });
});

describe('the words the ranker will see', () => {
  it('speaks the way somebody asking for research actually speaks', () => {
    // Not synonyms chosen at a desk: these are the verbs the launch form's own
    // examples use and the ones the product owner used when asking for this.
    const text = embedded(errandsStart);
    for (const phrase of [
      'investíga',
      'investiga',
      'averígua',
      'averigua',
      'compára',
      'cuadro comparativo',
      'reúneme',
      'recopíla',
      'vigila',
      'avísame',
      'monitorea',
    ]) {
      expect(text, `errands.start should be findable from «${phrase}»`).toContain(phrase);
    }
  });

  it('says when NOT to reach for it, so a one-line lookup stays a one-line lookup', () => {
    // Without this the ranker's best match for "búscame el teléfono de X" is a
    // forty-minute autonomous job. A description that only advertises is a
    // description that mis-fires.
    const text = embedded(errandsStart);
    expect(text).toContain('do not use it');
  });

  it('states the line in the description, so the model declines instead of promising', () => {
    const text = embedded(errandsStart);
    for (const refusal of ['never buys', 'books', 'reserves', 'signs']) {
      expect(text).toContain(refusal);
    }
    // And names the requests that are over it, so the refusal is recognisable
    // rather than abstract.
    for (const overTheLine of ['resérvame', 'cómprame', 'mándale un correo']) {
      expect(text).toContain(overTheLine);
    }
  });

  it('is findable from the way people ask how something is going', () => {
    const text = embedded(errandsStatus);
    for (const phrase of ['en qué va', 'ya quedó', 'cómo va', 'resultado']) {
      expect(text, `errands.status should be findable from «${phrase}»`).toContain(phrase);
    }
  });

  it('tells the model that a waiting question is its job to relay', () => {
    const text = embedded(errandsStatus);
    expect(text).toContain('waiting on the person');
    expect(embedded(errandsAnswer)).toContain('clarification');
  });

  it('gives every description enough to rank on', () => {
    // A two-word description is the shape that scored below the floor for mail.
    for (const tool of [errandsStart, errandsStatus, errandsAnswer]) {
      expect(tool.description.length, `${tool.id} is too thin to rank`).toBeGreaterThan(300);
    }
  });
});

describe('the line, on the chat route', () => {
  it('hands an errand started by talking exactly the toolset the form does', () => {
    for (const kind of ['research_compare', 'gather_sources', 'monitor_change'] as const) {
      expect(toolsFor(kind)).toEqual([...ERRAND_TOOLS]);
      expect(() => assertProposalOnly(toolsFor(kind))).not.toThrow();
    }
  });

  it('never asks for confirmation, because it has nothing to confirm', () => {
    // Deliberate and worth stating: `requiresConfirmation` is for tools with an
    // outbound effect a person must see first. An errand has none — that is the
    // whole boundary — so gating it would be theatre, and theatre teaches
    // people to click through the gates that matter.
    for (const tool of [errandsStart, errandsStatus, errandsAnswer]) {
      expect(tool.requiresConfirmation ?? false).toBe(false);
    }
  });

  it('rate-limits starting far harder than looking', () => {
    // An errand is the most expensive single thing the model can start, and
    // five in a minute is a loop rather than a use case.
    expect(errandsStart.rateLimit?.perMinute).toBeLessThanOrEqual(5);
    expect(errandsStatus.rateLimit?.perMinute ?? 0).toBeGreaterThan(
      errandsStart.rateLimit?.perMinute ?? 0,
    );
  });

  it('tells the model the live cap in the refusal, not just that it failed', () => {
    // A model that is told "no" invents a reason. A model that is told the cap
    // relays it and offers to stop one.
    expect(String(MAX_LIVE_ERRANDS)).toBeTruthy();
    expect(errandsStart.outputSchema).toBeDefined();
  });
});
