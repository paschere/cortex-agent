import { describe, expect, it } from 'vitest';
import { planningCatalog, validateActivationPlan } from './planning';
import type { ActivationSource } from './types';

const source: ActivationSource = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'inventario.csv',
  createdAt: '',
  expiresAt: '',
  truncated: false,
  kind: 'table',
  canPrepare: true,
  preparedViews: [],
  sheets: [
    {
      index: 0,
      name: 'Inventario',
      rowCount: 3,
      headers: ['Producto', 'Stock', 'Notas privadas'],
    },
  ],
};
const sources = [source];
const definition = {
  version: 1,
  kind: 'table_rule',
  name: 'Inventario bajo',
  rule: 'conditions',
  conditions: [{ column: 1, operator: 'lt', value: '10' }],
  match: 'all',
  groupBy: [],
  evidenceColumns: [0],
  caseTitle: 'Revisar inventario',
  caseObjective: 'Validar unidades disponibles',
  caseNextAction: 'Consultar al responsable de compras',
};
const proposed = {
  sourceId: source.id,
  sheetIndex: 0,
  viewId: null,
  preparationPrompt: null,
  trigger: { kind: 'manual' as const, intervalMinutes: null },
  definitionJson: JSON.stringify(definition),
  explanation: 'Preparar un asunto para los productos con stock menor de 10.',
  questions: [],
  unsupportedRequirements: [],
};

describe('activation prompt planning boundary', () => {
  it('accepts a custom nonfinancial draft without executing it', () => {
    const plan = validateActivationPlan(proposed, sources);
    expect(plan.status).toBe('ready');
    expect(plan.draft?.definition).toEqual(definition);
    expect(plan.limitations.join(' ')).toContain('Gerencia');
  });
  it('rejects an invented or inaccessible source', () => {
    expect(
      validateActivationPlan({ ...proposed, sourceId: crypto.randomUUID() }, sources).draft,
    ).toBeNull();
  });
  it('rejects references to missing evidence columns', () => {
    expect(
      validateActivationPlan(
        { ...proposed, definitionJson: JSON.stringify({ ...definition, evidenceColumns: [90] }) },
        sources,
      ).status,
    ).toBe('needs_input');
  });
  it('does not silently downgrade an unsupported external action to a case', () => {
    const plan = validateActivationPlan(
      {
        ...proposed,
        unsupportedRequirements: [
          'Enviar una orden al ERP requiere una acción todavía no disponible.',
        ],
      },
      sources,
    );
    expect(plan.status).toBe('needs_input');
    expect(plan.draft).toBeNull();
  });
  it('requires clarification instead of applying an ambiguous draft', () => {
    expect(
      validateActivationPlan({ ...proposed, questions: ['¿Cuál es el umbral de stock?'] }, sources)
        .draft,
    ).toBeNull();
  });
  it('does not accept malformed or executable freeform definitions', () => {
    expect(
      validateActivationPlan({ ...proposed, definitionJson: '{"code":"fetch(secret)"}' }, sources)
        .draft,
    ).toBeNull();
    expect(
      validateActivationPlan({ ...proposed, definitionJson: 'not json' }, sources).draft,
    ).toBeNull();
  });
  it('bounds the planning catalog and never includes row values', () => {
    const catalog = planningCatalog(
      Array.from({ length: 30 }, (_, index) => ({ ...source, id: String(index) })),
    );
    expect(catalog).toHaveLength(20);
    expect(catalog[0]?.sheets[0]).not.toHaveProperty('rows');
    expect(planningCatalog(sources, 'another-company')).toEqual([]);
  });
  it('keeps textual sources in the bounded catalog before preparation', () => {
    const textSource: ActivationSource = {
      ...source,
      id: '22222222-2222-4222-8222-222222222222',
      filename: 'contratos.pdf',
      kind: 'document',
      sheets: [],
      preparedViews: [],
    };
    expect(planningCatalog([textSource])).toEqual([textSource]);
  });
  it('validates a rule against a prepared private view', () => {
    const withView: ActivationSource = {
      ...source,
      sheets: [],
      kind: 'document',
      preparedViews: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Obligaciones',
          headers: ['Responsable', 'Fecha'],
          rowCount: 2,
          createdAt: '',
          derived: true,
          private: true,
        },
      ],
    };
    const plan = validateActivationPlan(
      {
        ...proposed,
        sheetIndex: null,
        viewId: withView.preparedViews[0]?.id ?? null,
        definitionJson: JSON.stringify({
          ...definition,
          conditions: [{ column: 1, operator: 'before_today' }],
          evidenceColumns: [0],
        }),
      },
      [withView],
    );
    expect(plan.draft?.viewId).toBe(withView.preparedViews[0]?.id);
  });
  it('requires stable identity columns for recurring condition rules', () => {
    const plan = validateActivationPlan(
      { ...proposed, trigger: { kind: 'on_source_change', intervalMinutes: null } },
      sources,
    );
    expect(plan.status).toBe('needs_input');
    expect(plan.questions.join(' ')).toContain('identificar');
  });
  it('does not authorize recurring logic over a truncated capture', () => {
    const plan = validateActivationPlan(
      {
        ...proposed,
        trigger: { kind: 'on_source_change', intervalMinutes: null },
        definitionJson: JSON.stringify({ ...definition, identityColumns: [0] }),
      },
      [{ ...source, truncated: true }],
    );
    expect(plan.status).toBe('needs_input');
    expect(plan.questions.join(' ')).toContain('incompleta');
  });
});
