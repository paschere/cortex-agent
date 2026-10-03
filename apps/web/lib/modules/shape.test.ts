import { MODULES, type ModuleKey } from '@cortex/agent-tools/src/modules/catalog';
import { describe, expect, it } from 'vitest';
import { templatesFor } from '../self-service/catalog';
import { ROUTE_LABEL, buildModuleAreas, dependencyText, modulePageState } from './shape';

const defaults = () => new Set(MODULES.filter((m) => m.defaultOn).map((m) => m.key));

describe('la pantalla de un módulo', () => {
  it('prendido, la página sigue', () => {
    expect(modulePageState('finance', defaults(), true)).toEqual({ off: false });
  });

  it('apagado, dice cuál y si quien mira lo puede prender', () => {
    const admin = modulePageState('payroll', defaults(), true);
    expect(admin).toMatchObject({ off: true, label: 'Nómina', canEnable: true });
    const member = modulePageState('payroll', defaults(), false);
    expect(member).toMatchObject({ off: true, canEnable: false });
  });

  it('avisa lo que se prende con él', () => {
    const on = defaults();
    on.delete('finance');
    on.delete('payables');
    expect(modulePageState('payables', on, true)).toMatchObject({
      off: true,
      alsoEnables: ['Finanzas'],
    });
  });
});

describe('las tarjetas de Ajustes › Módulos', () => {
  const states = MODULES.map((m) => ({ key: m.key, enabled: m.defaultOn, isDefault: true }));

  it('cada módulo sale una vez, agrupado por área', () => {
    const areas = buildModuleAreas(states);
    const keys = areas.flatMap((a) => a.modules.map((m) => m.key));
    expect(new Set(keys)).toEqual(new Set(MODULES.map((m) => m.key)));
    expect(keys.length).toBe(MODULES.length);
    for (const a of areas)
      for (const m of a.modules) expect(MODULES.find((x) => x.key === m.key)?.area).toBe(a.area);
  });

  it('cada pantalla de un módulo tiene su nombre en palabras', () => {
    for (const m of MODULES) for (const r of m.routes) expect(ROUTE_LABEL[r], r).toBeTruthy();
  });

  it('un módulo que otro prendido necesita no se puede apagar, y lo dice', () => {
    const finance = buildModuleAreas(states)
      .flatMap((a) => a.modules)
      .find((m) => m.key === 'finance');
    expect(finance?.blockedBy).toEqual(['Cuentas por pagar']);
    expect(dependencyText('payables')).toBe('Necesita Finanzas.');
  });

  it('las herramientas llegan en palabras', () => {
    const areas = buildModuleAreas(states, { inventory: ['Ver el inventario'] });
    const inv = areas.flatMap((a) => a.modules).find((m) => m.key === 'inventory');
    expect(inv?.tools).toEqual(['Ver el inventario']);
    expect(inv?.screens).toEqual([{ href: '/inventario', label: 'Inventario y compras' }]);
  });
});

describe('/procesos sin los módulos apagados', () => {
  it('esconde los procesos de un módulo apagado y deja los demás', () => {
    const off: ModuleKey[] = ['taxes', 'inventory'];
    const ids = templatesFor(off).map((t) => t.id);
    expect(ids).not.toContain('tax_calendar');
    expect(ids).not.toContain('dian_rut');
    expect(ids).not.toContain('inventory');
    expect(ids).toContain('receivables');
    expect(templatesFor().length).toBeGreaterThan(ids.length);
  });
});
