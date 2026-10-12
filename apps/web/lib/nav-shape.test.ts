import type { ModuleKey } from '@cortex/agent-tools/src/modules/catalog';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT,
  AREAS,
  COMPANY,
  DEFAULT_QUICK,
  FAV_MAX,
  PINNED,
  QUICK_CANDIDATES,
  SECTIONS,
  WAITING_AFTER,
  WAITING_ITEMS,
  accountMenu,
  areaFor,
  areaTabsFor,
  buildRail,
  buildSidebar,
  everyDestination,
  favoriteDefaults,
  favoritesKey,
  mobileTabs,
  parseFavorites,
  primaryActive,
  primaryNav,
  pruneFavorites,
  routeVisible,
  sidebarDestinations,
  toggleFavorite,
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
        ...(rail.setup ? [rail.setup] : []),
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
    expect(rail.quick.map((i) => i.href)).toEqual(['/goals', '/schedules']);
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
    const rail = buildRail(['/clients', '/ventas', '/comercial', '/prospects'], false);
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
      '/chat',
      '/piloto',
      '/views',
      '/apps',
      '/trackers',
      '/kb',
    ]);
    expect(WAITING_AFTER).toBe('/piloto');
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

describe('el rail calmado', () => {
  it('«Puesta en marcha» sólo sale como tarjeta mientras falte', () => {
    expect(buildRail([], true, [], false).setup?.href).toBe('/onboarding');
    expect(buildRail([], true, [], true).setup).toBeNull();
    expect(buildRail([], true, [], true).pinned.map((i) => i.href)).not.toContain('/onboarding');
  });

  it('con la puesta en marcha completa no se pierde ningún otro destino', () => {
    const done = buildRail([], true, [], true);
    const shown = new Set(
      [
        ...done.pinned,
        ...done.waiting,
        ...done.rest.flatMap((s) => s.items),
        ...done.company.items,
        ...done.footer,
      ].map((i) => i.href),
    );
    expect([...new Set(everyDestination())].filter((h) => !shown.has(h))).toEqual(['/onboarding']);
  });

  it('Hoy lleva el contador del piloto y las rutas nuevas son alcanzables', () => {
    expect(PINNED.find((i) => i.href === '/piloto')?.signal).toBe('pilot');
    const every = everyDestination();
    for (const href of ['/piloto', '/actividad', '/notifications', '/trackers', '/apps']) {
      expect(every, href).toContain(href);
    }
  });

  it('los encabezados salen en español llano y ninguna sección queda vacía', () => {
    const rail = buildRail([], false);
    expect(rail.rest.map((s) => s.label)).toEqual([
      'Mi día',
      'Clientes y ventas',
      'Plata',
      'Operación',
      'Mi equipo',
      'Legal',
      'Lo que hago solo',
      'De dónde saco todo',
    ]);
    for (const section of rail.rest) expect(section.items.length).toBeGreaterThan(0);
  });

  it('apagar todos los módulos opcionales no deja encabezados colgando', () => {
    const rail = buildRail([], false, [
      'contracts',
      'compliance',
      'fleet',
      'service_orders',
      'team',
    ] as ModuleKey[]);
    for (const section of rail.rest) expect(section.items.length).toBeGreaterThan(0);
  });

  it('la barra del teléfono: Hoy, Chat, Aplicaciones y Vistas (y «Más»)', () => {
    expect(mobileTabs().map((t) => t.label)).toEqual(['Hoy', 'Chat', 'Aplicaciones', 'Vistas']);
    const hoy = mobileTabs()[0];
    if (!hoy) throw new Error('falta Hoy');
    // Las colas de «Te espera» cuelgan de Hoy.
    expect(primaryActive('/commitments', hoy)).toBe(true);
    const chat = mobileTabs()[1];
    if (!chat) throw new Error('falta Chat');
    expect(primaryActive('/chat/abc', chat)).toBe(true);
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

/**
 * EL RAIL «V2»: LO QUE NO PUEDE PERDERSE.
 * Esta lista es la de TODAS las rutas que el rail anterior alcanzaba (puertas,
 * «Te espera», secciones, «La empresa», pie, tarjeta de puesta en marcha y
 * «Todas mis empresas»). Congelada a mano a propósito: si alguien quita una
 * pantalla del menú nuevo, este arreglo no se mueve con ella y la prueba falla.
 */
const OLD_ROUTES = [
  '/chat',
  '/piloto',
  '/views',
  '/apps',
  '/trackers',
  '/kb',
  '/onboarding',
  '/approvals',
  '/commitments',
  '/actions',
  '/errands',
  '/management',
  '/dashboard',
  '/calls',
  '/feed',
  '/notifications',
  '/actividad',
  '/clients',
  '/ventas',
  '/comercial',
  '/prospects',
  '/finance',
  '/payments',
  '/pagar',
  '/inventario',
  '/impuestos',
  '/estados',
  '/presupuesto',
  '/informe-socios',
  '/proyectos',
  '/flota',
  '/documentos-vencen',
  '/team',
  '/team/yo',
  '/goals',
  '/nomina',
  '/sst',
  '/contratos',
  '/cumplimiento',
  '/procesos',
  '/browser',
  '/schedules',
  '/activations',
  '/pipelines',
  '/reports',
  '/integrations',
  '/integrations/whatsapp',
  '/company',
  '/admin/users',
  '/admin/teams',
  '/admin/usage',
  '/admin/audit',
  '/admin/security',
  '/admin/mandates',
  '/plan',
  '/settings',
  '/ayuda',
  '/overview',
];

describe('el rail V2', () => {
  it('toda ruta del rail anterior sigue alcanzable', () => {
    const now = new Set(sidebarDestinations());
    expect(OLD_ROUTES.filter((href) => !now.has(href))).toEqual([]);
    // Y el rail viejo (que otros módulos todavía leen) no se salió de lo nuevo.
    expect(everyDestination().filter((href) => !now.has(href))).toEqual([]);
  });

  it('cada ruta tiene un solo área dueña', () => {
    const owned = AREAS.flatMap((a) => a.tabs.map((t) => t.href));
    expect(owned.filter((h, i) => owned.indexOf(h) !== i)).toEqual([]);
  });

  it('el rail tiene unas doce entradas, no las veintiocho de antes', () => {
    const rail = buildSidebar({ admin: true, founder: true });
    expect(rail.doors.map((d) => d.label)).toEqual([
      'Hoy',
      'Chat',
      'Aplicaciones',
      'Vistas',
      'Reportes',
    ]);
    expect(rail.areas.map((a) => a.area.label)).toEqual([
      'Plata',
      'Clientes y ventas',
      'Operación',
      'Equipo',
      'Datos',
    ]);
  });

  it('cada área abre su primera pantalla visible y no deja pestañas de módulos apagados', () => {
    const rail = buildSidebar({ admin: false, founder: false });
    expect(rail.areas.find((a) => a.area.id === 'finance')?.href).toBe('/finance');
    const off = buildSidebar({
      admin: false,
      founder: false,
      modulesOff: [
        'finance',
        'payables',
        'taxes',
        'accounting_close',
        'statements',
        'budget',
        'payroll',
      ],
    });
    // /payments no es de ningún módulo: Plata se queda con Cartera y abre ahí.
    const plata = off.areas.find((a) => a.area.id === 'finance');
    expect(plata?.href).toBe('/payments');
    expect(plata?.tabs.map((t) => t.href)).toEqual(['/payments']);
    // Con una sola pestaña no hay barra que dibujar.
    expect(
      areaTabsFor('/payments', {
        admin: false,
        modulesOff: [
          'finance',
          'payables',
          'taxes',
          'accounting_close',
          'statements',
          'budget',
          'payroll',
        ],
      })?.tabs,
    ).toHaveLength(1);
  });

  it('las pestañas: la más específica gana y los módulos apagados no dejan huecos', () => {
    expect(areaFor('/team/yo')?.tab.href).toBe('/team/yo');
    expect(areaFor('/team/0b6c')?.tab.href).toBe('/team');
    expect(areaFor('/estados')?.area.id).toBe('finance');
    expect(areaFor('/piloto/panel')?.area.id).toBe('today');
    expect(areaFor('/errands/abc')?.area.id).toBe('operations');
    expect(areaFor('/settings')).toBeNull();
    const view = areaTabsFor('/impuestos/borrador', { admin: true });
    expect(view?.active).toBe('/impuestos');
    expect(view?.tabs.map((t) => t.href)).toContain('/nomina');
    const noTax = areaTabsFor('/pagar', { admin: true, modulesOff: ['taxes'] });
    expect(noTax?.tabs.map((t) => t.href)).not.toContain('/impuestos');
  });

  it('Reportes repite Estados financieros sin quitárselo a Plata; Encargos sigue en Hoy', () => {
    const reports = areaTabsFor('/reports', { admin: false });
    expect(reports?.tabs.map((t) => t.href)).toEqual(['/reports', '/informe-socios', '/estados']);
    const hoy = areaTabsFor('/approvals', { admin: false });
    expect(hoy?.tabs.map((t) => t.href)).toEqual(
      expect.arrayContaining(['/approvals', '/commitments', '/actions', '/errands', '/actividad']),
    );
  });

  it('el menú de la cuenta: lo de admin sólo para admin, y nada queda con grupo vacío', () => {
    const member = accountMenu({ admin: false, founder: false });
    const memberHrefs = member.flatMap((g) => g.items.map((i) => i.href));
    expect(memberHrefs).not.toContain('/admin/users');
    expect(memberHrefs).not.toContain('/admin/audit');
    expect(memberHrefs).toContain('/actividad');
    expect(member.map((g) => g.id)).not.toContain('people');
    const admin = accountMenu({ admin: true, founder: true });
    expect(admin.flatMap((g) => g.items.map((i) => i.href))).toEqual(
      expect.arrayContaining([
        '/admin/security',
        '/admin/mandates',
        '/admin/usage',
        '/plan',
        '/ayuda',
      ]),
    );
    expect(ACCOUNT.every((g) => g.items.length > 0)).toBe(true);
    expect(buildSidebar({ admin: false, founder: true }).global?.href).toBe('/overview');
    expect(buildSidebar({ admin: false, founder: false }).global).toBeNull();
  });

  it('«Puesta en marcha» sólo mientras falte', () => {
    expect(buildSidebar({ admin: true, founder: false }).setup?.href).toBe('/onboarding');
    expect(buildSidebar({ admin: true, founder: false, setupDone: true }).setup).toBeNull();
  });
});

describe('favoritos', () => {
  const shortcuts = [
    { href: '/apps/vuelos', label: 'Vuelos', kind: 'app' as const },
    { href: '/apps/planta', label: 'Planta', kind: 'app' as const },
    { href: '/views/caja', label: 'Caja', kind: 'view' as const },
  ];

  it('por defecto: quien administra, Cartera y su primera app; el resto, sus apps y vistas', () => {
    expect(favoriteDefaults({ admin: true, founder: false, shortcuts }).map((f) => f.href)).toEqual(
      ['/payments', '/apps/vuelos', '/views/caja'],
    );
    expect(
      favoriteDefaults({ admin: false, founder: false, shortcuts }).map((f) => f.href),
    ).toEqual(['/apps/vuelos', '/apps/planta', '/views/caja']);
    expect(favoriteDefaults({ admin: false, founder: false })).toEqual([]);
  });

  it('Cartera no se ofrece si su módulo está apagado', () => {
    const list = favoriteDefaults({ admin: true, founder: true, modulesOff: ['finance'] });
    expect(list.map((f) => f.href)).toContain('/payments');
    expect(pruneFavorites([{ href: '/pagar', label: 'Por pagar' }], ['payables'])).toEqual([]);
  });

  it('fijar y soltar; con más de cinco, la más antigua cede', () => {
    let list = toggleFavorite([], { href: '/a', label: 'A' });
    list = toggleFavorite(list, { href: '/a', label: 'A' });
    expect(list).toEqual([]);
    for (const n of [1, 2, 3, 4, 5, 6])
      list = toggleFavorite(list, { href: `/x${n}`, label: `X${n}` });
    expect(list).toHaveLength(FAV_MAX);
    expect(list[0]?.href).toBe('/x2');
  });

  it('lo guardado se lee sin fiarse de ello', () => {
    expect(parseFavorites(null)).toBeNull();
    expect(parseFavorites('basura')).toBeNull();
    expect(parseFavorites('{"a":1}')).toBeNull();
    expect(parseFavorites('[]')).toEqual([]);
    expect(
      parseFavorites(
        JSON.stringify([
          { href: '/payments', label: 'Cartera' },
          { href: '/payments', label: 'Repetida' },
          { href: 'https://malo.test', label: 'Externa' },
          { href: '//malo.test', label: 'Protocolo' },
          { href: '/x', label: '' },
          7,
        ]),
      ),
    ).toEqual([{ href: '/payments', label: 'Cartera' }]);
  });

  it('una llave por persona y por empresa', () => {
    expect(favoritesKey('a@x.co', 'org1')).not.toBe(favoritesKey('a@x.co', 'org2'));
    expect(favoritesKey('a@x.co', 'org1')).not.toBe(favoritesKey('b@x.co', 'org1'));
  });
});
