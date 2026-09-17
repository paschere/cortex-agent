import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import {
  type ManagementCase,
  defaultManagementProfile,
  managementActivationEvidenceSchema,
  managementCaseSchema,
  managementDailyReport,
  managementDate,
  managementLink,
  managementPriority,
  managementSourceConflicts,
  validateManagementTransition,
} from './shape';
import { readManagement, readManagementSignals, saveManagementCase } from './store';
const owner = '11111111-1111-4111-a111-111111111111';
const datum = () =>
  managementCaseSchema.parse({
    title: 'Cobro',
    objective: 'Conciliar ingreso',
    successCriteria: 'Comprobante y saldo conciliados',
    ownerId: owner,
    dueOn: '2026-09-08',
    nextReviewOn: '2026-09-06',
    impact: 'high',
    nextAction: 'Consultar el pago',
  });
const row = (data = {}) =>
  ({
    id: '22222222-2222-4222-a222-222222222222',
    data: { ...datum(), ...data },
    revision: 1,
    created_by: owner,
    updated_by: owner,
    created_at: '2026-09-05T12:00:00Z',
    updated_at: '2026-09-05T12:00:00Z',
  }) satisfies ManagementCase;
describe('gerencia: criterios, evidencia y fechas', () => {
  it('acepta evidencia genérica y conserva sólo los valores elegidos', () => {
    const evidence = managementActivationEvidenceSchema.parse({
      runId: '33333333-3333-4333-a333-333333333333',
      sourceId: '44444444-4444-4444-a444-444444444444',
      sourceName: 'clientes.xlsx',
      sheetIndex: 1,
      sheetName: 'Renovaciones',
      definition: {
        version: 1,
        name: 'Renovaciones vencidas',
        kind: 'table_rule',
        rule: 'conditions',
        conditions: [{ column: 2, operator: 'before_today' }],
        match: 'all',
        groupBy: [],
        caseTitle: 'Revisar renovación',
        caseObjective: 'Confirmar la fecha',
        caseNextAction: 'Contactar al responsable',
      },
      rows: [
        {
          rowIndex: 4,
          sourceKey: 'renewal:4',
          status: 'matched',
          values: [{ column: 2, header: 'Vencimiento', value: '2026-09-01' }],
          reasons: ['La fecha ya venció'],
          groupKey: null,
          unsharedCustomerNotes: 'no debe viajar a Gerencia',
        },
      ],
    });
    expect(evidence.rows[0]).toEqual({
      rowIndex: 4,
      sourceKey: 'renewal:4',
      status: 'matched',
      values: [{ column: 2, header: 'Vencimiento', value: '2026-09-01' }],
      reasons: ['La fecha ya venció'],
      groupKey: null,
    });
  });

  it('no acepta fechas inexistentes ni referencias ejecutables', () => {
    expect(managementDate.safeParse('2026-02-30').success).toBe(false);
    for (const url of [
      'javascript:alert(1)',
      '//evil.test',
      'http://example.com',
      'https://user:pass@example.com',
      '/goals\\evil',
    ])
      expect(managementLink.safeParse(url).success).toBe(false);
    expect(managementLink.safeParse('/browser/flow-id').success).toBe(true);
    expect(managementLink.safeParse('https://example.com/receipt').success).toBe(true);
  });
  it('un vencido supera un asunto de alto impacto dentro de plazo', () => {
    expect(
      managementPriority(row({ dueOn: '2026-09-04', impact: 'low' }), '2026-09-05').score,
    ).toBeGreaterThan(managementPriority(row(), '2026-09-05').score);
    expect(managementPriority(row({ state: 'verified' }), '2026-09-05').score).toBe(-1);
  });
  it('dependencia pendiente tiene razón explícita, verificada no bloquea', () => {
    const dependency = row({ state: 'working' });
    const item = { ...row({ dependsOn: dependency.id }), id: 'parent' };
    expect(managementPriority(item, '2026-09-05', [dependency]).reasons).toContain(
      'Depende de un asunto sin verificar',
    );
    expect(
      managementPriority(item, '2026-09-05', [
        { ...dependency, data: { ...dependency.data, state: 'verified' } },
      ]).reasons,
    ).not.toContain('Depende de un asunto sin verificar');
  });
  it('no confunde intento con resultado ni deja al agente verificar', () => {
    const d = datum();
    expect(() =>
      validateManagementTransition(
        d,
        { ...d, state: 'working', ownerId: null },
        false,
        '2026-09-05',
      ),
    ).toThrow(/responsable/);
    expect(() =>
      validateManagementTransition(d, { ...d, state: 'blocked' }, false, '2026-09-05'),
    ).toThrow(/impide/);
    expect(() =>
      validateManagementTransition(d, { ...d, state: 'review' }, false, '2026-09-05'),
    ).toThrow(/referencia/);
    const review = {
      ...d,
      state: 'review' as const,
      evidence: {
        reference: 'https://example.com/receipt',
        observation: 'Ingreso conciliado',
        observedOn: '2026-09-05',
      },
    };
    expect(() => validateManagementTransition(d, review, false, '2026-09-05')).not.toThrow();
    expect(() =>
      validateManagementTransition(
        review,
        { ...review, state: 'verified', reviewNote: 'Verificado' },
        false,
        '2026-09-05',
      ),
    ).toThrow(/administrador/);
    expect(() =>
      validateManagementTransition(
        review,
        { ...review, state: 'verified', reviewNote: 'Verificado' },
        true,
        '2026-09-05',
      ),
    ).not.toThrow();
    expect(() =>
      validateManagementTransition(
        d,
        { ...review, evidence: { ...review.evidence, observedOn: '2026-09-06' } },
        false,
        '2026-09-05',
      ),
    ).toThrow(/futura/);
  });
  it('el parte identifica falta de datos y no afirma ejecución o escalamiento', () => {
    const report = managementDailyReport(
      [row({ ownerId: null, dueOn: '2026-09-04' })],
      [],
      defaultManagementProfile,
      '2026-09-05',
      true,
    );
    expect(report).toContain('Vista parcial');
    expect(report).toContain('Plazo vencido');
    expect(report).toContain('no envía mensajes');
    expect(managementDailyReport([], [], defaultManagementProfile, '2026-09-05')).toContain(
      'según los registros consultados',
    );
  });
});
describe('gerencia: separación de datos', () => {
  it('la mesa y el directorio solo leen la empresa activa', async () => {
    const { client } = createFakeSupabase({
      management_cases: [
        { ...row(), organization_id: 'acme' },
        { ...row(), id: 'other', organization_id: 'other' },
      ],
      management_profiles: [],
      users: [
        { id: owner, organization_id: 'acme', name: 'Ana', email: 'ana@example.test' },
        { id: 'other', organization_id: 'other', name: 'Otra', email: 'other@example.test' },
      ],
    });
    const view = await readManagement(createOrgScopedClient(client, 'acme'));
    expect(view.cases).toHaveLength(1);
    expect(view.people).toHaveLength(1);
    expect(view.profile.revision).toBe(0);
  });
  it('aprobaciones y encargos respetan al usuario, fechas no confirmadas no son hechos', async () => {
    const { client } = createFakeSupabase({
      commitments: [
        {
          organization_id: 'acme',
          id: 'pending',
          title: 'Propuesta',
          review_state: 'pending',
          state: 'in_force',
          due_on: '2026-01-01',
        },
        {
          organization_id: 'other',
          id: 'foreign',
          title: 'Otra empresa',
          review_state: 'confirmed',
          state: 'in_force',
          due_on: '2026-01-01',
        },
      ],
      goals: [],
      goal_readings: [],
      mcp_pending_actions: [
        {
          id: 'mine',
          organization_id: 'acme',
          user_id: owner,
          tool_id: 'gmail.send',
          decision: null,
          expires_at: '2099-01-01T00:00:00Z',
        },
        {
          id: 'private',
          organization_id: 'acme',
          user_id: 'other',
          tool_id: 'gmail.send',
          decision: null,
          expires_at: '2099-01-01T00:00:00Z',
        },
      ],
      errands: [
        {
          id: 'private',
          organization_id: 'acme',
          user_id: 'other',
          request: 'Dato privado',
          state: 'blocked',
        },
      ],
    });
    const view = await readManagementSignals(
      createOrgScopedClient(client, 'acme'),
      owner,
      '2026-09-05',
    );
    expect(view.signals.map((s) => s.key)).toEqual(['approval:mine']);
  });
  it('no permite que management.record marque un cierre como humano', async () => {
    const data = {
      ...datum(),
      state: 'review' as const,
      evidence: {
        reference: 'https://example.com',
        observation: 'Resultado',
        observedOn: '2020-01-01',
      },
    };
    const { client, rpcCalls } = createFakeSupabase({
      management_cases: [{ ...row(), data, organization_id: 'acme' }],
      users: [{ id: owner, organization_id: 'acme', role: 'org_admin' }],
    });
    await expect(
      saveManagementCase(
        createOrgScopedClient(client, 'acme'),
        owner,
        { ...data, state: 'verified', reviewNote: 'Sí' },
        { id: row().id, revision: 1, humanReview: false },
      ),
    ).rejects.toThrow(/administrador/);
    expect(rpcCalls).toHaveLength(0);
  });

  it('preserva evidencia de activación del servidor y descarta intentos del cliente', async () => {
    const activationEvidence = {
      runId: '33333333-3333-4333-a333-333333333333',
      sourceId: '44444444-4444-4444-a444-444444444444',
      sourceName: 'facturas.xlsx',
      sheetIndex: 0,
      sheetName: 'Septiembre',
      rows: [
        {
          rowIndex: 7,
          invoiceNumber: 'FV-7',
          issuer: 'Proveedor',
          amount: '125000',
          currency: 'COP',
          issuedOn: '2026-09-01',
          sourceKey: 'invoice:FV-7',
          status: 'possible_duplicate' as const,
          conflicts: ['Coincide con FV-7'],
        },
      ],
    };
    const existing = row({ activationEvidence });
    expect(
      managementCaseSchema.parse({
        ...datum(),
        activationEvidence: { ...activationEvidence, sourceName: 'archivo-falso.xlsx', rows: [] },
      }),
    ).not.toHaveProperty('activationEvidence');
    const { client, rpcCalls } = createFakeSupabase(
      {
        management_cases: [{ ...existing, organization_id: 'acme' }],
        users: [{ id: owner, organization_id: 'acme', role: 'org_admin' }],
      },
      {
        management_save_case: (args) => ({ ...existing, data: args.p_data }),
      },
    );

    await saveManagementCase(
      createOrgScopedClient(client, 'acme'),
      owner,
      {
        ...existing.data,
        title: 'Cobro actualizado',
        activationEvidence: { ...activationEvidence, sourceName: 'archivo-falso.xlsx', rows: [] },
      },
      { id: existing.id, revision: existing.revision, humanReview: true },
    );

    expect(rpcCalls[0]?.args.p_data).toMatchObject({
      title: 'Cobro actualizado',
      activationEvidence,
    });
  });
});

it('un cierre no oculta una fuente operativa que sigue pendiente', () => {
  const signal = {
    key: 'commitment:one',
    title: 'Vencimiento',
    reason: 'Vencido',
    href: '/commitments',
    dueOn: '2026-09-04',
    ownerId: owner,
    impact: 'high' as const,
  };
  expect(
    managementSourceConflicts([signal], [row({ state: 'verified', sourceKey: signal.key })]),
  ).toHaveLength(1);
  expect(
    managementSourceConflicts([signal], [row({ state: 'working', sourceKey: signal.key })]),
  ).toHaveLength(0);
  expect(
    managementSourceConflicts(
      [{ ...signal, key: 'goal:one' }],
      [row({ state: 'verified', sourceKey: 'goal:one' })],
    ),
  ).toHaveLength(0);
});
