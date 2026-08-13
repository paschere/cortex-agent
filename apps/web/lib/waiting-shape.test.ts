import { describe, expect, it } from 'vitest';
import {
  type WaitingCounts,
  agoPhrase,
  dayPhrase,
  noticeFromCounts,
  summarizeWaiting,
  waitingTotal,
} from './waiting-shape';

/**
 * Estas pruebas SON la especificación de la frase de /dashboard.
 *
 * La regla que defienden no es de redacción, es de arquitectura: la línea que
 * resume lo que te espera se escribe con reglas y nunca con un modelo, porque
 * se dibuja en cada carga de la pantalla a la que redirige `/`. Que sea pura
 * es lo que permite comprobar aquí, caso por caso, que dice la verdad — y si
 * alguien mañana la sustituye por una llamada a un modelo, este archivo es lo
 * primero que deja de poder existir.
 */

const NONE: WaitingCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

function counts(partial: Partial<WaitingCounts>): WaitingCounts {
  return { ...NONE, ...partial };
}

describe('la frase que resume lo que espera', () => {
  it('no inventa trabajo cuando no hay ninguno', () => {
    expect(
      summarizeWaiting({ counts: NONE, overdue: 0, oldestDays: null, oldestQueue: null }),
    ).toBe('No hay nada esperándote.');
  });

  it('cuenta las cuatro colas juntas y escribe el número con letra', () => {
    expect(
      summarizeWaiting({
        counts: counts({ approvals: 1, commitments: 1, actions: 1 }),
        overdue: 0,
        oldestDays: null,
        oldestQueue: null,
      }),
    ).toBe('Tres cosas te esperan.');
  });

  it('es la frase del ejemplo: el total y lo que más lleva esperando', () => {
    expect(
      summarizeWaiting({
        counts: counts({ actions: 2, errands: 1 }),
        overdue: 0,
        oldestDays: 9,
        oldestQueue: 'actions',
      }),
    ).toBe('Tres cosas te esperan y una lleva nueve días.');
  });

  it('concuerda en singular sin decir «una lleva» de la única cosa que hay', () => {
    expect(
      summarizeWaiting({
        counts: counts({ actions: 1 }),
        overdue: 0,
        oldestDays: 9,
        oldestQueue: 'actions',
      }),
    ).toBe('Una cosa te espera y lleva nueve días.');
  });

  it('calla la edad mientras la espera es el trabajo del día', () => {
    // Dos días no es un hallazgo; anunciarlo enseñaría a ignorar la línea justo
    // cuando por fin diga nueve. Ver STALE_DAYS.
    expect(
      summarizeWaiting({
        counts: counts({ approvals: 2 }),
        overdue: 0,
        oldestDays: 2,
        oldestQueue: 'approvals',
      }),
    ).toBe('Dos cosas te esperan.');
    expect(
      summarizeWaiting({
        counts: counts({ approvals: 2 }),
        overdue: 0,
        oldestDays: 3,
        oldestQueue: 'approvals',
      }),
    ).toBe('Dos cosas te esperan y una lleva tres días.');
  });

  it('pone lo vencido delante de lo viejo cuando son cosas distintas', () => {
    expect(
      summarizeWaiting({
        counts: counts({ commitments: 6, actions: 4, errands: 1 }),
        overdue: 2,
        oldestDays: 12,
        oldestQueue: 'actions',
      }),
    ).toBe('Once cosas te esperan: dos ya se vencieron y una lleva doce días.');
  });

  it('no cuenta dos veces el mismo vencimiento', () => {
    // Un solo vencimiento pasado de fecha que además es lo más viejo de todo:
    // «una ya se venció y una lleva doce días» sonaría a dos problemas.
    expect(
      summarizeWaiting({
        counts: counts({ commitments: 2, actions: 1 }),
        overdue: 1,
        oldestDays: 12,
        oldestQueue: 'commitments',
      }),
    ).toBe('Tres cosas te esperan y una lleva doce días.');
  });

  it('dice lo vencido aunque nada lleve esperando lo suficiente', () => {
    expect(
      summarizeWaiting({
        counts: counts({ commitments: 3 }),
        overdue: 1,
        oldestDays: 1,
        oldestQueue: 'commitments',
      }),
    ).toBe('Tres cosas te esperan y una ya se venció.');
  });

  it('habla de una única cosa vencida sin repetir el sujeto', () => {
    expect(
      summarizeWaiting({
        counts: counts({ commitments: 1 }),
        overdue: 1,
        oldestDays: null,
        oldestQueue: null,
      }),
    ).toBe('Una cosa te espera y ya se venció.');
  });

  it('se conforma con los conteos cuando nadie leyó el contenido', () => {
    // El aviso del chat entra por aquí: sin edad ni vencidos, la cabeza sola
    // sigue siendo verdad.
    expect(
      summarizeWaiting({
        counts: counts({ approvals: 4 }),
        overdue: 0,
        oldestDays: null,
        oldestQueue: null,
      }),
    ).toBe('Cuatro cosas te esperan.');
  });

  it('pasa a cifras cuando la letra estorba', () => {
    expect(
      summarizeWaiting({
        counts: counts({ actions: 20, commitments: 3 }),
        overdue: 0,
        oldestDays: 40,
        oldestQueue: 'actions',
      }),
    ).toBe('23 cosas te esperan y una lleva 40 días.');
  });

  it('aguanta un conteo imposible sin escribir una frase imposible', () => {
    expect(
      summarizeWaiting({
        counts: { approvals: Number.NaN, commitments: -3, actions: 1, errands: 0 },
        overdue: 0,
        oldestDays: null,
        oldestQueue: null,
      }),
    ).toBe('Una cosa te espera.');
  });
});

describe('waitingTotal', () => {
  it('suma las cuatro y descarta la basura', () => {
    expect(waitingTotal(counts({ approvals: 1, commitments: 2, actions: 3, errands: 4 }))).toBe(10);
    expect(waitingTotal({ approvals: -1, commitments: Number.NaN, actions: 2, errands: 0 })).toBe(
      2,
    );
  });
});

describe('las frases de tiempo', () => {
  it('escribe los días como los diría una persona', () => {
    expect(dayPhrase(1)).toBe('un día');
    expect(dayPhrase(9)).toBe('nueve días');
    expect(dayPhrase(23)).toBe('23 días');
  });

  it('nunca se rinde a una fecha: los días siguen siendo días', () => {
    expect(agoPhrase(30_000)).toBe('hace un momento');
    expect(agoPhrase(60_000)).toBe('hace un minuto');
    expect(agoPhrase(5 * 60_000)).toBe('hace cinco minutos');
    expect(agoPhrase(60 * 60_000)).toBe('hace una hora');
    expect(agoPhrase(3 * 60 * 60_000)).toBe('hace tres horas');
    expect(agoPhrase(9 * 86_400_000)).toBe('hace nueve días');
    expect(agoPhrase(-5)).toBe('hace un momento');
  });

  it('nunca escribe «hace NaN días» por una fecha ilegible', () => {
    expect(agoPhrase(Number.NaN)).toBe('hace un momento');
    expect(dayPhrase(Number.NaN)).toBe('cero días');
  });
});

describe('el aviso del chat', () => {
  it('sólo enlaza las colas que tienen algo, en el orden de siempre', () => {
    const notice = noticeFromCounts(counts({ approvals: 2, actions: 1 }));
    expect(notice.total).toBe(3);
    expect(notice.sentence).toBe('Tres cosas te esperan.');
    expect(notice.queues.map((q) => q.queue)).toEqual(['approvals', 'actions']);
    expect(notice.queues[0]).toEqual({
      queue: 'approvals',
      label: 'Aprobaciones',
      href: '/approvals',
      count: 2,
    });
  });

  it('no tiene nada que decir con las cuatro colas vacías', () => {
    const notice = noticeFromCounts(NONE);
    expect(notice.total).toBe(0);
    expect(notice.queues).toEqual([]);
  });
});
