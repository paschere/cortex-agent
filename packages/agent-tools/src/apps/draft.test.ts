import { describe, expect, it } from 'vitest';
import { type AppDraft, appDraftSchema } from './design';
import { StepFailed, buildAppPreview, describePlan, planCreations, runWithRollback } from './draft';
import { PREVIEW_USER_ID, sampleRows, seeded } from './sample-data';
import { APP_TEMPLATES } from './templates';

const tpl = APP_TEMPLATES[0] as (typeof APP_TEMPLATES)[number];

function draft(): AppDraft {
  return appDraftSchema.parse({
    name: tpl.name,
    description: tpl.body,
    icon: tpl.icon,
    roles: tpl.roles,
    screens: tpl.screens.map((s) => ({
      title: s.title,
      slug: s.slug,
      icon: s.icon,
      roles: s.roles,
      spec: s.spec,
    })),
    homeScreen: tpl.homeScreen,
    tables: tpl.trackers.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      fields: t.fields,
    })),
  });
}

describe('planCreations', () => {
  it('ordena tablas, app, roles, pantallas e inicio; omite lo que ya existe', () => {
    const d = draft();
    const plan = planCreations(d, new Set());
    expect(plan.map((s) => s.kind)).toEqual([
      ...d.tables.map(() => 'table'),
      'app',
      'roles',
      ...d.screens.map(() => 'screen'),
      'home',
    ]);
    const first = d.tables[0];
    const without = planCreations(d, new Set([first?.slug ?? '']));
    expect(without.filter((s) => s.kind === 'table')).toHaveLength(d.tables.length - 1);
    expect(describePlan(plan)[0]).toMatch(/^Tabla «/);
  });
});

describe('runWithRollback', () => {
  it('si un paso falla deshace lo hecho en orden inverso y lanza el error original', async () => {
    const log: string[] = [];
    const step = (label: string, fail = false) => ({
      label,
      run: async () => {
        if (fail) throw new Error('boom');
        log.push(`+${label}`);
        return async () => {
          log.push(`-${label}`);
        };
      },
    });
    const err = await runWithRollback([
      step('tabla'),
      step('app'),
      step('pantalla 1'),
      step('pantalla 2', true),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailed);
    expect((err as StepFailed).step).toBe('pantalla 2');
    expect((err as StepFailed).message).toBe('boom');
    expect(log).toEqual(['+tabla', '+app', '+pantalla 1', '-pantalla 1', '-app', '-tabla']);
    expect((err as StepFailed).report.undone).toEqual(['pantalla 1', 'app', 'tabla']);
  });
  it('si un deshacer también falla, lo dice y sigue con los demás', async () => {
    const err = (await runWithRollback([
      { label: 'a', run: async () => async () => undefined },
      {
        label: 'b',
        run: async () => async () => {
          throw new Error('no se pudo');
        },
      },
      {
        label: 'c',
        run: async () => {
          throw new Error('x');
        },
      },
    ]).catch((e) => e)) as StepFailed;
    expect(err.report.stuck).toEqual(['b']);
    expect(err.report.undone).toEqual(['a']);
  });
  it('si todo sale bien devuelve los pasos hechos y no deshace nada', async () => {
    let undone = 0;
    const done = await runWithRollback([
      { label: 'a', run: async () => async () => void undone++ },
      { label: 'b', run: async () => undefined },
    ]);
    expect(done).toEqual(['a', 'b']);
    expect(undone).toBe(0);
  });
});

describe('sampleRows', () => {
  const table = {
    slug: 'envios',
    name: 'Envíos',
    fields: [
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', required: true },
      { key: 'valor', label: 'Valor', type: 'money', required: true, min: 100000, max: 500000 },
      { key: 'fecha', label: 'Fecha', type: 'date', required: true, max: 'today' },
      {
        key: 'estado',
        label: 'Estado',
        type: 'select',
        required: true,
        options: ['A', 'B', 'C', 'Z'],
        flow: { states: ['A', 'B', 'C'] },
      },
      { key: 'ok', label: 'Ok', type: 'checkbox', required: false },
    ],
  } as const;
  const rows = sampleRows(
    { ...table, fields: table.fields as never },
    { today: '2026-10-11', count: 6 },
  );
  it('es determinista', () => {
    expect(
      sampleRows({ ...table, fields: table.fields as never }, { today: '2026-10-11', count: 6 }),
    ).toEqual(rows);
    expect(seeded('x')()).toBe(seeded('x')());
  });
  it('respeta tipos, límites y fechas no futuras; dinero en pesos enteros', () => {
    for (const r of rows) {
      const v = Number(r.values.valor);
      expect(v).toBeGreaterThanOrEqual(100000);
      expect(v).toBeLessThanOrEqual(500000);
      expect(Number.isInteger(v)).toBe(true);
      expect(String(r.values.fecha) <= '2026-10-11').toBe(true);
      expect(typeof r.values.nombre).toBe('string');
    }
  });
  it('el estado sólo toma estados del flujo y reparte', () => {
    expect(new Set(rows.map((r) => r.values.estado))).toEqual(new Set(['A', 'B', 'C']));
  });
  it('una de cada tres filas es de quien mira', () => {
    expect(rows.filter((r) => r.created_by === PREVIEW_USER_ID)).toHaveLength(2);
  });
  it('los ids no chocan entre tablas', () => {
    const other = sampleRows(
      { slug: 'otra', name: 'Otra', fields: table.fields as never },
      { today: '2026-10-11', count: 2 },
    );
    expect(other[0]?.id).not.toBe(rows[0]?.id);
  });
});

describe('buildAppPreview', () => {
  const d = draft();
  const now = new Date('2026-10-11T15:00:00Z');
  it('calcula cada pantalla de un rol con filas de ejemplo, sin tocar la base', () => {
    const p = buildAppPreview(d, [], { roleKey: 'administrador', now });
    expect(p.screens.length).toBe(d.screens.length);
    expect(Object.keys(p.views)).toHaveLength(d.screens.length);
    expect(p.samples.length).toBeGreaterThan(0);
    expect(p.samples[0]?.rows).toBeGreaterThan(0);
    expect(p.meta.roles.at(-1)?.key).toBe('administrador');
  });
  it('un rol sólo ve las pantallas que le tocan', () => {
    const onlyOne = d.roles.find((r) =>
      d.screens.some((s) => s.roles.length && !s.roles.includes(r.key)),
    );
    if (!onlyOne) return;
    const p = buildAppPreview(d, [], { roleKey: onlyOne.key, now });
    expect(p.screens.length).toBeLessThan(d.screens.length);
  });
  it('es repetible', () => {
    const a = buildAppPreview(d, [], { roleKey: 'administrador', now });
    const b = buildAppPreview(d, [], { roleKey: 'administrador', now });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
