import { describe, expect, it } from 'vitest';
import { buildOutreachDraft } from './draft-outreach';
import { buildSearchPlans } from './find-signals';
import { toSignal } from './signals';

describe('industry-neutral outreach', () => {
  it('builds broad commercial discovery without job fields or a claimed company', () => {
    const plans = buildSearchPlans({
      offer: 'automatización de logística',
      idealClient: 'importadores medianos',
      industries: ['logística'],
      buyingSignals: ['abre nueva sede'],
    });
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (!plan) throw new Error('missing commercial search plan');
    expect(plan.company).toBeNull();
    expect(plan.roleTitle).toBeUndefined();
    expect(plan.query).toContain('importadores medianos');
    expect(plan.query).toContain('abre nueva sede');
  });

  it('keeps the original roles input as explicit hiring mode', () => {
    const plans = buildSearchPlans({ roles: ['senior QA'], extraQualifiers: 'remote Colombia' });
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (!plan) throw new Error('missing hiring search plan');
    expect(plan.roleTitle).toBe('senior QA');
    expect(plan.query).toContain('site:boards.greenhouse.io');
  });

  it('maps legacy hiring rows with the new commercial fields empty', () => {
    const signal = toSignal({
      id: '1',
      company: 'Acme',
      role_title: 'QA',
      url: 'https://example.com/job',
      source: 'web',
      status: 'new',
      created_at: '2026-01-01',
    });
    expect(signal.roleTitle).toBe('QA');
    expect(signal.offer).toBeNull();
    expect(signal.buyingSignal).toBeNull();
  });

  it('creates review-only copy and cannot auto-send', () => {
    const draft = buildOutreachDraft({
      company: 'Acme',
      offer: 'automatización',
      opportunityNeed: 'reducir tiempos',
      buyingSignal: 'abrió una sede',
      evidenceUrl: 'https://example.com/news',
    });
    expect(draft.requiresReview).toBe(true);
    expect(draft.sent).toBe(false);
    expect(draft).not.toHaveProperty('recipient');
  });
});
