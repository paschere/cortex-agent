import { describe, expect, it } from 'vitest';
import { getTool } from '../../registry';
import { cortexPlan, cortexPlanUpdate, normalizePlan } from '../plan';

describe('cortex.plan', () => {
  it('está registrada, no pide confirmación y viaja en la familia siempre activa', async () => {
    for (const tool of [cortexPlan, cortexPlanUpdate]) {
      expect(getTool(tool.id)).toBeDefined();
      expect(tool.requiresConfirmation).toBeFalsy();
      expect(tool.id.split('.')[0]).toBe('cortex');
    }
    const { BASE_FAMILIES } = await import('../../tool-selection');
    expect(BASE_FAMILIES).toContain('cortex');
  });

  it('devuelve lo recibido: pasos pendientes, texto limpio e ids únicos', () => {
    const out = normalizePlan({
      title: '  Armar   la tabla ',
      steps: [
        { id: '1', label: ' Leer   el extracto ' },
        { id: '1', label: 'Crear la tabla', note: ' con NIT ' },
      ],
    });
    expect(out.title).toBe('Armar la tabla');
    expect(out.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(out.steps[0]?.label).toBe('Leer el extracto');
    expect(new Set(out.steps.map((s) => s.id)).size).toBe(2);
    expect(out.steps[1]?.note).toBe('con NIT');
  });

  it('rechaza un plan vacío o con más de doce pasos', () => {
    expect(cortexPlan.inputSchema.safeParse({ title: 'x1', steps: [] }).success).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({ id: String(i), label: `Paso ${i}` }));
    expect(cortexPlan.inputSchema.safeParse({ title: 'Muchos', steps: many }).success).toBe(false);
  });

  it('plan_update acepta los cinco estados y rechaza otros', () => {
    for (const status of ['pending', 'in_progress', 'done', 'failed', 'skipped']) {
      expect(
        cortexPlanUpdate.inputSchema.safeParse({ updates: [{ id: '1', status }] }).success,
      ).toBe(true);
    }
    expect(
      cortexPlanUpdate.inputSchema.safeParse({ updates: [{ id: '1', status: 'volando' }] }).success,
    ).toBe(false);
  });
});
