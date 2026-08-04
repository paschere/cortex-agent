import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  type SecurityPolicy,
  bogotaHour,
  bumpLevel,
  classify,
  decide,
  isSensitiveFamily,
} from './policy';

// Fixed clock inside Bogota working hours (14:00 COT = 19:00 UTC) so the
// `off-hours` signal never leaks into unrelated assertions.
const NOON = new Date('2026-03-10T19:00:00.000Z');
const MIDNIGHT = new Date('2026-03-10T06:00:00.000Z'); // 01:00 COT

// A configured workspace is the interesting case for most of these: without
// internal domains every recipient is external, and the internal-write branch
// below could never be reached. The unconfigured posture gets its own block.
const INTERNAL = 'acme.test';

beforeEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = INTERNAL;
});

afterEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = '';
});

function run(toolId: string, input: unknown, extra: Record<string, unknown> = {}) {
  return classify({
    tool: { id: toolId },
    input,
    ctx: { now: NOON, ...(extra.ctx as object) },
    surface: (extra.surface as 'web' | 'mcp' | 'schedule') ?? 'web',
  });
}

describe('classify — data sensitivity x blast radius', () => {
  it('a payroll read is medium risk and allowed', () => {
    const c = run('payroll.employee_profile', { employeeId: 'e-1' });
    expect(c.sensitivity).toBe('financial');
    expect(c.blastRadius).toBe('read');
    expect(c.riskLevel).toBe('medium');
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });

  it('a benign web search is low risk and allowed', () => {
    const c = run('web.search', { query: 'nearshore hiring trends 2026' });
    expect(c.sensitivity).toBe('public');
    expect(c.blastRadius).toBe('read');
    expect(c.riskLevel).toBe('low');
    expect(c.signals).not.toContain('compensation-in-payload');
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });

  it('a bulk payroll export is high risk and requires confirmation', () => {
    const c = run('payroll.expenses_report', { limit: 5000 });
    expect(c.signals).toContain('bulk-read');
    expect(c.blastRadius).toBe('bulk');
    expect(c.riskLevel).toBe('high');
    expect(decide(c, DEFAULT_POLICY)).toBe('confirm');
  });

  it('treats a whole-roster tool as bulk even with no arguments', () => {
    const c = run('payroll.team_assignments', {});
    expect(c.signals).toContain('bulk-read');
    expect(c.riskLevel).toBe('high');
  });

  it('an internal knowledge read stays low', () => {
    const c = run('kb.search', { query: 'onboarding playbook' });
    expect(c.riskLevel).toBe('low');
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });

  it('a candidate write-up read is medium (PII)', () => {
    const c = run('presentations.pick_candidate', { jobId: 'j-9' });
    expect(c.sensitivity).toBe('pii');
    expect(c.riskLevel).toBe('medium');
  });
});

describe('classify — sending compensation outside the company', () => {
  it('is critical and blocked', () => {
    const c = run('gmail.send_draft', {
      to: 'cfo@acme-client.com',
      subject: 'Contractor rates',
      body: 'Monthly salary for each engineer is attached.',
    });
    expect(c.signals).toContain('external-recipient');
    expect(c.signals).toContain('compensation-in-payload');
    expect(c.sensitivity).toBe('financial');
    expect(c.blastRadius).toBe('external_send');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
  });

  it('relaxes to an allowed internal write when every recipient is internal', () => {
    const c = run('gmail.send_draft', {
      to: `ceo@${INTERNAL}`,
      subject: 'Team rates',
      body: 'Monthly salary breakdown.',
    });
    expect(c.signals).not.toContain('external-recipient');
    expect(c.blastRadius).toBe('internal_write');
    expect(c.riskLevel).toBe('high');
    // Flag-first: nothing left the company, so it runs and is recorded.
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });

  it('treats nobody as internal when no internal domains are configured', () => {
    // The fail-safe direction for a fresh multi-tenant deployment: with no
    // INTERNAL_EMAIL_DOMAINS set, the same message that would relax to an
    // internal write above is treated as leaving the company.
    process.env.INTERNAL_EMAIL_DOMAINS = '';
    const c = run('gmail.send_draft', {
      to: `ceo@${INTERNAL}`,
      subject: 'Team rates',
      body: 'Monthly salary breakdown.',
    });
    expect(c.signals).toContain('external-recipient');
    expect(c.blastRadius).toBe('external_send');
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
  });

  it('counts a subdomain of an internal domain as internal', () => {
    const c = run('gmail.send_draft', {
      to: `ops@mail.${INTERNAL}`,
      body: 'salary breakdown',
    });
    expect(c.signals).not.toContain('external-recipient');
    expect(c.blastRadius).toBe('internal_write');
  });

  it('does not treat an ordinary client email as an exfiltration attempt', () => {
    const c = run('gmail.send_draft', {
      to: 'hiring@acme-client.com',
      subject: 'Two candidates for the backend role',
      body: 'Both are available to start in two weeks. Their profiles are attached.',
    });
    expect(c.sensitivity).toBe('client');
    expect(c.riskLevel).toBe('high');
    expect(decide(c, DEFAULT_POLICY)).not.toBe('block');
  });

  it('blocks identity documents or bank details leaving the company', () => {
    const c = run('gmail.send_draft', {
      to: 'vendor@payments.io',
      subject: 'Onboarding',
      body: 'Her passport number and bank account are below.',
    });
    expect(c.signals).toContain('personal-id-in-payload');
    expect(c.sensitivity).toBe('pii');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
  });

  it('does not fire the personal-id signal on ordinary names and emails', () => {
    const c = run('gmail.send_draft', {
      to: 'hiring@acme-client.com',
      body: 'Maria Gonzalez (maria@example.com, +57 300 555 0000) is interested.',
    });
    expect(c.signals).not.toContain('personal-id-in-payload');
  });

  it('a Slack post of ordinary internal content is only flagged', () => {
    const c = run('slack.post_message', { channel: '#general', text: 'standup at 10' });
    expect(c.riskLevel).toBe('medium');
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });

  it('still blocks when the compensation wording is a field name, not prose', () => {
    const c = run('gsheets.append_row', {
      spreadsheetId: 's1',
      shareWith: 'ops@vendor.io',
      values: { hourly_rate: 42 },
    });
    expect(c.signals).toContain('compensation-in-payload');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
  });
});

describe('classify — unattended scheduled runs', () => {
  it('an unattended external write is critical and blocked', () => {
    const c = classify({
      tool: { id: 'slack.post_message' },
      input: { channel: '#client-acme', text: 'Weekly update for acme@acme.com' },
      ctx: { now: NOON },
      surface: 'schedule',
    });
    expect(c.signals).toContain('unattended');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
  });

  it('an unattended internal read is unaffected', () => {
    const c = classify({
      tool: { id: 'linear.list_issues' },
      input: { teamId: 't-1' },
      ctx: { now: NOON },
      surface: 'schedule',
    });
    expect(c.signals).toContain('unattended');
    expect(c.riskLevel).toBe('low');
    expect(decide(c, DEFAULT_POLICY)).toBe('allow');
  });
});

describe('classify — contextual signals', () => {
  it('off-hours fires outside 06:00-22:00 Bogota', () => {
    const c = classify({
      tool: { id: 'kb.search' },
      input: { query: 'x' },
      ctx: { now: MIDNIGHT },
      surface: 'web',
    });
    expect(c.signals).toContain('off-hours');
    // recorded, but not on its own an escalation
    expect(c.riskLevel).toBe('low');
  });

  it('high-frequency bumps the level one step', () => {
    const base = run('presentations.pick_candidate', { jobId: 'j-1' });
    const hot = classify({
      tool: { id: 'presentations.pick_candidate' },
      input: { jobId: 'j-1' },
      ctx: { now: NOON, extraSignals: ['high-frequency'] },
      surface: 'web',
    });
    expect(base.riskLevel).toBe('medium');
    expect(hot.riskLevel).toBe('high');
    // Escalated and recorded, but a busy user is not stopped from working.
    expect(decide(hot, DEFAULT_POLICY)).toBe('allow');
  });

  it('signals are de-duplicated and sorted', () => {
    const c = classify({
      tool: { id: 'payroll.team_overview' },
      input: {},
      ctx: { now: NOON, extraSignals: ['bulk-read', 'bulk-read'] },
      surface: 'web',
    });
    expect(c.signals.filter((s) => s === 'bulk-read')).toHaveLength(1);
    expect([...c.signals].sort()).toEqual(c.signals);
  });

  it('survives a hostile / deeply nested payload without throwing', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 50; i++) {
      const next: Record<string, unknown> = {};
      node.child = next;
      node = next;
    }
    const cyclic: Record<string, unknown> = { self: null };
    cyclic.self = cyclic;
    expect(() => run('kb.search', { deep, cyclic })).not.toThrow();
  });

  it('classifies unknown tool families conservatively', () => {
    const c = run('someexternal.push_records', { to: 'ops@partner.dev' });
    expect(c.sensitivity).toBe('client');
    expect(c.riskLevel).not.toBe('low');
  });
});

describe('decide — policy overrides', () => {
  const permissive: SecurityPolicy = {
    ...DEFAULT_POLICY,
    blockCritical: false,
    externalSendRequiresConfirmation: false,
  };

  it('critical degrades to confirm when block_critical is off', () => {
    const c = run('gmail.send_draft', { to: 'x@acme.com', body: 'salary sheet' });
    expect(decide(c, DEFAULT_POLICY)).toBe('block');
    expect(decide(c, permissive)).toBe('confirm');
  });

  it('external_send_requires_confirmation gates a medium outbound send', () => {
    const c = run('slack.post_message', {
      channel: '#shared-acme',
      text: 'ping partner@acme.com about the demo',
    });
    expect(c.riskLevel).toBe('medium');
    expect(c.signals).toContain('external-recipient');
    expect(decide(c, DEFAULT_POLICY)).toBe('confirm');
    expect(decide(c, permissive)).toBe('allow');
  });

  it('a bulk sensitive export is the one high-risk shape that asks first', () => {
    const c = run('payroll.expenses_report', { limit: 5000 });
    expect(c.riskLevel).toBe('high');
    expect(decide(c, DEFAULT_POLICY)).toBe('confirm');
    expect(decide(c, permissive)).toBe('confirm');
  });

  it('every other high-risk shape runs and is only flagged', () => {
    const internalComp = run('gmail.send_draft', {
      to: `ceo@${INTERNAL}`,
      body: 'salary breakdown',
    });
    expect(internalComp.riskLevel).toBe('high');
    expect(decide(internalComp, DEFAULT_POLICY)).toBe('allow');

    const clientDump = run('hubspot.search_companies', { limit: 1000 });
    expect(clientDump.riskLevel).toBe('high');
    expect(decide(clientDump, DEFAULT_POLICY)).toBe('allow');
  });
});

describe('helpers', () => {
  it('bumpLevel saturates at critical', () => {
    expect(bumpLevel('low')).toBe('medium');
    expect(bumpLevel('high')).toBe('critical');
    expect(bumpLevel('critical')).toBe('critical');
  });

  it('knows which families count toward the sensitive-read budget', () => {
    expect(isSensitiveFamily('payroll.team_overview')).toBe(true);
    expect(isSensitiveFamily('presentations.list_recent')).toBe(true);
    expect(isSensitiveFamily('kb.search')).toBe(false);
    expect(isSensitiveFamily('web.search')).toBe(false);
  });

  it('bogotaHour is UTC-5', () => {
    expect(bogotaHour(new Date('2026-03-10T19:00:00Z'))).toBe(14);
    expect(bogotaHour(new Date('2026-03-10T02:00:00Z'))).toBe(21);
  });

  it('every classification carries a human-readable reason', () => {
    const c = run('payroll.employee_profile', { employeeId: 'e-1' });
    expect(c.reason.length).toBeGreaterThan(10);
    expect(c.reason).not.toMatch(/undefined/);
  });
});
