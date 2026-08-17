import { describe, expect, it } from 'vitest';
import { type ManagerLink, managerMapOf } from '../../directory/line';
import {
  APPROVAL_ESCALATION_DEFAULT_HOURS,
  type EscalatableAction,
  MAX_ESCALATION_HOURS,
  MIN_ESCALATION_HOURS,
  escalationHoursFrom,
  escalationsDue,
} from '../escalation';

/**
 * LO QUE ESTAS PRUEBAS EXISTEN PARA CAZAR.
 *
 * Ninguno de los errores de este módulo se ve. Escalar al jefe equivocado deja
 * la fila correcta, el barrido verde y los registros diciendo «entregado»; el
 * único síntoma es que quien tenía que enterarse no se enteró. Escalar de más es
 * peor, porque el daño se acumula: un jefe con tres avisos que no tocaban deja
 * de abrir el cuarto, y nadie puede señalar el día en que este camino se apagó.
 *
 * No hay ninguna otra capa del producto donde eso se pueda observar. Así que se
 * observa aquí o no se observa.
 */

const HOUR = 3_600_000;
const NOW = new Date('2026-08-17T11:30:00.000Z'); // 06:30 en Bogotá, la hora del barrido
const AFTER_MS = 48 * HOUR;

const map = (...pairs: Array<[string, string | null]>) =>
  managerMapOf(pairs.map(([id, managerId]): ManagerLink => ({ id, managerId })));

/** Una propuesta viva, esperando desde hace `hoursAgo`. */
function action(over: Partial<EscalatableAction> & { hoursAgo?: number } = {}): EscalatableAction {
  const hoursAgo = over.hoursAgo ?? 72;
  const created = new Date(NOW.getTime() - hoursAgo * HOUR);
  const { hoursAgo: _drop, ...rest } = over;
  return {
    id: 'accion-1',
    user_id: 'ana',
    state: 'proposed',
    created_at: created.toISOString(),
    // Los siete días de PROPOSAL_TTL_MS, contados desde que se creó.
    expires_at: new Date(created.getTime() + 7 * 24 * HOUR).toISOString(),
    escalated_at: null,
    ...rest,
  };
}

const due = (
  actions: EscalatableAction[],
  over: Partial<Parameters<typeof escalationsDue>[0]> = {},
) =>
  escalationsDue({
    actions,
    now: NOW,
    afterMs: AFTER_MS,
    managers: map(['ana', 'beto'], ['beto', null]),
    admins: ['admin-1', 'admin-2'],
    ...over,
  });

// ---------------------------------------------------------------------------
// Quién escala a quién, y cuándo
// ---------------------------------------------------------------------------

describe('a quién sube una aprobación que nadie contestó', () => {
  it('sube al jefe del dueño, con las horas que lleva parada', () => {
    expect(due([action({ hoursAgo: 72 })])).toEqual([
      { actionId: 'accion-1', toUserId: 'beto', via: 'manager', hoursWaiting: 72 },
    ]);
  });

  it('sin jefe puesto, cae en el primer administrador del orden estable', () => {
    // El caso NORMAL, no el raro: una empresa que todavía no ha escrito ni un
    // `manager_id` es toda la línea de mando que hay el primer día.
    const result = due([action()], { managers: map(['ana', null]) });
    expect(result).toEqual([
      { actionId: 'accion-1', toUserId: 'admin-1', via: 'admin', hoursWaiting: 72 },
    ]);
  });

  it('sube UN escalón: nunca se salta al jefe para ir al jefe del jefe', () => {
    // Saltárselo dejaría de ser «tu jefe se enteró» y pasaría a ser «te
    // acusaron ante el gerente», que es una función distinta del producto.
    const result = due([action()], {
      managers: map(['ana', 'beto'], ['beto', 'carla'], ['carla', null]),
    });
    expect(result[0]?.toUserId).toBe('beto');
  });

  it('un jefe que no está en el mapa no existe: cae al administrador', () => {
    // Un id fuera del mapa es de otra empresa o de una cuenta borrada. En los
    // dos casos la respuesta correcta es bajar un escalón, no mandarle correo.
    const result = due([action()], { managers: map(['ana', 'fantasma']) });
    expect(result[0]).toMatchObject({ toUserId: 'admin-1', via: 'admin' });
  });

  it('una cadena con ciclo no cuelga ni escala a quien no toca', () => {
    // La 0106 impide crear el ciclo, pero esto se lee en un cron sobre datos
    // que pueden venir de una restauración. Un escalón sigue siendo un escalón.
    const result = due([action()], { managers: map(['ana', 'beto'], ['beto', 'ana']) });
    expect(result[0]).toMatchObject({ toUserId: 'beto', via: 'manager' });
  });
});

// ---------------------------------------------------------------------------
// Cuándo NO escala
// ---------------------------------------------------------------------------

describe('lo que deliberadamente no se escala', () => {
  it('no escala lo recién creado: el dueño tiene derecho a su plazo', () => {
    expect(due([action({ hoursAgo: 47 })])).toEqual([]);
  });

  it('escala justo al cumplirse el umbral, no un milisegundo después', () => {
    expect(due([action({ hoursAgo: 48 })])).toHaveLength(1);
  });

  it('no escala una acción ya aprobada ni una descartada', () => {
    // Avisarle al jefe de trabajo YA HECHO es la forma más rápida de enseñarle
    // que estos correos son mentira.
    const rows = [
      action({ id: 'aprobada', state: 'approved' }),
      action({ id: 'descartada', state: 'dismissed' }),
    ];
    expect(due(rows)).toEqual([]);
  });

  it('no escala lo que ya expiró, aunque lleve una semana parado', () => {
    // Ruido puro: el jefe recibiría un correo sobre algo que ya nadie —ni él ni
    // el dueño— puede aprobar. La 0077 es explícita: expirar revoca aprobar.
    const created = new Date(NOW.getTime() - 200 * HOUR);
    const rows = [
      action({
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 7 * 24 * HOUR).toISOString(),
      }),
    ];
    expect(due(rows)).toEqual([]);
  });

  it('NUNCA escala dos veces la misma fila', () => {
    // El barrido corre todas las mañanas y la propuesta vive siete días: sin
    // esta puerta el mismo jefe recibe el mismo aviso cinco mañanas seguidas.
    const rows = [action({ escalated_at: '2026-08-16T11:30:00.000Z' })];
    expect(due(rows)).toEqual([]);
  });

  it('un administrador que se escalaría a sí mismo no se escala', () => {
    // No es un escalado: es un segundo correo idéntico a quien ya no contestó
    // el primero, con la fila marcada como atendida y nadie por encima
    // enterándose. Y es el caso normal en una empresa sin línea de mando.
    const rows = [action({ user_id: 'admin-1' })];
    const result = due(rows, { managers: map(['admin-1', null]) });
    expect(result).toEqual([]);
  });

  it('sin jefe y sin administradores no hay a quién avisar', () => {
    const result = due([action()], { managers: map(['ana', null]), admins: [] });
    expect(result).toEqual([]);
  });

  it('descarta una fila con fechas ilegibles en vez de tratarla como eterna', () => {
    const rows = [action({ created_at: 'no es una fecha' }), action({ id: 'b', expires_at: '' })];
    expect(due(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orden y tope
// ---------------------------------------------------------------------------

describe('el orden y el tope por corrida', () => {
  it('saca lo más viejo primero, y el tope deja fuera lo más nuevo', () => {
    const rows = [
      action({ id: 'nueva', hoursAgo: 50 }),
      action({ id: 'vieja', hoursAgo: 120 }),
      action({ id: 'media', hoursAgo: 80 }),
    ];
    expect(due(rows, { limit: 2 }).map((e) => e.actionId)).toEqual(['vieja', 'media']);
  });

  it('desempata por id para que dos filas del mismo instante no dependan de Postgres', () => {
    const rows = [action({ id: 'zeta' }), action({ id: 'alfa' })];
    expect(due(rows).map((e) => e.actionId)).toEqual(['alfa', 'zeta']);
  });
});

// ---------------------------------------------------------------------------
// El umbral, leído del entorno
// ---------------------------------------------------------------------------

describe('APPROVAL_ESCALATION_HOURS', () => {
  it('sin valor, dos mañanas completas para el dueño', () => {
    expect(escalationHoursFrom(undefined)).toBe(APPROVAL_ESCALATION_DEFAULT_HOURS);
    expect(escalationHoursFrom('')).toBe(APPROVAL_ESCALATION_DEFAULT_HOURS);
    expect(escalationHoursFrom('   ')).toBe(APPROVAL_ESCALATION_DEFAULT_HOURS);
  });

  it('lee un número honesto', () => {
    expect(escalationHoursFrom('24')).toBe(24);
    expect(escalationHoursFrom(' 72 ')).toBe(72);
  });

  it('cualquier basura cae al valor por defecto en vez de tumbar el despliegue', () => {
    for (const raw of ['48h', 'mucho', 'NaN', '-3', '0', 'Infinity']) {
      expect(escalationHoursFrom(raw)).toBe(APPROVAL_ESCALATION_DEFAULT_HOURS);
    }
  });

  it('recorta en vez de rechazar: quien puso 500 quería «casi nunca»', () => {
    // Y el techo importa de verdad: cualquier umbral por encima de los 7 días de
    // PROPOSAL_TTL_MS apagaría el escalado entero en silencio, porque nada
    // sobrevive vivo hasta ahí.
    expect(escalationHoursFrom('500')).toBe(MAX_ESCALATION_HOURS);
    expect(escalationHoursFrom('0.25')).toBe(MIN_ESCALATION_HOURS);
    expect(MAX_ESCALATION_HOURS).toBeLessThan(7 * 24);
  });
});
