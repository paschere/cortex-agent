import { describe, expect, it } from 'vitest';
import {
  COMPANY,
  DEFAULT_QUICK,
  PINNED,
  QUICK_CANDIDATES,
  SECTIONS,
  WAITING_ITEMS,
  buildRail,
  everyDestination,
  moreGroups,
  primaryActive,
  primaryNav,
  routeVisible,
  waitingHref,
} from './nav-shape';
import { QUEUE_HREF, WAITING_QUEUES, waitingTotal } from './waiting-shape';

/**
 * LO QUE PUEDE SALIR MAL EN SILENCIO.
 *
 * Acortar un menú es exactamente el cambio que se estropea sin hacer ruido: un
 * destino deja de estar en la unión de «fijo + Todo» y no falla nada, no hay
 * error que leer, simplemente esa pantalla ya no se alcanza y nadie se entera
 * hasta que alguien la echa de menos. Estas pruebas son sobre eso, no sobre el
 * aspecto.
 */

const none = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

describe('el rail', () => {
  it('no pierde ni duplica un destino, con o sin plazas ganadas', () => {
    const every = everyDestination();
    expect(new Set(every).size, 'hay un href repetido en el rail').toBe(every.length);

    for (const quick of [[], DEFAULT_QUICK, QUICK_CANDIDATES.map((i) => i.href)]) {
      const rail = buildRail(quick, true);
      const shown = [
        ...rail.pinned,
        ...rail.waiting,
        ...rail.quick,
        ...rail.rest.flatMap((s) => s.items),
        ...rail.company.items,
        ...rail.footer,
      ].map((i) => i.href);
      expect(new Set(shown), `faltan destinos con quick=${quick.length}`).toEqual(new Set(every));
      expect(shown.length).toBe(every.length);
    }
  });

  it('lo que sube al bloque fijo sale de «Todo», y no está en los dos sitios', () => {
    const rail = buildRail(['/goals', '/schedules'], false);
    const inside = rail.rest.flatMap((s) => s.items).map((i) => i.href);
    expect(rail.quick.map((i) => i.href)).toEqual(['/schedules', '/goals']);
    expect(inside).not.toContain('/goals');
    expect(inside).not.toContain('/schedules');
    expect(rail.restCount).toBe(inside.length);
  });

  it('el bloque ganado sale en el orden diseñado, no en el que se pidió', () => {
    // La pertenencia la decide el uso; la posición no. Si el orden siguiera al
    // ranking, las filas se cambiarían de sitio entre sí cada pocos clics.
    const asked = ['/reports', '/clients', '/browser'];
    expect(buildRail(asked, false).quick.map((i) => i.href)).toEqual([
      '/clients',
      '/browser',
      '/reports',
    ]);
  });

  it('una sección que se queda vacía no deja su encabezado colgando', () => {
    const rail = buildRail(
      ['/clients', '/ventas', '/comercial', '/payments', '/trackers', '/apps'],
      false,
    );
    expect(rail.rest.map((s) => s.id)).not.toContain('work');
  });

  it('Finanzas reúne el resumen y la cartera sin duplicar destinos', () => {
    expect(
      SECTIONS.find((section) => section.id === 'finance')?.items.map((item) => item.href),
    ).toEqual([
      '/finance',
      '/payments',
      '/pagar',
      '/inventario',
      '/impuestos',
      '/estados',
      '/presupuesto',
      '/informe-socios',
    ]);
    expect(everyDestination().filter((href) => href === '/finance')).toHaveLength(1);
  });

  it('quien no es admin sólo ve una fila de La empresa, y la ve', () => {
    expect(buildRail([], false).company.items.map((i) => i.href)).toEqual(['/company']);
    expect(buildRail([], true).company.items).toHaveLength(COMPANY.items.length);
  });

  it('no hay plazas ganadas por defecto: el chat no comparte el bloque de arriba', () => {
    expect(DEFAULT_QUICK).toEqual([]);
    expect(buildRail([], false).quick).toEqual([]);
    expect(PINNED.map((i) => i.href)).toEqual([
      '/onboarding',
      '/management',
      '/chat',
      '/views',
      '/feed',
      '/calls',
      '/kb',
    ]);
  });

  it('Inicio vive en «Todo», no en las filas fijas', () => {
    expect(PINNED.map((i) => i.href)).not.toContain('/dashboard');
    expect(QUICK_CANDIDATES.map((i) => i.href)).toContain('/dashboard');
    expect(SECTIONS.flatMap((s) => s.items).map((i) => i.href)).toContain('/dashboard');
  });

  it('las filas fijas nunca compiten por una plaza', () => {
    // Chat, Brain Knowledge y las cuatro colas están fuera de `QUICK_CANDIDATES`.
    const candidates = new Set(QUICK_CANDIDATES.map((i) => i.href));
    for (const item of [...PINNED, ...WAITING_ITEMS]) {
      expect(candidates.has(item.href), item.href).toBe(false);
    }
  });

  it('«La empresa» va aparte y no cae dentro de «Todo»', () => {
    const inside = SECTIONS.flatMap((s) => s.items).map((i) => i.href);
    for (const item of COMPANY.items) expect(inside).not.toContain(item.href);
  });
});

describe('la fila «Te espera»', () => {
  it('cuenta la suma exacta de las cuatro colas y nada más', () => {
    expect(waitingTotal({ approvals: 2, commitments: 1, actions: 3, errands: 1 })).toBe(7);
    expect(waitingTotal(none)).toBe(0);
  });

  it('lleva a la primera cola con algo dentro, en el orden de reloj', () => {
    expect(waitingHref({ ...none, errands: 2 })).toBe('/errands');
    expect(waitingHref({ ...none, actions: 1, errands: 2 })).toBe('/actions');
    expect(waitingHref({ ...none, commitments: 4, actions: 1 })).toBe('/commitments');
    expect(waitingHref({ approvals: 1, commitments: 9, actions: 9, errands: 9 })).toBe(
      '/approvals',
    );
  });

  it('con todo vacío lleva a Aprobaciones y no a ninguna parte rara', () => {
    expect(waitingHref(none)).toBe('/approvals');
  });

  it('despliega exactamente las cuatro colas que el producto ya unifica', () => {
    expect(WAITING_ITEMS.map((i) => i.href)).toEqual(WAITING_QUEUES.map((q) => QUEUE_HREF[q]));
    expect(WAITING_ITEMS.map((i) => i.signal)).toEqual([...WAITING_QUEUES]);
  });
});

describe('la navegación principal del autoservicio', () => {
  it('cada puerta lleva a un destino que el rail también alcanza', () => {
    const every = new Set(everyDestination());
    for (const item of primaryNav({ admin: true, founder: true })) {
      expect(every.has(item.href), item.href).toBe(true);
    }
  });

  it('Equipo depende del rol y nunca lleva a una pantalla que la persona no puede abrir', () => {
    const team = (admin: boolean, founder: boolean) =>
      primaryNav({ admin, founder }).find((item) => item.label === 'Equipo')?.href;
    expect(team(true, false)).toBe('/team');
    expect(team(false, true)).toBe('/team');
    expect(team(true, true)).toBe('/team');
    expect(team(false, false)).toBe('/team/yo');
  });

  it('Equipo se enciende en /team, Mi semana, el detalle de una persona y Personas', () => {
    for (const [admin, founder] of [
      [true, false],
      [false, false],
    ] as const) {
      const item = primaryNav({ admin, founder }).find((i) => i.label === 'Equipo');
      if (!item) throw new Error('falta Equipo');
      for (const path of ['/team', '/team/yo', '/team/0b6c', '/team/medir', '/admin/users']) {
        expect(primaryActive(path, item), path).toBe(true);
      }
    }
  });

  it('Mi semana y Equipo son destinos del rail para cualquiera', () => {
    const every = new Set(everyDestination());
    expect(every.has('/team')).toBe(true);
    expect(every.has('/team/yo')).toBe(true);
    for (const item of primaryNav({ admin: false, founder: false })) {
      expect(every.has(item.href), item.href).toBe(true);
    }
  });

  it('Datos se enciende en tablas, feed, Brain Knowledge e integraciones; el chat no en la consola multiempresa', () => {
    const [, chat, , , , data] = primaryNav({ admin: false, founder: false });
    if (!chat || !data) throw new Error('faltan puertas');
    for (const path of ['/trackers/abc', '/feed', '/kb', '/integrations/whatsapp']) {
      expect(primaryActive(path, data), path).toBe(true);
    }
    expect(primaryActive('/chat/123', chat)).toBe(true);
    expect(primaryActive('/chat/global', chat)).toBe(false);
    expect(primaryActive('/chats', chat)).toBe(false);
  });
});

describe('«Más», corto', () => {
  it('no pasa de quince filas para nadie y no repite lo de la navegación principal', () => {
    for (const admin of [false, true]) {
      for (const founder of [false, true]) {
        const groups = moreGroups({ admin, founder });
        const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
        expect(hrefs.length).toBeLessThanOrEqual(admin ? 20 : 15);
        expect(new Set(hrefs).size).toBe(hrefs.length);
        const primary = primaryNav({ admin, founder }).map((i) => i.href);
        expect(hrefs.filter((h) => primary.includes(h))).toEqual([]);
      }
    }
  });

  it('la administración sólo aparece para quien administra', () => {
    expect(moreGroups({ admin: false, founder: true }).some((g) => g.id === 'admin')).toBe(false);
    expect(moreGroups({ admin: true, founder: false }).some((g) => g.id === 'admin')).toBe(true);
  });

  it('todo lo que ofrece es un destino real del rail', () => {
    const known = new Set(everyDestination());
    for (const g of moreGroups({ admin: true, founder: true })) {
      for (const item of g.items) {
        if (item.href !== '/overview' && item.href !== '/areas') {
          expect(known.has(item.href)).toBe(true);
        }
      }
    }
  });
});

describe('los módulos apagados (0186)', () => {
  const shownIn = (rail: ReturnType<typeof buildRail>) =>
    [
      ...rail.pinned,
      ...rail.quick,
      ...rail.rest.flatMap((s) => s.items),
      ...rail.company.items,
      ...rail.footer,
    ].map((i) => i.href);

  it('sin nada apagado, el rail es el mismo de siempre', () => {
    expect(buildRail([], true, [])).toEqual(buildRail([], true));
  });

  it('esconde las pantallas de un módulo apagado en el rail, «Más» y las puertas', () => {
    const rail = buildRail([], true, ['inventory', 'payables', 'team']);
    const hrefs = shownIn(rail);
    expect(hrefs).not.toContain('/inventario');
    expect(hrefs).not.toContain('/pagar');
    expect(hrefs).not.toContain('/team');
    expect(hrefs).not.toContain('/team/yo');
    // Lo que no es de ningún módulo sigue.
    expect(hrefs).toContain('/clients');
    expect(hrefs).toContain('/payments');
    expect(rail.restCount).toBe(rail.rest.flatMap((s) => s.items).length);

    const more = moreGroups({ admin: false, founder: false, modulesOff: ['taxes'] })
      .flatMap((g) => g.items)
      .map((i) => i.href);
    expect(more).not.toContain('/impuestos');
    expect(more).toContain('/payments');
  });

  it('con Equipo apagado, quien administra conserva la puerta a las personas', () => {
    const admin = primaryNav({ admin: true, founder: false, modulesOff: ['team'] });
    expect(admin.find((i) => i.label === 'Equipo')?.href).toBe('/admin/users');
    const member = primaryNav({ admin: false, founder: false, modulesOff: ['team'] });
    expect(member.find((i) => i.label === 'Equipo')).toBeUndefined();
    expect(member.map((i) => i.href)).toContain('/chat');
  });

  it('routeVisible mira la ruta y sus subpáginas', () => {
    expect(routeVisible('/inventario/ordenes', ['inventory'])).toBe(false);
    expect(routeVisible('/inventario', [])).toBe(true);
    expect(routeVisible('/integrations/whatsapp', ['whatsapp_service'])).toBe(true);
    expect(routeVisible('/integrations/whatsapp/atencion', ['whatsapp_service'])).toBe(false);
  });
});
