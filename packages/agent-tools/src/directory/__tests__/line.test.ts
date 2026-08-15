import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_DEPTH,
  buildOrgLine,
  chainAbove,
  escalationTarget,
  managerMapOf,
  wouldCycle,
} from '../line';
import type { DirectoryPerson, LineNode, ManagerLink } from '../line';

/**
 * LO QUE ESTAS PRUEBAS EXISTEN PARA CAZAR.
 *
 * Un escalado que va a la persona equivocada NO SE VE ROTO EN NINGUNA PANTALLA.
 * La fila del compromiso existe, el aviso salió, el diario dice «entregado», y
 * el único síntoma es que quien tenía que enterarse no se enteró. No hay ninguna
 * otra capa de este producto donde eso se pueda observar, así que se observa
 * aquí o no se observa.
 *
 * Y un ciclo en la línea no rompe una pantalla: cuelga el barrido nocturno de
 * TODA la empresa, de noche, sin nadie delante.
 */

const map = (...pairs: Array<[string, string | null]>) =>
  managerMapOf(pairs.map(([id, managerId]): ManagerLink => ({ id, managerId })));

// ---------------------------------------------------------------------------
// A quién le llega el escalado
// ---------------------------------------------------------------------------

describe('a quién se le sube un compromiso que nadie atendió', () => {
  const admins = ['admin-1', 'admin-2'];

  it('respeta siempre a quien se nombró a mano en ese compromiso', () => {
    // La garantía que hace que la 0106 no toque ni un compromiso existente.
    const result = escalationTarget({
      escalateToUserId: 'marcela',
      ownerUserId: 'ana',
      managers: map(['ana', 'beto'], ['beto', null]),
      admins,
    });
    expect(result).toEqual({ userId: 'marcela', via: 'named' });
  });

  it('sube al jefe del responsable cuando nadie nombró a nadie', () => {
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', 'beto'], ['beto', null]),
      admins,
    });
    expect(result).toEqual({ userId: 'beto', via: 'manager' });
  });

  it('sube UN escalón, no la cadena entera', () => {
    // Subir al jefe del jefe teniendo jefe es saltárselo: deja de ser «tu jefe
    // se enteró» y pasa a ser «te acusaron ante el gerente».
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', 'beto'], ['beto', 'carla'], ['carla', null]),
      admins,
    });
    expect(result.userId).toBe('beto');
  });

  it('cae en el primer administrador cuando el responsable no tiene jefe', () => {
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', null]),
      admins,
    });
    expect(result).toEqual({ userId: 'admin-1', via: 'admin' });
  });

  it('cae en el primer administrador cuando el compromiso no tiene responsable', () => {
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: null,
      managers: map(['ana', 'beto']),
      admins,
    });
    expect(result).toEqual({ userId: 'admin-1', via: 'admin' });
  });

  it('no escala a la propia persona aunque los datos digan que es su jefe', () => {
    // La 0106 lo impide en la base. Esto se lee en un cron sobre datos que
    // pueden venir de una restauración, y mandarle a alguien el escalado de su
    // propio incumplimiento son dos correos idénticos y nadie por encima
    // enterándose — el fallo silencioso exacto que el módulo cierra.
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', 'ana']),
      admins,
    });
    expect(result).toEqual({ userId: 'admin-1', via: 'admin' });
  });

  it('ignora un jefe que no está en este espacio de trabajo', () => {
    // El mapa se lee con el handle con alcance, así que un id que no aparece es
    // de otra empresa o de una cuenta borrada. Escribirle sería el escalado de
    // una empresa cayendo en el buzón de otra.
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', 'de-otra-empresa']),
      admins,
    });
    expect(result).toEqual({ userId: 'admin-1', via: 'admin' });
  });

  it('no inventa un destinatario cuando no hay ni jefe ni administradores', () => {
    const result = escalationTarget({
      escalateToUserId: null,
      ownerUserId: 'ana',
      managers: map(['ana', null]),
      admins: [],
    });
    expect(result).toEqual({ userId: null, via: 'none' });
  });

  it('el orden de los administradores es el que se le pasa, no otro', () => {
    // El `order by` que faltaba vive en `orgAdmins`; esta función no reordena
    // nada, y esa división tiene que quedar fijada.
    expect(
      escalationTarget({
        escalateToUserId: null,
        ownerUserId: null,
        managers: map(),
        admins: ['segundo', 'primero'],
      }).userId,
    ).toBe('segundo');
  });
});

// ---------------------------------------------------------------------------
// Ciclos
// ---------------------------------------------------------------------------

describe('recorrer la cadena sin colgarse', () => {
  it('devuelve la cadena entera, del jefe al más alto', () => {
    const chain = chainAbove(map(['a', 'b'], ['b', 'c'], ['c', null]), 'a');
    expect(chain).toEqual({ above: ['b', 'c'], capped: false, cycle: false });
  });

  it('nunca incluye a la propia persona', () => {
    expect(chainAbove(map(['a', 'b'], ['b', null]), 'a').above).not.toContain('a');
  });

  it('corta un ciclo de dos en vez de girar para siempre', () => {
    const chain = chainAbove(map(['a', 'b'], ['b', 'a']), 'a');
    expect(chain.cycle).toBe(true);
    expect(chain.above).toEqual(['b']);
  });

  it('corta un ciclo que no incluye a quien pregunta', () => {
    // El caso que un `visited` sin más se salta si sólo se compara contra el id
    // de partida: a → b → c → b → c…
    const chain = chainAbove(map(['a', 'b'], ['b', 'c'], ['c', 'b']), 'a');
    expect(chain.cycle).toBe(true);
  });

  it('corta por profundidad una cadena absurdamente larga sin ciclo', () => {
    const links: ManagerLink[] = [];
    const depth = MAX_LINE_DEPTH + 5;
    for (let i = 0; i < depth; i += 1) {
      links.push({ id: `p${i}`, managerId: i + 1 < depth ? `p${i + 1}` : null });
    }
    const chain = chainAbove(managerMapOf(links), 'p0');
    expect(chain.capped).toBe(true);
    expect(chain.cycle).toBe(false);
    expect(chain.above).toHaveLength(MAX_LINE_DEPTH);
  });

  it('una cadena de exactamente el tope no se marca como cortada', () => {
    // El caso frontera: doce escalones caben, el trece no. Un off-by-one aquí
    // haría desaparecer al jefe más alto de las empresas más profundas.
    const links: ManagerLink[] = [];
    for (let i = 0; i <= MAX_LINE_DEPTH; i += 1) {
      links.push({ id: `p${i}`, managerId: i < MAX_LINE_DEPTH ? `p${i + 1}` : null });
    }
    const chain = chainAbove(managerMapOf(links), 'p0');
    expect(chain.capped).toBe(false);
    expect(chain.above).toHaveLength(MAX_LINE_DEPTH);
  });

  it('sin jefe no hay cadena, y eso no es un error', () => {
    expect(chainAbove(map(['a', null]), 'a')).toEqual({
      above: [],
      capped: false,
      cycle: false,
    });
  });

  it('alguien que no está en el mapa devuelve cadena vacía', () => {
    expect(chainAbove(map(['a', 'b']), 'fantasma').above).toEqual([]);
  });
});

describe('la puerta de escritura', () => {
  const managers = map(['ana', 'beto'], ['beto', 'carla'], ['carla', null], ['dora', null]);

  it('deja poner de jefe a quien no está en tu cadena', () => {
    expect(wouldCycle(managers, 'dora', 'ana')).toBe(false);
  });

  it('impide que alguien sea su propio jefe', () => {
    expect(wouldCycle(managers, 'ana', 'ana')).toBe(true);
  });

  it('impide cerrar el círculo con tu propio jefe', () => {
    expect(wouldCycle(managers, 'beto', 'ana')).toBe(true);
  });

  it('impide cerrar el círculo con alguien más arriba de la cadena', () => {
    // Carla es la jefa de Beto, que es el jefe de Ana. Ponerle a Carla de jefa
    // a Ana cierra un círculo de tres, que es el que nadie ve venir.
    expect(wouldCycle(managers, 'carla', 'ana')).toBe(true);
  });

  it('rechaza colgarse de una cadena que ya está rota', () => {
    const rota = map(['x', 'y'], ['y', 'x'], ['libre', null]);
    expect(wouldCycle(rota, 'libre', 'x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// El árbol
// ---------------------------------------------------------------------------

const person = (
  id: string,
  managerId: string | null,
  name: string | null = id,
): DirectoryPerson => ({
  id,
  email: `${id}@empresa.co`,
  name,
  role: 'member',
  managerId,
});

describe('dibujar la línea', () => {
  it('cuelga a cada quien de su jefe y ordena por nombre', () => {
    const line = buildOrgLine([
      person('c', 'a', 'Carla'),
      person('b', 'a', 'Beto'),
      person('a', null, 'Ana'),
    ]);
    expect(line.roots).toHaveLength(1);
    const [ana] = line.roots as [LineNode];
    expect(ana.person.name).toBe('Ana');
    expect(ana.reports.map((r) => r.person.name)).toEqual(['Beto', 'Carla']);
    expect(line.depth).toBe(2);
  });

  it('cuenta a quien no tiene jefe, que es la cifra que dice si esto se usa', () => {
    const line = buildOrgLine([person('a', null), person('b', 'a'), person('c', null)]);
    expect(line.unmanaged).toBe(2);
  });

  it('no pierde a nadie cuando su jefe no está en el espacio', () => {
    // Una pantalla de personas a la que le falta gente es peor que una con un
    // dato malo: la ausencia no se nota.
    const line = buildOrgLine([person('a', 'de-otra-empresa')]);
    expect(line.roots.map((r) => r.person.id)).toEqual(['a']);
  });

  it('no cuelga ni pierde a nadie cuando los datos tienen un ciclo', () => {
    const line = buildOrgLine([person('a', 'b'), person('b', 'a'), person('c', null)]);
    const ids = line.roots.map((r) => r.person.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(line.cycles.sort()).toEqual(['a', 'b']);
    expect(line.roots.filter((r) => r.broken)).toHaveLength(2);
  });

  it('sin nadie, no hay árbol y no hay error', () => {
    expect(buildOrgLine([])).toEqual({ roots: [], unmanaged: 0, cycles: [], depth: 0 });
  });

  it('ordena por el correo a quien no tiene nombre puesto', () => {
    const line = buildOrgLine([person('zeta', null, null), person('alfa', null, 'Ana')]);
    expect(line.roots.map((r) => r.person.id)).toEqual(['alfa', 'zeta']);
  });
});
