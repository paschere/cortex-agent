import type { ActiveOrganization } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import {
  type WorkspaceListPayload,
  buildWorkspaceMenu,
  limitReason,
  roleLabel,
  workspaceInitial,
} from './workspace-switch';

/**
 * LO QUE PUEDE SALIR MAL EN SILENCIO AQUÍ.
 *
 * Un selector de inquilino no falla con un error en pantalla: falla enseñando
 * el nombre equivocado, o afirmando «éste es tu único espacio» medio segundo
 * antes de listar otros cuatro, o escondiendo el activo de su propia lista.
 * Nada de eso rompe nada — simplemente alguien lee las cifras de una empresa
 * creyendo que son las de otra. Estas pruebas son sobre eso.
 */

const ACTIVE: ActiveOrganization = {
  id: 'org-1',
  name: 'Vertix',
  slug: 'vertix',
  role: 'owner',
};

function payload(over: Partial<WorkspaceListPayload> = {}): WorkspaceListPayload {
  return {
    workspaces: [{ id: 'org-1', name: 'Vertix', slug: 'vertix', role: 'owner' }],
    activeId: 'org-1',
    canCreate: true,
    limit: 5,
    ...over,
  };
}

describe('el menú del espacio de trabajo', () => {
  it('sin respuesta del servidor no promete ni niega nada', () => {
    // El shell pinta el nombre desde el primer byte; los demás espacios llegan
    // al abrir el menú. En ese hueco no se sabe si hay entre qué elegir, y
    // decir que no lo hay es tan falso como decir que sí.
    const menu = buildWorkspaceMenu(ACTIVE, null);
    expect(menu.active.name).toBe('Vertix');
    expect(menu.state).toBe('unknown');
    expect(menu.others).toEqual([]);
    expect(menu.create).toEqual({ can: false, reason: null });
  });

  it('con un solo espacio no finge que hay entre qué elegir', () => {
    const menu = buildWorkspaceMenu(ACTIVE, payload());
    expect(menu.state).toBe('alone');
    expect(menu.others).toEqual([]);
    // Pero crear otro sigue disponible: es lo único que este menú puede
    // ofrecerle a quien tiene uno solo.
    expect(menu.create.can).toBe(true);
  });

  it('el activo no aparece entre los demás, y los demás salen por nombre', () => {
    const menu = buildWorkspaceMenu(
      ACTIVE,
      payload({
        workspaces: [
          { id: 'org-3', name: 'zeta', slug: null, role: 'member' },
          { id: 'org-1', name: 'Vertix', slug: 'vertix', role: 'owner' },
          { id: 'org-2', name: 'Ácme', slug: 'acme', role: 'admin' },
        ],
      }),
    );
    expect(menu.state).toBe('choice');
    // Acentos y mayúsculas no deciden el orden; el orden de llegada del
    // endpoint (por antigüedad) tampoco.
    expect(menu.others.map((w) => w.name)).toEqual(['Ácme', 'zeta']);
    expect(menu.others.map((w) => w.id)).not.toContain('org-1');
  });

  it('el nombre y el rol más nuevos ganan, pero el activo lo decide la sesión', () => {
    // Otra pestaña cambió de espacio: el endpoint dice que el activo es otro.
    // Esta pantalla está pintada entera contra `org-1`, así que sigue diciendo
    // `org-1` — y con el nombre actualizado que acaba de llegar.
    const menu = buildWorkspaceMenu(
      ACTIVE,
      payload({
        activeId: 'org-2',
        workspaces: [
          { id: 'org-1', name: 'Vertix SAS', slug: 'vertix', role: 'admin' },
          { id: 'org-2', name: 'Acme', slug: 'acme', role: 'member' },
        ],
      }),
    );
    expect(menu.active).toEqual({
      id: 'org-1',
      name: 'Vertix SAS',
      slug: 'vertix',
      role: 'admin',
    });
    expect(menu.others.map((w) => w.id)).toEqual(['org-2']);
  });

  it('si al activo lo sacaron de la lista, se sigue enseñando', () => {
    // Alguien lo expulsó con la pantalla abierta. Quitarlo dejaría el selector
    // enseñando un nombre que no está en su propio menú.
    const menu = buildWorkspaceMenu(
      ACTIVE,
      payload({
        activeId: 'org-2',
        workspaces: [{ id: 'org-2', name: 'Acme', slug: 'acme', role: 'member' }],
      }),
    );
    expect(menu.active.id).toBe('org-1');
    expect(menu.active.name).toBe('Vertix');
    expect(menu.others.map((w) => w.id)).toEqual(['org-2']);
  });

  it('sin cupo, en vez del botón hay una frase con el tope que dijo el servidor', () => {
    const menu = buildWorkspaceMenu(ACTIVE, payload({ canCreate: false, limit: 5 }));
    expect(menu.create.can).toBe(false);
    expect(menu.create.reason).toContain('5');
    // El número no puede salir de una constante de este lado: el tope vive en
    // la configuración de better-auth y una copia aquí envejece sola.
    expect(buildWorkspaceMenu(ACTIVE, payload({ canCreate: false, limit: 3 })).create.reason).toBe(
      limitReason(3),
    );
  });

  it('el tope de uno no se cuenta en plural', () => {
    expect(limitReason(1)).toBe('Una cuenta sólo puede tener un espacio de trabajo.');
    expect(limitReason(5)).toContain('hasta 5 espacios');
  });
});

describe('las etiquetas', () => {
  it('cada rol se dice en español', () => {
    expect(roleLabel('owner')).toBe('dueño');
    expect(roleLabel('admin')).toBe('administrador');
    expect(roleLabel('member')).toBe('miembro');
  });

  it('la inicial salta lo que no es letra ni cifra', () => {
    expect(workspaceInitial('Vertix')).toBe('V');
    expect(workspaceInitial('ácme')).toBe('Á');
    expect(workspaceInitial('⚡ Vertix')).toBe('V');
    expect(workspaceInitial('(Nuevo) Acme')).toBe('N');
    expect(workspaceInitial('  3M')).toBe('3');
    // Un nombre que no tiene ni una letra no puede tumbar el rail contraído.
    expect(workspaceInitial('···')).toBe('·');
    expect(workspaceInitial('')).toBe('·');
  });
});
