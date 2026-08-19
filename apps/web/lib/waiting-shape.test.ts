import { describe, expect, it } from 'vitest';
import {
  type WaitingCounts,
  type WaitingLead,
  agoPhrase,
  briefingAsk,
  briefingAskAgain,
  briefingLetter,
  isGreeting,
  isWaitingYes,
  lingeringSentence,
  pickBriefingLead,
  whatsappBriefingGate,
  clipTitle,
  dayPhrase,
  hasWaitingWork,
  noticeFromCounts,
  summarizeWaiting,
  waitingQuestion,
  waitingTotal,
} from './waiting-shape';

function leadAsk(ask: string): WaitingLead {
  return {
    queue: 'commitments',
    title: 'Factura 4412',
    detail: null,
    ask,
  };
}

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

describe('lo que se pregunta al tocar el aviso', () => {
  /**
   * El aviso dejó de enlazar a /dashboard y ahora ejecuta el turno. La pregunta
   * no puede ser una constante: «¿qué espera mi aprobación?» con lo único
   * pendiente siendo un encargo atascado se contesta «nada», que es verdad y no
   * sirve de nada.
   */
  it('pregunta por la cola concreta cuando sólo hay una', () => {
    expect(waitingQuestion(noticeFromCounts(counts({ approvals: 2 })).queues)).toBe(
      '¿Qué espera mi aprobación?',
    );
    expect(waitingQuestion(noticeFromCounts(counts({ errands: 1 })).queues)).toBe(
      '¿Cómo van mis encargos?',
    );
  });

  it('se abre en cuanto hay dos, en vez de elegir una y esconder la otra', () => {
    expect(waitingQuestion(noticeFromCounts(counts({ approvals: 1, commitments: 3 })).queues)).toBe(
      '¿Qué está esperando algo de mí?',
    );
  });
});

describe('el sí del briefing', () => {
  it('nombra el asunto, no la cola', () => {
    expect(briefingAsk('commitments', 'Cotización Andina')).toBe(
      '¿Le escribo por «Cotización Andina»?',
    );
    expect(briefingAsk('actions', 'Recordatorio de pago')).toBe('¿Mando «Recordatorio de pago»?');
    expect(briefingAsk('approvals', 'Enviar el correo redactado')).toBe(
      '¿Apruebo «Enviar el correo redactado»?',
    );
    expect(briefingAsk('errands', 'El radicado de la DIM')).toBe(
      '¿Te contesto lo que te preguntó sobre «El radicado de la DIM»?',
    );
  });

  it('un correo ya enviado pide escribir de nuevo, no mandar el borrador', () => {
    expect(briefingAskAgain('Factura 4412')).toBe('¿Le escribo de nuevo por «Factura 4412»?');
  });

  it('recorta un asunto largo para que la pregunta quepa en un renglón', () => {
    const long = 'A'.repeat(90);
    const ask = briefingAsk('commitments', long);
    expect(ask.startsWith('¿Le escribo por «')).toBe(true);
    expect(ask.endsWith('…»?')).toBe(true);
    expect(clipTitle(long).endsWith('…')).toBe(true);
    expect(clipTitle(long).length).toBeLessThanOrEqual(72);
  });
});

describe('quién no contestó gana el briefing', () => {
  const coltrans = {
    title: 'Factura 4412',
    detail: 'cartera@coltrans.com.co',
    days: 9,
  };
  const draft = {
    queue: 'actions' as const,
    title: 'Recordatorio de pago',
    detail: null,
    days: 2,
  };

  it('una aprobación que expira gana a un silencio de nueve días', () => {
    const lead = pickBriefingLead({
      approval: { title: 'Enviar el cobro', detail: null },
      queue: draft,
      lingering: coltrans,
    });
    expect(lead?.queue).toBe('approvals');
    expect(lead?.ask).toContain('¿Apruebo');
  });

  it('un silencio largo gana a un borrador fresco', () => {
    const lead = pickBriefingLead({
      approval: null,
      queue: draft,
      lingering: coltrans,
    });
    expect(lead?.ask).toBe('¿Le escribo de nuevo por «Factura 4412»?');
    expect(lead?.title).toBe('Factura 4412');
  });

  it('sin colas, el silencio solo todavía abre el día', () => {
    const lead = pickBriefingLead({
      approval: null,
      queue: null,
      lingering: coltrans,
    });
    expect(lead?.ask).toBe('¿Le escribo de nuevo por «Factura 4412»?');
    expect(lingeringSentence(9)).toBe('Un correo lleva nueve días sin respuesta.');
  });

  it('seis días todavía no son noticia', () => {
    expect(
      pickBriefingLead({
        approval: null,
        queue: draft,
        lingering: { ...coltrans, days: 6 },
      })?.title,
    ).toBe('Recordatorio de pago');
  });
});

describe('el briefing en texto, el que WhatsApp puede decir', () => {
  it('nombra el asunto y pide el sí', () => {
    const letter = briefingLetter({
      total: 1,
      sentence: 'Se te vence una cosa.',
      queues: [{ queue: 'commitments', label: 'Vencimientos', href: '/commitments', count: 1 }],
      lead: {
        queue: 'commitments',
        title: 'Factura 4412',
        detail: 'Coltrans · hace 9 días',
        ask: briefingAsk('commitments', 'Factura 4412'),
      },
    });
    expect(letter).toContain('Factura 4412');
    expect(letter).toContain('¿Le escribo por «Factura 4412»?');
    expect(letter).toContain('Responde «sí» y lo hago.');
  });

  it('un sí de una palabra no es una pregunta', () => {
    expect(isWaitingYes('sí')).toBe(true);
    expect(isWaitingYes('Si')).toBe(true);
    expect(isWaitingYes('dale')).toBe(true);
    expect(isWaitingYes('si puedes')).toBe(false);
    expect(isGreeting('hola')).toBe(true);
    expect(isGreeting('Hola, ¿cuánto debe Coltrans?')).toBe(false);
  });

  it('sin colas, un silencio de nueve días todavía es el briefing', () => {
    const letter = briefingLetter({
      total: 0,
      sentence: lingeringSentence(9),
      queues: [],
      lead: {
        queue: 'actions',
        title: 'Factura 4412',
        detail: 'cartera@coltrans.com.co',
        ask: briefingAskAgain('Factura 4412'),
      },
    });
    expect(letter).toContain('Factura 4412');
    expect(letter).toContain('¿Le escribo de nuevo por «Factura 4412»?');
    expect(hasWaitingWork({ total: 0, lead: leadAsk('¿Le escribo de nuevo?') })).toBe(true);
    expect(hasWaitingWork({ total: 0 })).toBe(false);
    expect(whatsappBriefingGate('hola', { total: 0, lead: leadAsk('¿Le escribo de nuevo?') })).toBe(
      'brief',
    );
  });

  it('saludo con cola → briefing; sí → el turno; el resto corre', () => {
    const waiting = { total: 1, lead: leadAsk('¿Le escribo?') };
    expect(whatsappBriefingGate('hola', waiting)).toBe('brief');
    expect(whatsappBriefingGate('sí', waiting)).toBe('yes');
    expect(whatsappBriefingGate('¿cuánto debe Coltrans?', waiting)).toBe('run');
    expect(whatsappBriefingGate('hola', { total: 0 })).toBe('run');
  });
});
