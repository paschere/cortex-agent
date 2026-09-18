import { describe, expect, it } from 'vitest';
import { buildManagementInbox } from './inbox-overview';
import type { ManagementCase } from './shape';

const base = (id: string, overrides: Partial<ManagementCase['data']> = {}): ManagementCase => ({
  id,
  revision: 1,
  created_by: 'manager',
  updated_by: 'manager',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  data: {
    title: `Asunto ${id}`,
    objective: 'Conseguir un resultado verificable.',
    successCriteria: 'Revisión humana con evidencia.',
    ownerId: 'owner',
    dueOn: '2026-09-10',
    nextReviewOn: '2026-09-09',
    impact: 'medium',
    nextAction: 'Revisar la fuente.',
    blocker: '',
    state: 'working',
    sourceKey: null,
    sourceUrl: null,
    dependsOn: null,
    evidence: null,
    reviewNote: '',
    ...overrides,
  },
});

describe('buildManagementInbox', () => {
  it('keeps decision, blocked and working objects in one exclusive bucket', () => {
    const cases = [
      base('decision', {
        state: 'review',
        evidence: { reference: '/payments', observation: 'Saldo', observedOn: '2026-09-08' },
      }),
      base('blocked', { state: 'blocked', blocker: 'Falta permiso' }),
      base('working', { state: 'working', ownerId: 'manager' }),
    ];
    const inbox = buildManagementInbox(cases, 'manager', '2026-09-08', true);
    expect(inbox.decisions.map((item) => item.id)).toEqual(['decision']);
    expect(inbox.blocked.map((item) => item.id)).toEqual(['blocked']);
    expect(inbox.working.map((item) => item.id)).toEqual(['working']);
    expect(new Set(inbox.all.map((item) => item.id)).size).toBe(inbox.all.length);
  });

  it('deduplicates repeated rows for the same management object', () => {
    const item = base('repeated', { state: 'working' });
    const inbox = buildManagementInbox([item, { ...item }], 'manager', '2026-09-08', false);
    expect(inbox.all.map((entry) => entry.id)).toEqual(['repeated']);
  });

  it('explains evidence status without treating source provenance as closure', () => {
    const source = base('source', {
      activationEvidence: {
        runId: 'run',
        sourceId: 'source',
        sourceName: 'datos.csv',
        sheetIndex: 0,
        sheetName: 'Hoja 1',
        rows: [],
      } as never,
    });
    const missing = base('missing');
    const inbox = buildManagementInbox([source, missing], 'manager', '2026-09-08', false);
    expect(inbox.working.find((item) => item.id === 'source')?.evidenceLabel).toContain('Origen');
    expect(inbox.working.find((item) => item.id === 'missing')?.evidenceLabel).toContain('Falta');
  });

  it('puts an unassigned item in blocked even when its state is open', () => {
    const inbox = buildManagementInbox(
      [base('unassigned', { state: 'open', ownerId: null })],
      'manager',
      '2026-09-08',
      true,
    );
    expect(inbox.blocked[0]).toMatchObject({ id: 'unassigned', evidence: 'missing' });
  });
});
