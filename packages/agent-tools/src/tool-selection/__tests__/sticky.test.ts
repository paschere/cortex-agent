/**
 * La propiedad que compra el caché de prompts: dentro de una conversación, la
 * lista de herramientas de un turno es PREFIJO de la del siguiente (salvo
 * revocaciones), y todo lo nuevo entra por el final en orden determinista.
 *
 * Todo puro: ni base de datos, ni red. La persistencia (sticky-store.ts) es
 * dos queries triviales con contrato «nunca lanza»; lo que hay que probar es
 * la aritmética de la lista, que es donde vive el prefijo.
 */

import { describe, expect, it } from 'vitest';
import { STICKY_TOOL_BUDGET, combineStickySelection } from '../sticky';

interface Tool {
  id: string;
  description: string;
  family: string;
}

const tool = (id: string, family = id.split('.')[0] ?? id): Tool => ({
  id,
  family,
  description: `hace ${id}`,
});

const ids = (tools: Array<{ id: string }>) => tools.map((t) => t.id);

describe('combineStickySelection', () => {
  it('primer turno: ofrece la selección ordenada por id y la persiste entera', () => {
    const offered = [tool('web.search'), tool('gmail.send'), tool('gmail.list')];
    const out = combineStickySelection({ previousIds: [], offered, candidates: offered });

    expect(ids(out.tools)).toEqual(['gmail.list', 'gmail.send', 'web.search']);
    expect(out.persistIds).toEqual(['gmail.list', 'gmail.send', 'web.search']);
    expect(out.changed).toBe(true);
    expect(out.frozen).toBe(false);
  });

  it('mismo tema dos turnos seguidos: misma lista, nada que escribir', () => {
    const offered = [tool('gmail.send'), tool('gmail.list')];
    const previousIds = ['gmail.list', 'gmail.send'];
    const out = combineStickySelection({ previousIds, offered, candidates: offered });

    expect(ids(out.tools)).toEqual(previousIds);
    expect(out.changed).toBe(false);
    expect(out.persistIds).toEqual(previousIds);
  });

  it('un tema nuevo AGREGA al final y conserva el prefijo byte a byte', () => {
    const turno1 = [tool('gmail.send'), tool('gmail.list')];
    const t1 = combineStickySelection({ previousIds: [], offered: turno1, candidates: turno1 });

    const turno2 = [tool('hubspot.get_deal'), tool('gmail.send'), tool('gmail.list')];
    const candidates = [...turno1, tool('hubspot.get_deal'), tool('vehicles.get')];
    const t2 = combineStickySelection({
      previousIds: t1.persistIds,
      offered: turno2,
      candidates,
    });

    // La propiedad entera del arreglo: lo del turno 1 es prefijo exacto.
    expect(ids(t2.tools).slice(0, t1.persistIds.length)).toEqual(t1.persistIds);
    expect(ids(t2.tools)).toEqual(['gmail.list', 'gmail.send', 'hubspot.get_deal']);
    expect(t2.persistIds).toEqual(['gmail.list', 'gmail.send', 'hubspot.get_deal']);
    expect(t2.changed).toBe(true);
  });

  it('lo persistido viaja aunque la selección de hoy no lo haya elegido', () => {
    // Turno 9: la pregunta es de vehículos, pero gmail se ofreció en el 2 y
    // debe seguir en su posición — de eso vive el prefijo del caché.
    const candidates = [tool('gmail.send'), tool('vehicles.get')];
    const out = combineStickySelection({
      previousIds: ['gmail.send'],
      offered: [tool('vehicles.get')],
      candidates,
    });
    expect(ids(out.tools)).toEqual(['gmail.send', 'vehicles.get']);
  });

  it('el orden de llegada de los candidatos no cambia nada (queries sin ORDER BY)', () => {
    const a = [tool('b.x'), tool('a.x'), tool('c.x')];
    const b = [tool('c.x'), tool('b.x'), tool('a.x')];
    const outA = combineStickySelection({ previousIds: ['c.x'], offered: a, candidates: a });
    const outB = combineStickySelection({ previousIds: ['c.x'], offered: b, candidates: b });
    expect(ids(outA.tools)).toEqual(ids(outB.tools));
    expect(outA.persistIds).toEqual(outB.persistIds);
  });

  it('un id revocado no se materializa pero conserva su posición para cuando vuelva', () => {
    const previousIds = ['gmail.send', 'hubspot.get_deal'];
    // hubspot desapareció de los candidatos (permiso, deny-list o mute).
    const candidates = [tool('gmail.send')];
    const sin = combineStickySelection({ previousIds, offered: candidates, candidates });
    expect(ids(sin.tools)).toEqual(['gmail.send']);
    // La lista persistida NO lo borra…
    expect(sin.persistIds).toEqual(previousIds);
    expect(sin.changed).toBe(false);

    // …así que al volver recupera exactamente la posición vieja.
    const conTodo = [tool('gmail.send'), tool('hubspot.get_deal')];
    const de_vuelta = combineStickySelection({
      previousIds: sin.persistIds,
      offered: conTodo,
      candidates: conTodo,
    });
    expect(ids(de_vuelta.tools)).toEqual(previousIds);
  });

  it('el tope congela la persistencia pero NUNCA esconde la selección del turno', () => {
    const previousIds = ['a.1', 'a.2', 'a.3'];
    const nuevos = [tool('z.risky'), tool('b.new')];
    const candidates = [tool('a.1'), tool('a.2'), tool('a.3'), ...nuevos];
    const out = combineStickySelection({
      previousIds,
      offered: nuevos,
      candidates,
      budget: 4,
    });

    // Cupo para uno solo: b.new (menor id) se persiste, z.risky viaja en la
    // cola transitoria — ofrecida igual, porque una capacidad concedida no
    // puede desaparecer detrás de un tope de caché.
    expect(ids(out.tools)).toEqual(['a.1', 'a.2', 'a.3', 'b.new', 'z.risky']);
    expect(out.persistIds).toEqual(['a.1', 'a.2', 'a.3', 'b.new']);
    expect(out.frozen).toBe(true);
    expect(out.changed).toBe(true);
  });

  it('congelado del todo: el prefijo persistido no crece y la cola es estable entre turnos iguales', () => {
    const previousIds = ['a.1', 'a.2'];
    const nuevos = [tool('c.x'), tool('b.x')];
    const candidates = [tool('a.1'), tool('a.2'), ...nuevos];
    const run = () =>
      combineStickySelection({ previousIds, offered: nuevos, candidates, budget: 2 });

    const t1 = run();
    const t2 = run();
    expect(t1.persistIds).toEqual(previousIds);
    expect(t1.changed).toBe(false);
    // Misma pregunta, misma cola: el request completo repite bytes y el caché
    // acierta aun por encima del tope.
    expect(ids(t1.tools)).toEqual(ids(t2.tools));
    expect(ids(t1.tools)).toEqual(['a.1', 'a.2', 'b.x', 'c.x']);
  });

  it('freeze (Voyage caído / sin consulta): se ofrece todo, no se persiste nada', () => {
    const catalogo = [tool('a.1'), tool('b.1'), tool('c.1')];
    const out = combineStickySelection({
      previousIds: ['b.1'],
      offered: catalogo,
      candidates: catalogo,
      freeze: true,
    });
    expect(out.changed).toBe(false);
    expect(out.persistIds).toEqual(['b.1']);
    // La cabeza persistida primero, el resto en cola ordenada.
    expect(ids(out.tools)).toEqual(['b.1', 'a.1', 'c.1']);
  });

  it('las familias sin indexar viajan en la cola y no quedan pegadas', () => {
    const offered = [tool('mcp:s1:search', 'mcp:s1'), tool('gmail.send')];
    const out = combineStickySelection({
      previousIds: [],
      offered,
      candidates: offered,
      transientFamilies: new Set(['mcp:s1']),
    });
    expect(out.persistIds).toEqual(['gmail.send']);
    // Ofrecida igual — sólo que al final, donde un cambio no arrastra prefijo.
    expect(ids(out.tools)).toEqual(['gmail.send', 'mcp:s1:search']);
  });

  it('el presupuesto por defecto es el documentado', () => {
    expect(STICKY_TOOL_BUDGET).toBe(60);
  });
});
