import { describe, expect, it } from 'vitest';
import {
  APPROVE_ACTION_ID,
  REJECT_ACTION_ID,
  type ViewSpec,
  viewSpecSchema,
} from '../../views/spec';
import {
  type AppUser,
  type ResolvedRole,
  adminRole,
  applyRowScope,
  canApprove,
  canCreateIn,
  canExport,
  canRunAction,
  canSeeScreen,
  describeRead,
  editAccessFor,
  fieldsOutside,
  parsePermissions,
  rowAccessFor,
  rowScopeFor,
  rowVisible,
  writableFieldsFor,
} from '../permissions';

/**
 * LA LÓGICA PURA DE LOS PERMISOS DE UNA APP (migración 0208).
 *
 * Cada regla que decide el servidor —qué pantalla, qué filas, qué campos, qué
 * botones— vive en una función sin base de datos, y aquí se prueba con los
 * casos que importan: el operario que sólo ve lo suyo, el cliente que ve las
 * filas de su cliente, el rol sin la tabla, el administrador que ve todo. Las
 * pruebas de aislamiento (isolation.test.ts) comprueban que el producto de
 * verdad usa estas funciones; éstas comprueban que dicen lo correcto.
 */

const ANA: AppUser = { id: 'user-ana', name: 'Ana', attributes: { cliente: 'Andina' } };
const BETO: AppUser = { id: 'user-beto', name: 'Beto', attributes: {} };

function role(permissions: unknown, key = 'operario'): ResolvedRole {
  return { key, name: key, permissions: parsePermissions(permissions), admin: false };
}

const OPERARIO = role({
  tables: {
    guias: {
      read: 'own',
      create: true,
      edit: 'own',
      fields: ['numero_guia', 'fecha'],
      actions: [],
    },
  },
  export: false,
});

const CLIENTE = role(
  {
    tables: { guias: { read: { field: 'cliente', equals: '$user.cliente' }, create: false } },
  },
  'cliente',
);

const SUPERVISOR = role(
  {
    tables: {
      guias: {
        read: 'all',
        create: true,
        edit: 'all',
        actions: [APPROVE_ACTION_ID, REJECT_ACTION_ID, 'despachar'],
      },
    },
    export: true,
  },
  'supervisor',
);

const rows = [
  { id: 'r1', values: { cliente: 'Andina', estado: 'Pendiente' }, created_by: 'user-ana' },
  { id: 'r2', values: { cliente: 'Globex', estado: 'Pendiente' }, created_by: 'user-beto' },
  { id: 'r3', values: { cliente: 'Andina', estado: 'Aprobada' }, created_by: null },
];

describe('parsePermissions', () => {
  it('lo que no pasa el contrato se niega entero, no a medias', () => {
    expect(parsePermissions({ tables: { guias: { read: 'everything' } } })).toEqual({
      tables: {},
      export: false,
    });
    expect(parsePermissions(null)).toEqual({ tables: {}, export: false });
  });

  it('rellena lo que falta con lo más cerrado', () => {
    const p = parsePermissions({ tables: { guias: {} } });
    expect(p.tables.guias).toEqual({ read: 'all', create: false, edit: 'none', actions: [] });
    expect(p.export).toBe(false);
  });

  it('un filtro por atributo tiene que ser $user.<atributo>', () => {
    expect(
      parsePermissions({ tables: { guias: { read: { field: 'cliente', equals: 'Andina' } } } }),
    ).toEqual({ tables: {}, export: false });
  });
});

describe('pantallas', () => {
  it('una pantalla sin roles la ven todos; con roles, sólo ellos; el administrador siempre', () => {
    expect(canSeeScreen(OPERARIO, [])).toBe(true);
    expect(canSeeScreen(OPERARIO, ['operario', 'supervisor'])).toBe(true);
    expect(canSeeScreen(OPERARIO, ['supervisor'])).toBe(false);
    expect(canSeeScreen(adminRole(), ['supervisor'])).toBe(true);
  });
});

describe('filas', () => {
  it('«own»: sólo lo que registró', () => {
    const access = rowAccessFor(OPERARIO, ANA, 'guias');
    expect(access).toEqual({ kind: 'own', userId: 'user-ana' });
    expect(applyRowScope(rows, access).map((r) => r.id)).toEqual(['r1']);
  });

  it('«equals»: las filas de su cliente, y ninguna si no tiene el atributo', () => {
    expect(applyRowScope(rows, rowAccessFor(CLIENTE, ANA, 'guias')).map((r) => r.id)).toEqual([
      'r1',
      'r3',
    ]);
    const sinAtributo = rowAccessFor(CLIENTE, BETO, 'guias');
    expect(sinAtributo).toEqual({ kind: 'equals', field: 'cliente', value: null });
    expect(applyRowScope(rows, sinAtributo)).toEqual([]);
  });

  it('una tabla que el rol no nombra no se lee: negar por defecto', () => {
    expect(rowAccessFor(OPERARIO, ANA, 'otra_tabla')).toEqual({ kind: 'none' });
    expect(applyRowScope(rows, { kind: 'none' })).toEqual([]);
  });

  it('el administrador y «all» ven todo', () => {
    expect(applyRowScope(rows, rowAccessFor(adminRole(), BETO, 'guias'))).toHaveLength(3);
    expect(applyRowScope(rows, rowAccessFor(SUPERVISOR, BETO, 'guias'))).toHaveLength(3);
  });

  it('rowVisible es la misma regla que filtra la lectura', () => {
    const own = rowAccessFor(OPERARIO, ANA, 'guias');
    expect(rowVisible(own, rows[0] as (typeof rows)[number])).toBe(true);
    expect(rowVisible(own, rows[1] as (typeof rows)[number])).toBe(false);
  });

  it('rowScopeFor cubre TODAS las fuentes del spec, aunque sea con «none»', () => {
    const spec: ViewSpec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        { id: 'a', type: 'table', width: 'full', tracker: 'guias', title: 'Guías' },
        { id: 'b', type: 'metric', width: 'half', tracker: 'cortex.ventas', title: 'Ventas' },
      ],
    });
    expect(rowScopeFor(OPERARIO, ANA, spec)).toEqual([
      { tracker: 'guias', access: { kind: 'own', userId: 'user-ana' } },
      { tracker: 'cortex.ventas', access: { kind: 'none' } },
    ]);
  });
});

describe('escrituras', () => {
  it('crear y editar según el rol', () => {
    expect(canCreateIn(OPERARIO, 'guias')).toBe(true);
    expect(canCreateIn(CLIENTE, 'guias')).toBe(false);
    expect(editAccessFor(OPERARIO, 'guias')).toBe('own');
    expect(editAccessFor(CLIENTE, 'guias')).toBe('none');
    expect(editAccessFor(adminRole(), 'guias')).toBe('all');
  });

  it('la lista de campos es blanca: lo que no está no se escribe', () => {
    expect(writableFieldsFor(OPERARIO, 'guias')).toEqual(new Set(['numero_guia', 'fecha']));
    expect(fieldsOutside(OPERARIO, 'guias', ['numero_guia', 'estado', 'foto'])).toEqual([
      'estado',
      'foto',
    ]);
    // Sin lista, vale la del bloque: nada se rechaza aquí.
    expect(fieldsOutside(SUPERVISOR, 'guias', ['estado'])).toEqual([]);
    expect(writableFieldsFor(adminRole(), 'guias')).toBeNull();
  });

  it('un operario no aprueba; el supervisor sí, y tiene sus botones', () => {
    expect(canApprove(OPERARIO, 'guias')).toBe(false);
    expect(canRunAction(OPERARIO, 'guias', 'despachar')).toBe(false);
    expect(canApprove(SUPERVISOR, 'guias')).toBe(true);
    expect(canRunAction(SUPERVISOR, 'guias', 'despachar')).toBe(true);
    expect(canRunAction(SUPERVISOR, 'guias', 'borrar_todo')).toBe(false);
    expect(canRunAction(adminRole(), 'guias', 'borrar_todo')).toBe(true);
  });

  it('exportar es un permiso aparte', () => {
    expect(canExport(OPERARIO)).toBe(false);
    expect(canExport(SUPERVISOR)).toBe(true);
    expect(canExport(adminRole())).toBe(true);
  });
});

describe('en lenguaje simple', () => {
  it('describe el filtro de filas como lo leería el editor', () => {
    expect(describeRead('own')).toBe('Ve sólo lo que registró');
    expect(describeRead('all')).toBe('Ve todas las filas');
    expect(describeRead({ field: 'cliente', equals: '$user.cliente' }, 'Cliente')).toBe(
      'Ve las filas donde «Cliente» es su cliente',
    );
  });
});
