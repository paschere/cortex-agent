import { describe, expect, it } from 'vitest';
import { orderByUsage, pickQuick } from './nav-usage';

/**
 * An adaptive menu is a menu you have to read again, unless it moves as little
 * as possible. These are the rules that keep it from becoming that.
 */

const items = [
  { href: '/errands' },
  { href: '/browser' },
  { href: '/schedules' },
  { href: '/pipelines' },
  { href: '/orchestrator' },
  { href: '/dev-work' },
];

const order = (list: { href: string }[]) => list.map((i) => i.href);

describe('ordenar por uso', () => {
  it('deja el orden diseñado cuando nadie ha usado nada', () => {
    expect(order(orderByUsage(items, {}))).toEqual(order(items));
  });

  it('sube lo que se usa de verdad', () => {
    const ranked = orderByUsage(items, { '/pipelines': 9, '/dev-work': 4 });
    expect(order(ranked).slice(0, 2)).toEqual(['/pipelines', '/dev-work']);
  });

  it('no mueve nada por un clic suelto', () => {
    // Un clic accidental no debe reordenar la navegación de nadie. Por debajo
    // del piso, la puntuación no cuenta y el orden diseñado se mantiene.
    expect(order(orderByUsage(items, { '/dev-work': 1 }))).toEqual(order(items));
    expect(order(orderByUsage(items, { '/dev-work': 2 }))).toEqual(order(items));
  });

  it('conserva el orden diseñado entre los que empatan', () => {
    // Estabilidad: lo que no se ha ganado un puesto no se baraja solo. Sin
    // esto, la mitad de abajo de una sección cambiaría de sitio en cada carga y
    // la lista dejaría de poder aprenderse.
    const ranked = orderByUsage(items, { '/schedules': 6 });
    expect(order(ranked)).toEqual([
      '/schedules',
      '/errands',
      '/browser',
      '/pipelines',
      '/orchestrator',
      '/dev-work',
    ]);
  });

  it('nunca pierde ni duplica un destino', () => {
    // La propiedad que de verdad importa: adaptar el orden no puede hacer
    // desaparecer una pantalla. Un destino que se esconde porque no lo usas es
    // un destino que no vas a descubrir nunca.
    const ranked = orderByUsage(items, { '/pipelines': 30, '/nope': 99 });
    expect(ranked).toHaveLength(items.length);
    expect(new Set(order(ranked))).toEqual(new Set(order(items)));
  });
});

/**
 * EL BLOQUE DE ARRIBA ES EL QUE NO PUEDE BAILAR.
 *
 * Reordenar dentro de una sección desplegada es barato: la fila sigue a la
 * vista. Cambiar quién ocupa las cinco plazas de arriba empuja a otra cosa
 * fuera del sitio donde alguien ya está apuntando con el dedo, y si eso pasa
 * cada mañana el rail deja de poder aprenderse — que es todo lo que este rail
 * intenta comprar. Estas pruebas son sobre el temblor, no sobre el ranking.
 */
const candidates = [
  '/clients',
  '/payments',
  '/browser',
  '/schedules',
  '/pipelines',
  '/goals',
  '/reports',
  '/kb',
];
const seeds = ['/clients', '/payments', '/kb', '/browser', '/reports'];
/** Cinco plazas que alguien usa de verdad, para poder empujar contra ellas. */
const used = {
  '/clients': 20,
  '/payments': 18,
  '/browser': 14,
  '/reports': 12,
  '/kb': 8,
};

describe('el bloque de arriba', () => {
  it('el primer día es el sembrado, en el orden diseñado', () => {
    expect(pickQuick(candidates, {}, null, seeds)).toEqual([
      '/clients',
      '/payments',
      '/browser',
      '/reports',
      '/kb',
    ]);
  });

  it('hay tantas plazas como semillas, ni una más', () => {
    const block = pickQuick(candidates, { '/goals': 40, '/pipelines': 30 }, null, seeds);
    expect(block).toHaveLength(seeds.length);
  });

  it('no asciende nada por usarlo tres veces', () => {
    // Cinco visitas es el piso para ascender (QUICK_MIN), el doble que el de
    // reordenar dentro de una sección. Las dos decisiones no cuestan lo mismo.
    const block = pickQuick(candidates, { '/goals': 4 }, null, seeds);
    expect(block).not.toContain('/goals');
  });

  it('asciende lo que se usa de verdad, y sólo una plaza a la vez', () => {
    const before = pickQuick(candidates, {}, null, seeds);
    const scores = { '/goals': 9, '/pipelines': 8, '/schedules': 7 };
    const after = pickQuick(candidates, scores, before, seeds);
    // Tres superan el piso; el bloque se mueve de a una fila entre un pintado y
    // el siguiente. Un menú que se rehace entero no se lee como uno que aprende.
    expect(after.filter((h) => !before.includes(h))).toEqual(['/goals']);
    expect(after).toHaveLength(seeds.length);
  });

  it('lo que ya está arriba se defiende: no lo echa una ventaja de una visita', () => {
    // Un bloque en el que las cinco plazas se usan de verdad. El más flojo de
    // dentro —/kb, con 8— es contra quien se compite.
    const block = pickQuick(candidates, used, seeds, seeds);
    expect(block).toEqual(['/clients', '/payments', '/browser', '/reports', '/kb']);
    // /goals le gana por poco. Por poco no basta: hacen falta dos visitas
    // enteras de ventaja, o el bloque cambiaría de contenido a diario sin que
    // nadie hubiera cambiado de costumbres.
    expect(pickQuick(candidates, { ...used, '/goals': 9 }, block, seeds)).toEqual(block);
    expect(pickQuick(candidates, { ...used, '/goals': 10 }, block, seeds)).toContain('/goals');
  });

  it('no lo intercambia de ida y de vuelta con cada clic', () => {
    // LA HISTÉRESIS, dicha como se ve: /goals entra con ventaja suficiente, y
    // acto seguido /kb —que acaba de salir y sigue teniendo casi lo mismo— no lo
    // vuelve a echar. Sin memoria de quién está dentro, esto oscila.
    const scores = { ...used, '/goals': 11 };
    const start = pickQuick(candidates, used, seeds, seeds);
    const swapped = pickQuick(candidates, scores, start, seeds);
    expect(swapped).toContain('/goals');
    expect(swapped).not.toContain('/kb');
    expect(pickQuick(candidates, scores, swapped, seeds)).toEqual(swapped);
    // Y para volver a entrar, /kb tiene que sacarle a /goals la misma ventaja
    // que le costó a /goals entrar. Adelantarlo por uno no mueve nada.
    expect(pickQuick(candidates, { ...scores, '/kb': 12 }, swapped, seeds)).toEqual(swapped);
    expect(pickQuick(candidates, { ...scores, '/kb': 14 }, swapped, seeds)).toContain('/kb');
  });

  it('un destino que ya no existe deja su plaza libre, no un hueco', () => {
    const block = pickQuick(candidates, {}, ['/se-fue', '/goals'], seeds);
    expect(block).toHaveLength(seeds.length);
    expect(block).not.toContain('/se-fue');
    expect(block).toContain('/goals');
  });

  it('nunca devuelve algo que no esté entre los candidatos', () => {
    const block = pickQuick(candidates, { '/nope': 99 }, ['/nope'], seeds);
    for (const href of block) expect(candidates).toContain(href);
    expect(new Set(block).size).toBe(block.length);
  });
});
