import { describe, expect, it } from 'vitest';
import { trackerFieldSchema } from '../trackers/schema';
import { type CatalogTracker, type ViewSpec, viewSpecSchema } from '../views/spec';
import {
  type InspectInput,
  type InspectReport,
  expectedFieldsMissing,
  inspectApp,
  renderInspection,
} from './inspect-shape';
import { parsePermissions } from './permissions';

const f = (x: Record<string, unknown>) => trackerFieldSchema.parse(x);

const clientes: CatalogTracker = {
  slug: 'clientes',
  name: 'Clientes',
  fields: [f({ key: 'nombre', label: 'Nombre', type: 'text', required: true })],
};
const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    f({ key: 'numero', label: 'Número', type: 'text', required: true }),
    f({ key: 'cliente', label: 'Cliente', type: 'relation', tracker: 'clientes', required: true }),
    f({ key: 'estado', label: 'Estado', type: 'select', options: ['Nueva', 'En ruta'] }),
    f({ key: 'kilos', label: 'Kilos', type: 'number' }),
    f({ key: 'tarifa', label: 'Tarifa', type: 'money' }),
    f({ key: 'total', label: 'Total', type: 'money', formula: '[kilos] * [tarifa]' }),
    f({ key: 'foto', label: 'Foto', type: 'file', accept: 'image' }),
  ],
};

const spec = (blocks: unknown[]): ViewSpec =>
  viewSpecSchema.parse({ version: 1, blocks, editing: 'team' });

const registrar = spec([
  { id: 'f1', type: 'form', tracker: 'guias', fields: [], title: 'Registrar guía' },
]);
const registrarConLista = spec([
  { id: 'f1', type: 'form', tracker: 'guias', fields: [], title: 'Registrar guía' },
  { id: 't1', type: 'table', tracker: 'clientes', title: 'Clientes' },
]);

const operarioPerms = parsePermissions({
  tables: { guias: { read: 'own', create: true, edit: 'own' } },
});

function input(over: Partial<InspectInput> = {}): InspectInput {
  return {
    app: { name: 'Planta', homeScreen: 'registrar' },
    screens: [{ slug: 'registrar', title: 'Registrar', roles: [], spec: registrar }],
    roles: [{ key: 'operario', name: 'Operario', permissions: operarioPerms }],
    catalog: [guias, clientes],
    rowCounts: { guias: 12, clientes: 5 },
    roleKey: 'operario',
    ...over,
  };
}

const run = (i: InspectInput): InspectReport => {
  const r = inspectApp(i);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('inspectApp', () => {
  it('detecta el selector que no carga para el Operario (relación a una tabla que la pantalla no comparte)', () => {
    const r = run(input());
    const rel = r.screens[0]?.blocks[0]?.fields?.find((x) => x.key === 'cliente');
    expect(rel?.kind).toBe('relation');
    expect(rel?.options).toBe(0);
    expect(rel?.control).toMatch(/SIN opciones/);
    expect(r.problems.join('\n')).toMatch(
      /«Cliente» es una relación a «Clientes».*no cargará opciones/,
    );
  });

  it('el administrador sí ve opciones, y compartir la tabla en la pantalla arregla al operario', () => {
    const admin = run(input({ roleKey: 'administrador' }));
    const rel = admin.screens[0]?.blocks[0]?.fields?.find((x) => x.key === 'cliente');
    expect(rel?.options).toBe(5);
    const fixed = run(
      input({
        screens: [{ slug: 'registrar', title: 'Registrar', roles: [], spec: registrarConLista }],
      }),
    );
    const rel2 = fixed.screens[0]?.blocks[0]?.fields?.find((x) => x.key === 'cliente');
    expect(rel2?.options).toBe(5);
    expect(fixed.problems.filter((p) => /relación/.test(p))).toEqual([]);
  });

  it('describe cada campo con su control efectivo', () => {
    const r = run(input({ roleKey: 'administrador' }));
    const byKey = Object.fromEntries(
      (r.screens[0]?.blocks[0]?.fields ?? []).map((x) => [x.key, x]),
    );
    expect(byKey.numero?.control).toBe('texto');
    expect(byKey.estado?.control).toBe('desplegable (2 opciones)');
    expect(byKey.kilos?.kind).toBe('number');
    expect(byKey.total?.kind).toBe('formula');
    expect(byKey.total?.writable).toBe(false);
    expect(byKey.foto?.kind).toBe('photo');
  });

  it('campo obligatorio que el rol no puede escribir', () => {
    const perms = parsePermissions({
      tables: { guias: { read: 'all', create: true, fields: ['kilos', 'estado'] } },
    });
    const r = run(input({ roles: [{ key: 'operario', name: 'Operario', permissions: perms }] }));
    expect(r.problems.join('\n')).toMatch(
      /«Número» es obligatorio pero el rol Operario no puede escribirlo/,
    );
    const num = r.screens[0]?.blocks[0]?.fields?.find((x) => x.key === 'numero');
    expect(num?.writable).toBe(false);
  });

  it('rol sin permiso de crear, bloque sobre tabla sin permiso, y pantalla inicial inútil', () => {
    const perms = parsePermissions({ tables: { clientes: { read: 'all' } } });
    const r = run(input({ roles: [{ key: 'operario', name: 'Operario', permissions: perms }] }));
    expect(r.problems.join('\n')).toMatch(/no puede crear registros en «Guías»/);
    expect(r.screens[0]?.blocks[0]?.canCreate).toBe(false);
    const lista = run(
      input({
        screens: [
          {
            slug: 'registrar',
            title: 'Registrar',
            roles: [],
            spec: spec([{ id: 't', type: 'table', tracker: 'guias', title: 'Guías' }]),
          },
        ],
        roles: [{ key: 'operario', name: 'Operario', permissions: perms }],
      }),
    );
    expect(lista.problems.join('\n')).toMatch(/no tiene permiso sobre «Guías»/);
    expect(lista.problems.join('\n')).toMatch(/pantalla inicial «Registrar» no muestra nada útil/);
  });

  it('pantalla de entrada no visible y rol que no ve pantallas', () => {
    const r = run(
      input({
        screens: [
          { slug: 'registrar', title: 'Registrar', roles: ['supervisor'], spec: registrar },
          { slug: 'lista', title: 'Lista', roles: [], spec: registrarConLista },
        ],
      }),
    );
    expect(r.startScreen).toBe('lista');
    expect(r.hiddenScreens).toEqual(['Registrar']);
    expect(r.problems.join('\n')).toMatch(/entrada «Registrar» no es visible/);
    const none = run(
      input({
        screens: [{ slug: 'registrar', title: 'Registrar', roles: ['supervisor'], spec: registrar }],
      }),
    );
    expect(none.startScreen).toBeNull();
    expect(none.problems.join('\n')).toMatch(/no ve ninguna pantalla/);
  });

  it('fuente vacía y rol inexistente', () => {
    const r = run(
      input({
        roleKey: 'administrador',
        rowCounts: { guias: 0, clientes: 0 },
        screens: [{ slug: 'l', title: 'Lista', roles: [], spec: registrarConLista }],
      }),
    );
    expect(r.problems.join('\n')).toMatch(/«Clientes» no tiene registros todavía/);
    expect(r.problems.join('\n')).toMatch(/relación a «Clientes», que no tiene registros/);
    expect(inspectApp(input({ roleKey: 'fantasma' }))).toHaveProperty('error');
  });

  it('expectedFieldsMissing: lo pedido aparece sólo si el control de verdad funciona', () => {
    const r = run(input());
    expect(expectedFieldsMissing(r, ['Número', 'cliente', 'Kilos'])).toEqual(['cliente']);
    expect(expectedFieldsMissing(run(input({ roleKey: 'administrador' })), ['cliente'])).toEqual(
      [],
    );
  });

  it('renderInspection resume pantallas, campos y problemas', () => {
    const text = renderInspection(run(input()));
    expect(text).toMatch(/vista como \*\*Operario\*\*/);
    expect(text).toMatch(/Cliente \*: relación a «Clientes» \(SIN opciones para este rol\)/);
    expect(text).toMatch(/Problemas \(/);
  });
});
