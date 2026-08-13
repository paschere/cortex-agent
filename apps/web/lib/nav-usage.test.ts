import { describe, expect, it } from 'vitest';
import { orderByUsage } from './nav-usage';

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
