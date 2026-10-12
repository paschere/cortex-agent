import { describe, expect, it } from 'vitest';
import { viewSpecSchema } from '../views/spec';
import { adminRole } from './permissions';
import type { AppAccess } from './store';
import {
  type Snapshot,
  buildSnapshot,
  diffSnapshots,
  hasUnpublishedChanges,
  overlayAccess,
  parseSnapshot,
  stableStringify,
} from './versions-shape';

const spec = (n: number) =>
  viewSpecSchema.parse({
    version: 1,
    accent: 'primary',
    refreshSeconds: 0,
    editing: 'off',
    alerts: [],
    blocks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, type: 'text', markdown: 'hola' })),
  });

const app = {
  name: 'Planta',
  description: '',
  icon: '🚚',
  theme: {},
  home_screen: null,
  home: null,
  brand: {},
  dashboards: [],
  portal: parsePortalEmpty(),
};
function parsePortalEmpty() {
  return { enabled: false, roleKey: 'cliente', attribute: 'cliente' } as never;
}
const perms = {
  tables: { guias: { read: 'all', create: true, edit: 'none', actions: [] } },
  export: false,
} as never;

function snap(n: number, extra: Partial<Parameters<typeof buildSnapshot>[0]> = {}): Snapshot {
  return buildSnapshot({
    app,
    screens: [{ slug: 'registrar', title: 'Registrar', icon: 'X', roles: [], view_id: 'v1' }],
    views: new Map([['v1', { name: 'Registrar', spec: spec(n) }]]),
    roles: [{ key: 'operario', name: 'Operario', description: '', permissions: perms }],
    ...extra,
  } as never);
}

describe('versiones: foto y restauración', () => {
  it('la foto sobrevive ida y vuelta por JSON y se vuelve a validar', () => {
    const s = snap(2);
    const back = parseSnapshot(JSON.parse(JSON.stringify(s)));
    expect(back?.screens[0]?.spec.blocks).toHaveLength(2);
    expect(back?.roles[0]?.permissions.tables.guias?.create).toBe(true);
    expect(stableStringify(back?.screens)).toBe(stableStringify(s.screens));
  });
  it('un spec roto se descarta pieza por pieza', () => {
    const raw = JSON.parse(JSON.stringify(snap(1)));
    raw.screens.push({
      slug: 'mala',
      title: 'Mala',
      icon: 'X',
      roles: [],
      viewId: 'v9',
      spec: { nope: 1 },
    });
    expect(parseSnapshot(raw)?.screens.map((s) => s.slug)).toEqual(['registrar']);
    expect(parseSnapshot({ v: 2 })).toBeNull();
  });
  it('una pantalla sin vista (archivada) no entra a la foto', () => {
    const s = snap(1, { views: new Map() });
    expect(s.screens).toHaveLength(0);
  });
  it('el diff cuenta qué cambió', () => {
    const before = snap(1);
    const after = snap(3, {
      roles: [
        {
          key: 'operario',
          name: 'Operario',
          description: '',
          permissions: { tables: {}, export: false } as never,
        },
        { key: 'gerencia', name: 'Gerencia', description: '', permissions: perms },
      ],
    });
    const text = diffSnapshots(before, after).map((c) => c.text);
    expect(text).toContain('«Registrar»: 2 bloques más');
    expect(text).toContain('Rol nuevo «Gerencia»');
    expect(text).toContain('Permisos del rol «Operario»');
    expect(diffSnapshots(null, after)[0]?.text).toMatch(/Primera versión/);
    expect(diffSnapshots(before, before)).toEqual([]);
    expect(hasUnpublishedChanges(before, before)).toBe(false);
    expect(hasUnpublishedChanges(before, after)).toBe(true);
    expect(hasUnpublishedChanges(null, after)).toBe(true);
  });
});

describe('versiones: lo que ven los usuarios', () => {
  const live = (): AppAccess =>
    ({
      app: { ...app, id: 'a1', slug: 'planta', status: 'published' },
      screens: [
        {
          id: 's-live',
          app_id: 'a1',
          view_id: 'v1',
          slug: 'registrar',
          title: 'EDITADA',
          icon: 'X',
          position: 0,
          roles: [],
        },
        {
          id: 's-new',
          app_id: 'a1',
          view_id: 'v2',
          slug: 'borrador',
          title: 'A medias',
          icon: 'X',
          position: 1,
          roles: [],
        },
      ],
      role: {
        key: 'operario',
        name: 'Operario',
        permissions: { tables: {}, export: false },
        admin: false,
      },
      user: { id: 'u', name: 'Ana', attributes: {} },
    }) as never;

  it('el usuario ve la versión publicada, no el borrador', () => {
    const out = overlayAccess(live(), snap(1));
    expect(out?.screens.map((s) => s.slug)).toEqual(['registrar']);
    expect(out?.screens[0]?.title).toBe('Registrar');
    expect(out?.screens[0]?.frozenSpec?.blocks).toHaveLength(1);
    // los permisos son los de la versión, no los del borrador
    expect(out?.role.permissions.tables.guias?.create).toBe(true);
  });
  it('un rol creado después de publicar no entra todavía', () => {
    const a = live();
    a.role = { ...a.role, key: 'nuevo' };
    expect(overlayAccess(a, snap(1))).toBeNull();
  });
  it('el administrador conserva su rol', () => {
    const a = { ...live(), role: adminRole() };
    expect(overlayAccess(a, snap(1))?.role.admin).toBe(true);
  });
});
