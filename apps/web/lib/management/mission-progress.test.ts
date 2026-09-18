import type { ActivationRun, ActivationSource } from '@/lib/activations/types';
import { describe, expect, it } from 'vitest';
import { buildMissionProgress } from './mission-progress';
import type { ManagementCase } from './shape';

const source: ActivationSource = {
  id: 'source-1',
  filename: 'pendientes.csv',
  createdAt: '2026-09-08T12:00:00.000Z',
  expiresAt: '2026-09-15T12:00:00.000Z',
  truncated: false,
  kind: 'table',
  canPrepare: false,
  sheets: [{ index: 0, name: 'Hoja 1', rowCount: 4, headers: ['id', 'estado'] }],
  preparedViews: [],
};

const run = (overrides: Partial<ActivationRun> = {}): ActivationRun => ({
  id: 'run-1',
  sourceId: 'source-1',
  sourceName: 'pendientes.csv',
  viewId: null,
  sheetIndex: 0,
  sheetName: 'Hoja 1',
  definition: {
    version: 1,
    name: 'Pendientes vencidos',
    kind: 'table_rule',
    rule: 'conditions',
    conditions: [{ column: 1, operator: 'equals', value: 'pendiente' }],
    match: 'all',
    groupBy: [],
    identityColumns: [0],
    caseTitle: 'Revisar {{id}}',
    caseObjective: 'Resolver el pendiente.',
    caseNextAction: 'Contactar al responsable.',
  },
  mapping: null,
  status: 'simulated',
  candidates: [],
  createdAt: '2026-09-08T12:00:00.000Z',
  committedAt: null,
  caseIds: [],
  ...overrides,
});

const managementCase = (overrides: Partial<ManagementCase['data']> = {}): ManagementCase => ({
  id: 'case-1',
  revision: 1,
  created_by: 'actor',
  updated_by: 'actor',
  created_at: '2026-09-08T12:00:00.000Z',
  updated_at: '2026-09-08T12:00:00.000Z',
  data: {
    title: 'Revisar pendiente',
    objective: 'Resolverlo.',
    successCriteria: 'Evidencia revisada.',
    ownerId: 'actor',
    dueOn: '2026-09-10',
    nextReviewOn: '2026-09-09',
    impact: 'medium',
    nextAction: 'Contactar al responsable.',
    blocker: '',
    state: 'review',
    sourceKey: 'activation:table:1:case',
    sourceUrl: null,
    dependsOn: null,
    evidence: {
      reference: '/payments',
      observation: 'Se observó el resultado.',
      observedOn: '2026-09-08',
    },
    reviewNote: '',
    ...overrides,
  },
});

describe('buildMissionProgress', () => {
  it('starts with pending objective and source without inventing a completed step', () => {
    const result = buildMissionProgress({ sources: [], runs: [], cases: [] });
    expect(result.phases.map((phase) => phase.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(result.complete).toBe(false);
    expect(result.resumeHref).toBeNull();
  });

  it('resumes a saved simulation and keeps the source actor scoped by its input', () => {
    const result = buildMissionProgress({ sources: [source], runs: [run()], cases: [] });
    expect(result.objective).toBe('Resolver el pendiente.');
    expect(result.phases[0]?.state).toBe('ready');
    expect(result.phases[1]?.state).toBe('ready');
    expect(result.phases[2]?.state).toBe('ready');
    expect(result.phases[3]?.state).toBe('pending');
    expect(result.resumeHref).toContain('sourceId=source-1');
    expect(result.resumeHref).toContain('prompt=');
  });

  it('distinguishes committed output awaiting review from a verified result', () => {
    const committed = run({
      status: 'committed',
      committedAt: '2026-09-08T13:00:00.000Z',
      caseIds: ['case-1'],
    });
    const pendingReview = buildMissionProgress({
      sources: [source],
      runs: [committed],
      cases: [managementCase({ state: 'review' })],
    });
    expect(pendingReview.results).toEqual({ created: 1, readyForReview: 1, verified: 0 });
    expect(pendingReview.phases[3]?.state).toBe('review');
    expect(pendingReview.complete).toBe(false);

    const verified = buildMissionProgress({
      sources: [source],
      runs: [committed],
      cases: [managementCase({ state: 'verified', reviewNote: 'Confirmado por el responsable.' })],
    });
    expect(verified.results.verified).toBe(1);
    expect(verified.phases[3]?.state).toBe('verified');
  });

  it('keeps a newer simulation separate from an older committed result', () => {
    const olderCommitted = run({
      id: 'run-old',
      status: 'committed',
      createdAt: '2026-09-07T12:00:00.000Z',
      committedAt: '2026-09-07T13:00:00.000Z',
      caseIds: ['case-1'],
    });
    const newerSimulation = run({
      id: 'run-new',
      createdAt: '2026-09-08T12:00:00.000Z',
      definition: {
        ...run().definition,
        name: 'Inventario bajo',
        caseObjective: 'Reponer el inventario bajo.',
      },
    });
    const result = buildMissionProgress({
      sources: [source],
      runs: [olderCommitted, newerSimulation],
      cases: [managementCase()],
    });

    expect(result.latestRun?.id).toBe('run-new');
    expect(result.committedRun).toBeNull();
    expect(result.objective).toBe('Reponer el inventario bajo.');
    expect(result.results).toEqual({ created: 0, readyForReview: 0, verified: 0 });
    expect(result.phases[3]?.state).toBe('pending');
    expect(result.complete).toBe(false);
  });

  it('prefers a selected run and exposes unavailable reads as unknown', () => {
    const committed = run({
      id: 'run-committed',
      status: 'committed',
      committedAt: '2026-09-08T13:00:00.000Z',
      caseIds: ['case-1'],
    });
    const result = buildMissionProgress({
      sources: [],
      sourceCount: null,
      runs: [run(), committed],
      selectedRunId: 'run-committed',
      cases: [managementCase()],
      runsAvailable: false,
      casesAvailable: false,
      errors: ['No se pudo leer el historial de simulaciones.'],
    });

    expect(result.latestRun?.id).toBe('run-committed');
    expect(result.phases[0]?.state).toBe('ready');
    expect(result.phases[1]?.state).toBe('unknown');
    expect(result.phases[2]?.state).toBe('ready');
    expect(result.errors).toEqual(['No se pudo leer el historial de simulaciones.']);

    const unavailable = buildMissionProgress({
      sources: [],
      sourceCount: null,
      runs: [],
      cases: [],
      runsAvailable: false,
      casesAvailable: false,
      errors: ['No se pudo leer el historial de simulaciones.'],
    });
    expect(unavailable.phases.map((phase) => phase.state)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('does not mark an expired source ready because another source exists', () => {
    const otherSource = { ...source, id: 'source-other', filename: 'otra.csv' };
    const result = buildMissionProgress({
      sources: [otherSource],
      runs: [run()],
      cases: [],
    });

    expect(result.sourceCount).toBe(1);
    expect(result.phases[1]?.state).toBe('pending');
    expect(result.phases[1]?.detail).toContain('ya no está disponible');
  });

  it('preserves a verified result after its private run and source are purged', () => {
    const historical = managementCase({
      state: 'verified',
      activationEvidence: {
        runId: 'run-history',
        sourceId: 'source-expired',
        sourceName: 'pendientes-expirados.csv',
        sheetIndex: 0,
        sheetName: 'Hoja 1',
        definition: run().definition,
        rows: [],
      },
    });
    const result = buildMissionProgress({
      sources: [],
      runs: [],
      cases: [],
      historicalCases: [historical],
    });

    expect(result.latestRun).toBeNull();
    expect(result.committedRun).toBeNull();
    expect(result.history).toMatchObject({
      runId: 'run-history',
      sourceId: 'source-expired',
      sourceName: 'pendientes-expirados.csv',
      results: { created: 1, readyForReview: 0, verified: 1 },
    });
    expect(result.objective).toBe('Resolver el pendiente.');
    expect(result.cases.map((item) => item.id)).toEqual(['case-1']);
    expect(result.results).toEqual({ created: 1, readyForReview: 0, verified: 1 });
    expect(result.phases[0]?.state).toBe('ready');
    expect(result.phases[1]?.state).toBe('unknown');
    expect(result.phases[2]?.state).toBe('unknown');
    expect(result.phases[3]?.state).toBe('verified');
    expect(result.resumeHref).toBeNull();
    expect(result.complete).toBe(true);
  });
});
