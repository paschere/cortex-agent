import { MODULE_KEYS, PLATFORM_SOURCES } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, startersFor } from './starter-templates';

/**
 * Las plantillas de los módulos de operación: cada una lleva el interruptor de
 * su módulo y sólo lee fuentes de ESE módulo. Que pasen el contrato y el
 * catálogo ya lo comprueba `editor-spec.test.ts`.
 */

describe('plantillas por módulo', () => {
  it('las nuevas existen y llevan un módulo real', () => {
    const byId = new Map(STARTER_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('programa_pagos')?.module).toBe('payables');
    expect(byId.get('inventario_bajo_minimo')?.module).toBe('inventory');
    expect(byId.get('embudo_comercial')?.module).toBe('crm');
    expect(byId.get('vencimientos_empresa')?.module).toBe('doc_expirations');
    for (const t of STARTER_TEMPLATES) if (t.module) expect(MODULE_KEYS, t.id).toContain(t.module);
  });

  it('cada una sólo lee fuentes del módulo del que depende', () => {
    for (const t of STARTER_TEMPLATES) {
      if (t.kind !== 'spec' || !t.module) continue;
      for (const b of t.spec.blocks) {
        const tracker = 'tracker' in b ? (b.tracker as string) : null;
        if (!tracker) continue;
        expect(PLATFORM_SOURCES.get(tracker)?.module, `${t.id}:${b.id}`).toBe(t.module);
      }
    }
  });

  it('con un módulo apagado no se ofrece su plantilla; las demás, siempre', () => {
    const all = startersFor([]).map((t) => t.id);
    expect(all).toEqual(STARTER_TEMPLATES.map((t) => t.id));
    const off = startersFor(['payables', 'inventory']).map((t) => t.id);
    expect(off).not.toContain('programa_pagos');
    expect(off).not.toContain('inventario_bajo_minimo');
    expect(off).toContain('embudo_comercial');
    expect(off).toContain('cartera');
    // Las del primer clic no dependen de ningún módulo.
    expect(startersFor([...MODULE_KEYS]).length).toBeGreaterThanOrEqual(4);
  });
});
