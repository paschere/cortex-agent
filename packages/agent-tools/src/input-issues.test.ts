import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeInputIssues, schemaKeys } from './input-issues';

const upsert = z.object({
  tracker: z.string(),
  rowId: z.string().uuid().optional(),
  values: z.record(z.string()),
  label: z.string().optional(),
});

describe('describeInputIssues', () => {
  it('dice qué falta, qué sobra y qué acepta, en español', () => {
    const input = { tracker: 'tarifas', rows: [{ values: { a: 'b' } }] };
    const parsed = upsert.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const msg = describeInputIssues('trackers.upsert', upsert, input, parsed.error);
    expect(msg).toContain('trackers_upsert');
    expect(msg).toContain('values: es obligatorio');
    expect(msg).toContain('rows');
    expect(msg).toContain('Campos que acepta: tracker, rowId, values, label');
    expect(msg).toContain('no concluyas que no existe');
    expect(msg).not.toContain('Invalid input');
  });

  it('atraviesa refine y transform para listar las claves', () => {
    const wrapped = upsert.refine(() => true);
    expect(schemaKeys(wrapped)).toEqual(['tracker', 'rowId', 'values', 'label']);
  });

  it('acota la cantidad de problemas', () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, z.string()])),
    );
    const parsed = wide.safeParse({});
    if (parsed.success) throw new Error('debía fallar');
    expect(describeInputIssues('x.y', wide, {}, parsed.error)).toContain('(y 4 más)');
  });
});
