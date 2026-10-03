import { MODULES, type ModuleKey } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { buildLauncher } from './launcher';

describe('todas las áreas', () => {
  it('muestra sólo lo prendido, agrupado por área, y cuenta lo apagado', () => {
    const on = new Set<ModuleKey>(['finance', 'payroll', 'contracts']);
    const launcher = buildLauncher(on);
    const hrefs = launcher.areas.flatMap((a) => a.links.map((l) => l.href));
    expect(hrefs).toEqual(expect.arrayContaining(['/finance', '/nomina', '/contratos']));
    expect(hrefs).not.toContain('/inventario');
    expect(launcher.off.length).toBe(MODULES.length - 3);
    expect(launcher.areas.map((a) => a.area)).toEqual(['Plata', 'Personas', 'Legal']);
  });

  it('sin nada prendido no hay áreas vacías', () => {
    const launcher = buildLauncher(new Set());
    expect(launcher.areas).toEqual([]);
    expect(launcher.off.length).toBe(MODULES.length);
  });
});
