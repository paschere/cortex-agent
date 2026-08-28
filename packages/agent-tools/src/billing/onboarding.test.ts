import { describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { readOnboarding } from './onboarding';

/**
 * The first ten minutes, and the promise that nobody who has already had them is
 * made to sit through them again.
 *
 * Two workspaces as always: ACME has just signed up, GLOBEX is the company that
 * was already in production when migration 0085 ran. Every step below is derived
 * by counting rows, so the interesting failure is a step that Acme completes
 * because GLOBEX has a document — which is why Globex's fixture is full and
 * Acme's is empty.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

function fixture(): Tables {
  return {
    // Globex is the grandfathered workspace: migration 0085 § 8 wrote its
    // onboarding row already dismissed.
    organization_onboarding: [
      { organization_id: ACME, primary_goal: null, company_name: null, dismissed_at: null },
      {
        organization_id: GLOBEX,
        primary_goal: null,
        company_name: null,
        dismissed_at: '2026-08-03T00:00:00Z',
      },
    ],
    // Everything Acme does not have, Globex does.
    integrations: [{ user_id: 'u3', organization_id: GLOBEX, provider: 'google' }],
    kb_documents: [{ id: 'd1', organization_id: GLOBEX, title: 'Contrato' }],
    messages: [{ id: 'm1', organization_id: GLOBEX, role: 'assistant' }],
    users: [
      { id: 'u1', organization_id: ACME },
      { id: 'u3', organization_id: GLOBEX },
      { id: 'u4', organization_id: GLOBEX },
    ],
  };
}

function scoped(tables: Tables, organizationId: string) {
  return createOrgScopedClient(createFakeSupabase(tables).client, organizationId);
}

describe('a company that just signed up', () => {
  it('is shown the guide, starting at the question', async () => {
    const state = await readOnboarding(scoped(fixture(), ACME));
    expect(state.show).toBe(true);
    expect(state.done).toBe(false);
    expect(state.next).toBe('goal');
    expect(state.steps.every((s) => !s.done)).toBe(true);
  });

  it('does not complete a step because the neighbour completed it', async () => {
    // Globex has an integration, a document, an answer and two people. None of
    // them may tick a box for Acme.
    const state = await readOnboarding(scoped(fixture(), ACME));
    const done = Object.fromEntries(state.steps.map((s) => [s.id, s.done]));
    expect(done.source).toBe(false);
    expect(done.knowledge).toBe(false);
    expect(done.answer).toBe(false);
    expect(done.team).toBe(false);
  });

  it('reads progress from the data, not from a stored checkbox', async () => {
    const tables = fixture();
    (tables.integrations ?? []).push({
      user_id: 'u1',
      organization_id: ACME,
      provider: 'google',
    });
    const state = await readOnboarding(scoped(tables, ACME));
    expect(state.steps.find((s) => s.id === 'source')?.done).toBe(true);
    // And nothing else moved.
    expect(state.steps.find((s) => s.id === 'knowledge')?.done).toBe(false);
  });
});

describe('the one question changes what happens next', () => {
  it('sends a mail-first company to connect a source before uploading anything', async () => {
    const tables = fixture();
    tables.organization_onboarding = [
      { organization_id: ACME, primary_goal: 'email', company_name: null, dismissed_at: null },
    ];
    const state = await readOnboarding(scoped(tables, ACME));
    expect(state.goal).toBe('email');
    expect(state.steps.map((s) => s.id)).toEqual(['goal', 'source', 'answer', 'knowledge', 'team']);
    expect(state.next).toBe('source');
  });

  it('sends a documents-first company to Brain Knowledge instead', async () => {
    const tables = fixture();
    tables.organization_onboarding = [
      { organization_id: ACME, primary_goal: 'documents', company_name: null, dismissed_at: null },
    ];
    const state = await readOnboarding(scoped(tables, ACME));
    expect(state.steps.map((s) => s.id)).toEqual(['goal', 'knowledge', 'answer', 'source', 'team']);
    expect(state.next).toBe('knowledge');
  });

  it('always leaves the invitation for last, whatever the goal', async () => {
    for (const goal of ['email', 'documents', 'deadlines', 'meetings']) {
      const tables = fixture();
      tables.organization_onboarding = [
        { organization_id: ACME, primary_goal: goal, company_name: null, dismissed_at: null },
      ];
      const state = await readOnboarding(scoped(tables, ACME));
      expect(state.steps[state.steps.length - 1]?.id).toBe('team');
    }
  });

  it('ignores a goal it does not recognise rather than reordering by garbage', async () => {
    const tables = fixture();
    tables.organization_onboarding = [
      { organization_id: ACME, primary_goal: 'whatever', company_name: null, dismissed_at: null },
    ];
    const state = await readOnboarding(scoped(tables, ACME));
    expect(state.goal).toBeNull();
    expect(state.steps.find((s) => s.id === 'goal')?.done).toBe(false);
  });
});

describe('the company that was already here', () => {
  it('is never shown a first-run guide', async () => {
    const state = await readOnboarding(scoped(fixture(), GLOBEX));
    expect(state.show).toBe(false);
    expect(state.dismissedAt).toBe('2026-08-03T00:00:00Z');
  });

  it('is nonetheless reported honestly — the steps it really has done', async () => {
    const state = await readOnboarding(scoped(fixture(), GLOBEX));
    const done = Object.fromEntries(state.steps.map((s) => [s.id, s.done]));
    expect(done.source).toBe(true);
    expect(done.knowledge).toBe(true);
    expect(done.answer).toBe(true);
    expect(done.team).toBe(true);
    // Only the question it was never asked is outstanding, and that is exactly
    // why `show` is driven by dismissal and not by completeness.
    expect(done.goal).toBe(false);
  });
});

describe('failure', () => {
  it('hides the guide rather than taking the page down with it', async () => {
    const broken = createOrgScopedClient(
      {
        from: () => {
          throw new Error('database on fire');
        },
      } as never,
      ACME,
    );
    const state = await readOnboarding(broken);
    expect(state.show).toBe(false);
    expect(state.done).toBe(true);
  });
});
