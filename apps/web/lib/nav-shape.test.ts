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
    // ranking, las cinco filas se cambiarían de sitio entre sí cada pocos clics.
    const asked = ['/reports', '/clients', '/kb'];
    expect(buildRail(asked, false).quick.map((i) => i.href)).toEqual([
      '/clients',
      '/reports',
      '/kb',
    ]);
  });

  it('una sección que se queda vacía no deja su encabezado colgando', () => {
    const rail = buildRail(['/clients', '/payments'], false);
    expect(rail.rest.map((s) => s.id)).not.toContain('work');
  });

  it('quien no es admin sólo ve una fila de La empresa, y la ve', () => {
    expect(buildRail([], false).company.items.map((i) => i.href)).toEqual(['/company']);
    expect(buildRail([], true).company.items).toHaveLength(COMPANY.items.length);
  });

  it('las cinco semillas son destinos que existen', () => {
    const candidates = new Set(QUICK_CANDIDATES.map((i) => i.href));
    for (const href of DEFAULT_QUICK) expect(candidates.has(href), href).toBe(true);
  });

  it('las tres filas fijas nunca compiten por una plaza', () => {
    // Inicio, Chat y las cuatro colas están fuera de `QUICK_CANDIDATES`: no
    // pueden ascender porque ya están arriba, y sobre todo no pueden bajar.
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
