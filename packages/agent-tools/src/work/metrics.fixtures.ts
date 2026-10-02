/**
 * UN EQUIPO DE PRUEBA: Logística Andina S.A.S. (Bogotá).
 *
 * Datos inventados con la forma de una operación colombiana real: despachos
 * (guías), cobros (cartera en pesos), casos de Gerencia y solicitudes de
 * clientes. Seis personas:
 *
 *   - Laura Gómez (despachos): sobrecargada. 16 abiertos, 7 vencidos.
 *   - Andrés Restrepo (despachos y alguna solicitud): poca carga, recibe.
 *   - Sofía Martínez (despachos y solicitudes): mejorando, de 8 a 13 cerrados.
 *   - Carlos Ruiz (cobros): de vacaciones toda la semana, con 3 vencidos.
 *   - Valentina Ospina (casos): nueva desde el martes, 3 ítems.
 *   - Julián Pérez (cobros y casos): en casos bajó de 10 a 4 con 6 esperando.
 *
 * Y 7 solicitudes sin responsable. Hoy es el viernes 2 de octubre de 2026; el
 * período es la semana del lunes 28 sep al domingo 4 oct y el anterior, la del
 * 21 al 27 sep (sin festivos). Sólo para pruebas.
 */

import type { WorkItem, WorkPeriod, WorkPerson } from './types';

export const AS_OF = '2026-10-02';
export const PERIOD: WorkPeriod = { from: '2026-09-28', to: '2026-10-04' };
export const PREVIOUS: WorkPeriod = { from: '2026-09-21', to: '2026-09-27' };

export const PREV_DAYS = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
export const CUR_DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];

export const LAURA = 'u-laura';
export const ANDRES = 'u-andres';
export const SOFIA = 'u-sofia';
export const CARLOS = 'u-carlos';
export const VALENTINA = 'u-valentina';
export const JULIAN = 'u-julian';

export function team(): WorkPerson[] {
  return [
    { id: LAURA, name: 'Laura Gómez', team: 'Operación', role: 'Despachos' },
    { id: ANDRES, name: 'Andrés Restrepo', team: 'Operación', role: 'Despachos' },
    { id: SOFIA, name: 'Sofía Martínez', team: 'Operación', role: 'Despachos' },
    { id: CARLOS, name: 'Carlos Ruiz', team: 'Cartera', role: 'Cobros', awayDays: CUR_DAYS },
    { id: VALENTINA, name: 'Valentina Ospina', team: 'Gerencia', role: 'Casos' },
    { id: JULIAN, name: 'Julián Pérez', team: 'Cartera', role: 'Cobros y casos' },
  ];
}

/** Un instante de Bogotá: «2026-09-28T08:00:00-05:00». */
export function at(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00-05:00`;
}

function shiftHours(iso: string, hours: number): string {
  const ms = Date.parse(iso) + hours * 3_600_000;
  // De vuelta a hora de Bogotá, con su zona.
  const local = new Date(ms - 5 * 3_600_000).toISOString().slice(0, 19);
  return `${local}-05:00`;
}

export function item(
  id: string,
  assigneeId: string | null,
  workType: string,
  openedAt: string,
  extra: Partial<WorkItem> = {},
): WorkItem {
  return {
    id,
    assigneeId,
    workType,
    title: extra.title ?? `${workType} ${id}`,
    status: extra.doneAt ? 'done' : 'open',
    openedAt,
    source: { kind: 'tracker_row', system: `${workType}s`, ref: id },
    ...extra,
  };
}

interface SeriesOptions {
  cycleHours: number;
  /** Cuántos (los primeros) se cerraron un día después de vencer. */
  late?: number;
  /** Sin fecha de vencimiento. */
  noDue?: boolean;
  quantity?: (k: number) => number;
  unit?: string;
  title?: (k: number) => string;
}

/**
 * `count` cerrados repartidos en `days` (uno por día, en rueda), cerrados a las
 * 3 p. m. y abiertos `cycleHours` antes. Vencen el día que se cerraron (a tiempo)
 * salvo los `late` primeros, que vencían el día anterior.
 */
export function closed(
  prefix: string,
  assigneeId: string,
  workType: string,
  days: readonly string[],
  count: number,
  opts: SeriesOptions,
): WorkItem[] {
  const out: WorkItem[] = [];
  for (let k = 0; k < count; k++) {
    const day = days[k % days.length] ?? days[0] ?? AS_OF;
    const doneAt = at(day, 15);
    const openedAt = shiftHours(doneAt, -opts.cycleHours);
    const dueDay = k < (opts.late ?? 0) ? shiftHours(doneAt, -24).slice(0, 10) : day;
    out.push(
      item(`${prefix}-${k + 1}`, assigneeId, workType, openedAt, {
        doneAt,
        dueAt: opts.noDue ? null : dueDay,
        quantity: opts.quantity ? opts.quantity(k) : null,
        unit: opts.unit ?? null,
        title: opts.title ? opts.title(k) : undefined,
      }),
    );
  }
  return out;
}

const guias = (k: number) => 20 + (k % 4) * 5;
const pesos = (k: number) => 1_500_000 + (k % 3) * 750_000;

/** El registro completo de la empresa de prueba. */
export function workItems(): WorkItem[] {
  const items: WorkItem[] = [];

  // --- Laura: despachos, sobrecargada --------------------------------------
  items.push(
    ...closed('lau-prev', LAURA, 'despacho', PREV_DAYS, 10, {
      cycleHours: 26,
      quantity: guias,
      unit: 'guías',
    }),
    ...closed('lau-cur', LAURA, 'despacho', CUR_DAYS, 9, {
      cycleHours: 30,
      late: 2,
      quantity: guias,
      unit: 'guías',
    }),
  );
  // 16 abiertos: 7 vencidos (vencían antes del 2 oct), 9 al día.
  const lauraOpen: Array<[string, string | null, string | null]> = [
    ['2026-09-15', '2026-09-18', null],
    ['2026-09-17', '2026-09-22', null],
    ['2026-09-21', '2026-09-24', '2026-09-28'],
    ['2026-09-23', '2026-09-26', null],
    ['2026-09-25', '2026-09-29', '2026-09-30'],
    ['2026-09-28', '2026-09-30', null],
    ['2026-09-29', '2026-10-01', null],
    ['2026-09-30', '2026-10-02', at('2026-10-02', 10)],
    ['2026-09-30', '2026-10-05', null],
    ['2026-10-01', '2026-10-05', at('2026-10-02', 9)],
    ['2026-10-01', '2026-10-06', null],
    ['2026-10-02', '2026-10-06', null],
    ['2026-10-02', '2026-10-07', null],
    ['2026-10-02', '2026-10-07', null],
    ['2026-10-02', null, null],
    ['2026-10-02', null, null],
  ];
  lauraOpen.forEach(([opened, due, activity], k) => {
    items.push(
      item(`lau-open-${k + 1}`, LAURA, 'despacho', at(opened, 9), {
        dueAt: due,
        lastActivityAt: activity,
        title: `Despacho pedido ${4500 + k}`,
      }),
    );
  });
  // Uno cancelado: no cuenta en contra.
  items.push(
    item('lau-cancel', LAURA, 'despacho', at('2026-09-20', 9), {
      status: 'cancelled',
      dueAt: '2026-09-22',
    }),
  );

  // --- Andrés: despachos, poca carga ---------------------------------------
  items.push(
    ...closed('and-prev', ANDRES, 'despacho', PREV_DAYS, 9, {
      cycleHours: 24,
      quantity: guias,
      unit: 'guías',
    }),
    ...closed('and-cur', ANDRES, 'despacho', CUR_DAYS, 10, {
      cycleHours: 22,
      quantity: guias,
      unit: 'guías',
    }),
    item('and-open-1', ANDRES, 'despacho', at('2026-10-01', 11), { dueAt: '2026-10-05' }),
    item('and-open-2', ANDRES, 'despacho', at('2026-10-02', 8), { dueAt: '2026-10-06' }),
    item('and-open-3', ANDRES, 'despacho', at('2026-10-02', 9), { dueAt: '2026-10-06' }),
    // Una solicitud vieja: Andrés también sabe de solicitudes.
    ...closed('and-sol', ANDRES, 'solicitud', ['2026-09-10'], 1, { cycleHours: 30 }),
  );

  // --- Sofía: despachos (mejorando) y solicitudes --------------------------
  items.push(
    ...closed('sof-prev', SOFIA, 'despacho', PREV_DAYS, 8, {
      cycleHours: 28,
      late: 2,
      quantity: guias,
      unit: 'guías',
    }),
    ...closed('sof-cur', SOFIA, 'despacho', CUR_DAYS, 13, {
      cycleHours: 18,
      quantity: guias,
      unit: 'guías',
    }),
    ...closed('sof-sol-prev', SOFIA, 'solicitud', PREV_DAYS, 2, { cycleHours: 40 }),
    ...closed('sof-sol-cur', SOFIA, 'solicitud', CUR_DAYS, 3, { cycleHours: 36 }),
    item('sof-open-1', SOFIA, 'despacho', at('2026-10-01', 10), { dueAt: '2026-10-05' }),
    item('sof-open-2', SOFIA, 'despacho', at('2026-10-02', 9), { dueAt: '2026-10-06' }),
    item('sof-open-3', SOFIA, 'despacho', at('2026-10-02', 10), { dueAt: '2026-10-06' }),
    item('sof-open-4', SOFIA, 'despacho', at('2026-10-02', 11), { dueAt: '2026-10-06' }),
  );

  // --- Carlos: cobros, de vacaciones esta semana ----------------------------
  items.push(
    ...closed('car-prev', CARLOS, 'cobro', PREV_DAYS, 9, {
      cycleHours: 72,
      late: 1,
      quantity: pesos,
      unit: 'COP',
    }),
    item('car-open-1', CARLOS, 'cobro', at('2026-09-10', 9), { dueAt: '2026-09-25' }),
    item('car-open-2', CARLOS, 'cobro', at('2026-09-12', 9), { dueAt: '2026-09-29' }),
    item('car-open-3', CARLOS, 'cobro', at('2026-09-15', 9), { dueAt: '2026-10-01' }),
    item('car-open-4', CARLOS, 'cobro', at('2026-09-20', 9), { dueAt: '2026-10-09' }),
    item('car-open-5', CARLOS, 'cobro', at('2026-09-24', 9), { dueAt: '2026-10-15' }),
  );

  // --- Julián: cobros (estable) y casos (bajó) ------------------------------
  items.push(
    ...closed('jul-cob-prev', JULIAN, 'cobro', PREV_DAYS, 6, {
      cycleHours: 70,
      quantity: pesos,
      unit: 'COP',
    }),
    ...closed('jul-cob-cur', JULIAN, 'cobro', CUR_DAYS, 5, {
      cycleHours: 66,
      quantity: pesos,
      unit: 'COP',
    }),
    item('jul-cob-open-1', JULIAN, 'cobro', at('2026-09-29', 9), { dueAt: '2026-10-10' }),
    item('jul-cob-open-2', JULIAN, 'cobro', at('2026-09-30', 9), { dueAt: '2026-10-12' }),
    item('jul-cob-open-3', JULIAN, 'cobro', at('2026-10-01', 9), { dueAt: '2026-10-14' }),
    // Los casos de Gerencia no traen vencimiento.
    ...closed('jul-caso-prev', JULIAN, 'caso', PREV_DAYS, 10, { cycleHours: 20, noDue: true }),
    ...closed('jul-caso-cur', JULIAN, 'caso', CUR_DAYS, 4, { cycleHours: 30, noDue: true }),
  );
  for (let k = 0; k < 6; k++) {
    items.push(
      item(`jul-caso-open-${k + 1}`, JULIAN, 'caso', at(CUR_DAYS[k % 5] ?? AS_OF, 10), {
        lastActivityAt: at('2026-10-02', 9),
      }),
    );
  }

  // --- Valentina: nueva, casos ----------------------------------------------
  items.push(
    ...closed('val-cur', VALENTINA, 'caso', ['2026-10-01'], 1, { cycleHours: 20, noDue: true }),
    item('val-open-1', VALENTINA, 'caso', at('2026-10-01', 14), {
      lastActivityAt: at('2026-10-02', 11),
    }),
    item('val-open-2', VALENTINA, 'caso', at('2026-10-02', 9)),
  );

  // --- Sin responsable: 7 solicitudes ---------------------------------------
  const pending: Array<[string, string | null]> = [
    ['2026-09-22', '2026-09-29'],
    ['2026-09-24', '2026-09-30'],
    ['2026-09-28', '2026-10-05'],
    ['2026-09-29', '2026-10-06'],
    ['2026-09-30', null],
    ['2026-10-01', null],
    ['2026-10-01', '2026-10-08'],
  ];
  pending.forEach(([opened, due], k) => {
    items.push(
      item(`sol-${k + 1}`, null, 'solicitud', at(opened, 8), {
        dueAt: due,
        title: `Solicitud cliente ${k + 1}`,
      }),
    );
  });

  return items;
}
