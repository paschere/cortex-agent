import { describe, expect, it } from 'vitest';
import { viewSpecSchema } from '../views/spec';
import { COMPARE_NOT_VERSIONED, compareSnapshots, renderComparison } from './versions-compare';
import { type Snapshot, buildSnapshot } from './versions-shape';

const spec = (blocks: unknown[]) =>
  viewSpecSchema.parse({ version: 1, refreshSeconds: 0, editing: 'team', alerts: [], blocks });

const app = {
  name: 'Planta',
  description: '',
  icon: '🚚',
  theme: {},
  home_screen: null,
  home: null,
  brand: {},
  dashboards: [],
  portal: { enabled: false, roleKey: 'cliente', attribute: 'cliente' } as never,
};

function snap(opts: {
  blocks: unknown[];
  screenRoles?: string[];
  perms?: unknown;
  extraRole?: boolean;
}): Snapshot {
  return buildSnapshot({
    app,
    screens: [
      { slug: 'registrar', title: 'Registrar', icon: 'X', roles: opts.screenRoles ?? [], view_id: 'v1' },
    ],
    views: new Map([['v1', { name: 'Registrar', spec: spec(opts.blocks) }]]),
    roles: [
      {
        key: 'operario',
        name: 'Operario',
        description: '',
        permissions:
          opts.perms ??
          ({ tables: { guias: { read: 'all', create: true, edit: 'none', actions: [] } }, export: false } as never),
      },
      ...(opts.extraRole
        ? [{ key: 'gerencia', name: 'Gerencia', description: '', permissions: { tables: {}, export: true } }]
        : []),
    ],
  } as never);
}

const form = (fields: string[], title = 'Registrar guía') => ({
  id: 'f1',
  type: 'form',
  tracker: 'guias',
  fields,
  title,
});

describe('compareSnapshots', () => {
  it('iguales = sin líneas, y el texto dice qué no se compara', () => {
    const a = snap({ blocks: [form(['numero'])] });
    expect(compareSnapshots(a, a)).toEqual([]);
    expect(renderComparison([], 'v1 → v2')).toContain(COMPARE_NOT_VERSIONED);
  });

  it('campos agregados y quitados en un formulario, bloques nuevos y quitados', () => {
    const before = snap({ blocks: [form(['numero', 'kilos'])] });
    const after = snap({
      blocks: [
        form(['numero', 'cliente']),
        { id: 't1', type: 'table', tracker: 'guias', title: 'Guías de hoy' },
      ],
    });
    const lines = compareSnapshots(before, after).map((l) => l.text);
    expect(lines).toContain('Pantalla «Registrar», formulario «Registrar guía»: campos nuevos: «cliente»; campos quitados: «kilos»');
    expect(lines).toContain('Pantalla «Registrar»: bloque nuevo, tabla «Guías de hoy»');
    const reverse = compareSnapshots(after, before).map((l) => l.text);
    expect(reverse).toContain('Pantalla «Registrar»: bloque quitado, tabla «Guías de hoy»');
  });

  it('quién ve la pantalla y pantallas nuevas', () => {
    const before = snap({ blocks: [form([])] });
    const after = snap({ blocks: [form([])], screenRoles: ['supervisor'] });
    expect(compareSnapshots(before, after).map((l) => l.text)).toContain(
      'Pantalla «Registrar»: la ven «supervisor» (antes todos)',
    );
  });

  it('permisos de un rol, tabla por tabla, y roles nuevos', () => {
    const before = snap({ blocks: [form([])] });
    const after = snap({
      blocks: [form([])],
      extraRole: true,
      perms: {
        tables: {
          guias: { read: 'own', create: true, edit: 'own', fields: ['kilos'], actions: ['__approve'] },
          clientes: { read: 'all', create: false, edit: 'none', actions: [] },
        },
        export: true,
      },
    });
    const text = compareSnapshots(before, after)
      .map((l) => l.text)
      .join('\n');
    expect(text).toMatch(/Rol «Operario»: en «guias»: ve sólo lo que registró \(antes ve todas las filas\)/);
    expect(text).toMatch(/edita sólo lo suyo \(antes no edita\)/);
    expect(text).toMatch(/escribe sólo «kilos»/);
    expect(text).toMatch(/botones nuevos: «__approve»/);
    expect(text).toMatch(/Rol «Operario»: ahora usa «clientes»/);
    expect(text).toMatch(/Rol «Operario»: ahora puede exportar/);
    expect(text).toMatch(/Rol nuevo «Gerencia»/);
    const out = renderComparison(compareSnapshots(before, after), 'Versión 1 → borrador');
    expect(out).toMatch(/Agregado \(\d+\):/);
    expect(out).toMatch(/Cambiado \(\d+\):/);
  });
});
