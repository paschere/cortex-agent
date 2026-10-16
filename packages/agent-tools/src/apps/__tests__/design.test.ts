import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext } from '../../types';
import { viewSpecSchema } from '../../views/spec';
import { appsDesign, reviewAppDraft } from '../design';
import { CONTROL_EN_PLANTA, PORTAL_CLIENTES } from '../templates';

/**
 * APPS.DESIGN: EL BORRADOR COMPLETO, SIN GUARDAR NADA (fase 4).
 *
 * El modelo del chat arma el diseño; esta herramienta lo comprueba contra las
 * tablas REALES y lo devuelve normalizado con un resumen. Lo que se prueba:
 * que no escribe nunca, que una tabla inexistente vuelve como problema con la
 * regla de siempre (primero proponer la tabla), que cruza roles con pantallas
 * y que sólo la usa quien administra.
 */

const ORG = 'org-postal';
const ADMIN = 'u-admin';
const MIEMBRO = 'u-miembro';

function world() {
  const fake = createFakeSupabase({
    users: [
      {
        id: ADMIN,
        organization_id: ORG,
        name: 'Admin',
        email: 'a@p.co',
        role: 'org_admin',
        created_at: '2026-10-01T00:00:00Z',
      },
      {
        id: MIEMBRO,
        organization_id: ORG,
        name: 'Mia',
        email: 'm@p.co',
        role: 'member',
        created_at: '2026-10-02T00:00:00Z',
      },
    ],
    trackers: [
      {
        id: 'trk',
        organization_id: ORG,
        slug: 'guias',
        name: 'Guías',
        description: '',
        fields: CONTROL_EN_PLANTA.trackers[0]?.fields ?? [],
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    tracker_rows: [],
    custom_apps: [],
    custom_app_screens: [],
    custom_views: [],
    custom_app_roles: [],
  });
  const db = createOrgScopedClient(fake.client, ORG);
  const ctx = (userId: string) =>
    ({
      db,
      userId,
      organizationId: ORG,
      agentId: 'a',
      logger: console,
      integrations: {},
    }) as unknown as ToolContext;
  return { fake, db, ctx };
}

const tabla = viewSpecSchema.parse({
  version: 1,
  accent: 'primary',
  refreshSeconds: 0,
  editing: 'off',
  alerts: [],
  blocks: [
    {
      id: 'lista',
      type: 'table',
      width: 'full',
      tracker: 'guias',
      title: 'Guías',
      columns: ['numero_guia', 'estado'],
      limit: 50,
    },
  ],
});

const roles = [
  {
    key: 'consulta',
    name: 'Consulta',
    description: 'Mira las guías.',
    permissions: {
      tables: { guias: { read: 'all', create: false, edit: 'none', actions: [] } },
      export: false,
    },
  },
];

const base = {
  name: 'Consulta de guías',
  roles,
  screens: [{ title: 'Guías', roles: ['consulta'], spec: tabla }],
};

describe('apps.design', () => {
  it('un diseño bueno vuelve normalizado, con resumen y SIN escribir nada', async () => {
    const { ctx, fake } = world();
    const counts = () =>
      Object.fromEntries(
        Object.entries(fake.tables)
          .filter(([, rows]) => rows.length)
          .map(([name, rows]) => [name, JSON.stringify(rows)]),
      );
    const before = counts();
    const res = await appsDesign.handler(
      { description: 'Una consulta de guías para el equipo', ...base } as never,
      ctx(ADMIN),
    );
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
    const draft = res.draft as { screens: Array<{ slug: string }>; homeScreen: string };
    expect(draft.screens[0]?.slug).toBe('guias');
    expect(draft.homeScreen).toBe('guias');
    expect(res.markdown).toContain('Consulta');
    expect(res.markdown).toContain('nada se ha guardado');
    // Nada creado: ni app, ni pantallas, ni vistas, ni roles.
    expect(counts()).toEqual(before);
    expect(fake.tables.custom_apps).toHaveLength(0);
  });

  it('una tabla que no existe vuelve como problema con la regla de siempre (primero proponer la tabla)', async () => {
    const { ctx } = world();
    const spec = viewSpecSchema.parse({
      ...tabla,
      blocks: [{ ...tabla.blocks[0], id: 'x', tracker: 'inspecciones' }],
    });
    const res = await appsDesign.handler(
      {
        description: 'Inspecciones desde mi hoja',
        name: 'Inspecciones',
        roles: [
          {
            ...roles[0],
            permissions: {
              tables: { inspecciones: roles[0]?.permissions.tables.guias },
              export: false,
            },
          },
        ],
        screens: [{ title: 'Inspecciones', roles: [], spec }],
      } as never,
      ctx(ADMIN),
    );
    expect(res.ok).toBe(false);
    expect(res.draft).toBeNull();
    expect(res.problems.join(' ')).toMatch(
      /No existe la tabla «inspecciones».*propose_from_source/,
    );
  });

  it('cruza roles con pantallas y campos reales', async () => {
    const { db } = world();
    const malo = await reviewAppDraft(db, {
      ...base,
      screens: [{ title: 'Guías', roles: ['fantasma'], spec: tabla }],
      roles: [
        {
          ...roles[0],
          permissions: {
            tables: {
              guias: {
                read: { field: 'no_existe', equals: '$user.x' },
                create: false,
                edit: 'none',
                actions: [],
              },
            },
            export: false,
          },
        },
      ],
    });
    expect(malo.ok).toBe(false);
    expect(malo.problems.join(' ')).toMatch(/rol «fantasma», que no existe/);
    expect(malo.problems.join(' ')).toMatch(/«no_existe», que no es un campo/);
    // «administrador» está reservado.
    const reservado = await reviewAppDraft(db, {
      ...base,
      roles: [{ ...roles[0], key: 'administrador' }],
      screens: [{ title: 'Guías', roles: [], spec: tabla }],
    });
    expect(reservado.problems.join(' ')).toMatch(/administrador/);
  });

  it('avisa (sin bloquear) de lo que un rol vería raro y de que un rol por atributo necesita el dato', async () => {
    const { db } = world();
    const res = await reviewAppDraft(db, {
      name: 'Raro',
      roles: [
        {
          key: 'sin_permiso',
          name: 'Sin permiso',
          description: '',
          permissions: { tables: {}, export: false },
        },
        {
          key: 'cliente',
          name: 'Cliente',
          description: '',
          permissions: {
            tables: {
              guias: {
                read: { field: 'ubicacion', equals: '$user.sede' },
                create: false,
                edit: 'none',
                actions: [],
              },
            },
            export: false,
          },
        },
      ],
      screens: [{ title: 'Guías', roles: [], spec: tabla }],
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.join(' ')).toMatch(
      /«Sin permiso» ve «Guías» pero no tiene permiso sobre «guias»/,
    );
    expect(res.warnings.join(' ')).toMatch(/«Cliente».*«sede»/);
    expect(res.markdown).toContain('Para tener en cuenta');
  });

  it('las automatizaciones llegan como texto y se deducen del diseño; no se activan', async () => {
    const { ctx, fake } = world();
    const res = await appsDesign.handler(
      { description: 'Control en planta', template: 'control_planta' } as never,
      ctx(ADMIN),
    );
    expect(res.ok).toBe(true);
    expect(res.automations.map((a) => a.name)).toEqual(
      expect.arrayContaining(['Avisar si le rechazan una guía']),
    );
    expect(res.markdown).toContain('Automatizaciones sugeridas');
    expect(fake.tables.custom_apps).toHaveLength(0);
  });

  it('la plantilla del portal vuelve lista aunque sus tablas todavía no existan (apps.create las crea)', async () => {
    const { ctx } = world();
    const res = await appsDesign.handler(
      { description: 'Portal para mis clientes', template: 'portal_clientes' } as never,
      ctx(ADMIN),
    );
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    const draft = res.draft as { roles: Array<{ key: string }>; screens: Array<{ title: string }> };
    expect(draft.roles.map((r) => r.key)).toEqual(['cliente', 'atencion']);
    expect(draft.screens.map((s) => s.title)).toEqual(PORTAL_CLIENTES.screens.map((s) => s.title));
    expect(res.warnings.join(' ')).toMatch(/«cliente»/);
  });

  it('sólo quien administra la empresa la usa', async () => {
    const { ctx } = world();
    await expect(
      appsDesign.handler(
        { description: 'algo', template: 'control_planta' } as never,
        ctx(MIEMBRO),
      ),
    ).rejects.toThrow(/administra/);
  });
});

describe('mapa y tareas en el diseño', () => {
  it('avisa si el mapa pide personas o asignar y ningún rol puede compartir, ver o asignar', async () => {
    const { locationWarnings } = await import('../design');
    const { viewSpecSchema } = await import('../../views/spec');
    const spec = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [
        {
          id: 'mapa',
          type: 'map',
          tracker: 'tareas',
          title: 'Equipo',
          locationField: 'lugar',
          people: true,
          assign: { assigneeField: 'asignado', titleField: 'titulo' },
        },
      ],
    });
    const none = locationWarnings(
      [{ title: 'Mapa', spec }],
      [{ name: 'Operario', permissions: { tables: {}, export: false } }],
    );
    expect(none.join('\n')).toMatch(/ningún rol puede verlas/);
    expect(none.join('\n')).toMatch(/ningún rol comparte/);
    expect(none.join('\n')).toMatch(/ningún rol puede asignar/);
    expect(none.join('\n')).toMatch(/Compartir ubicación del equipo/);
    const ok = locationWarnings(
      [{ title: 'Mapa', spec }],
      [
        {
          name: 'Coordinador',
          permissions: { tables: {}, export: false, location: { view: true, assign: true } },
        },
        { name: 'Terreno', permissions: { tables: {}, export: false, location: { share: true } } },
      ],
    );
    // Sólo queda el recordatorio de encender la función en la app.
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatch(/Compartir ubicación del equipo/);
  });
});

describe('apps.design: catálogo de pantallas y autorrevisión', () => {
  const rolesPlanta = [
    {
      key: 'operario',
      name: 'Operario',
      description: '',
      permissions: {
        tables: { guias: { read: 'own', create: true, edit: 'own', actions: [] } },
        export: false,
      },
    },
    {
      key: 'gerencia',
      name: 'Gerencia',
      description: '',
      permissions: {
        tables: { guias: { read: 'all', create: false, edit: 'none', actions: [] } },
        export: true,
      },
    },
  ];

  it('arma pantallas desde patrones sobre la tabla real y el borrador es mostrable', async () => {
    const { ctx, fake } = world();
    const res = await appsDesign.handler(
      {
        description: 'Control de guías en planta',
        name: 'Planta',
        roles: rolesPlanta,
        patterns: [
          { pattern: 'mi_lista_hoy', table: 'guias', title: 'Mi lista de hoy', roles: ['operario'] },
          { pattern: 'registrar', table: 'guias', roles: ['operario'] },
          { pattern: 'panel_gerencial', table: 'guias', title: 'Panel', roles: ['gerencia'] },
        ],
      } as never,
      ctx(ADMIN),
    );
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.designNotes).toEqual([]);
    expect(res.showable).toBe(true);
    const draft = res.draft as { screens: Array<{ title: string; spec: { theme?: { layout?: string } } }> };
    expect(draft.screens.map((s) => s.title)).toEqual(['Mi lista de hoy', 'Registrar guías', 'Panel']);
    expect(draft.screens[0]?.spec.theme?.layout).toBe('operator');
    expect(fake.tables.custom_apps).toHaveLength(0);
  });

  it('un patrón sobre una tabla que no existe, o al que le falta un campo, vuelve como problema', async () => {
    const { ctx } = world();
    const missing = await appsDesign.handler(
      { description: 'x', name: 'X', roles: rolesPlanta, patterns: [{ pattern: 'agenda', table: 'nada' }] } as never,
      ctx(ADMIN),
    );
    expect(missing.ok).toBe(false);
    expect(missing.problems.join(' ')).toMatch(/no existe/);
    const noMap = await appsDesign.handler(
      { description: 'x', name: 'X', roles: rolesPlanta, patterns: [{ pattern: 'mapa_con_lista', table: 'guias' }] } as never,
      ctx(ADMIN),
    );
    expect(noMap.ok).toBe(false);
    expect(noMap.problems.join(' ')).toMatch(/ubicación/);
  });

  it('un diseño con notas sin resolver NO es mostrable y dice qué corregir', async () => {
    const { ctx } = world();
    const strong = (id: string) => ({
      id,
      type: 'board',
      tracker: 'guias',
      title: `Tablero ${id}`,
      groupBy: 'estado',
    });
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [strong('a'), strong('b'), strong('c')],
      pages: [{ id: 'p', title: 'Todo', blockIds: ['a', 'b', 'c'] }],
    });
    const res = await appsDesign.handler(
      {
        description: 'x',
        name: 'X',
        roles: rolesPlanta,
        screens: [{ title: 'Tableros', roles: ['gerencia'], spec }],
      } as never,
      ctx(ADMIN),
    );
    expect(res.ok).toBe(true);
    expect(res.showable).toBe(false);
    expect((res.designNotes ?? []).join(' ')).toMatch(/bloques fuertes/);
    expect(res.markdown).toMatch(/NO se lo muestres/);
  });

  it('el borrador con arreglos automáticos los cuenta en designFixes y en el resumen', async () => {
    const { ctx } = world();
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 't', type: 'table', tracker: 'guias', title: 'guias_hoy', columns: ['numero_guia', 'estado'] }],
    });
    const res = await appsDesign.handler(
      { description: 'x', name: 'X', roles: rolesPlanta, screens: [{ title: 'ver_guias', roles: ['gerencia'], spec }] } as never,
      ctx(ADMIN),
    );
    expect(res.showable).toBe(true);
    expect((res.designFixes ?? []).length).toBeGreaterThan(0);
    expect(res.markdown).toContain('Cuidé el diseño');
    const draft = res.draft as { screens: Array<{ title: string }> };
    expect(draft.screens[0]?.title).toBe('Ver guias');
    // ya no queda el aviso de «lista sin detalle»: el revisor lo resolvió
    expect(res.warnings.join(' ')).not.toMatch(/no tiene un detalle/);
  });
});
