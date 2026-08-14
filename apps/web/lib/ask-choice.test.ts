import { describe, expect, it } from 'vitest';
import {
  ASK_CHOICE_DESCRIPTION,
  AskChoiceSchema,
  MAX_CHOICE_OPTIONS,
  askChoiceResult,
  isAwaitingChoice,
  looksLikeApproval,
} from './ask-choice';

const cliente = {
  question: '¿Cuál de los tres es?',
  options: [
    { label: 'Transportes del Valle SAS', detail: 'NIT 900.123.456 · Cali' },
    { label: 'Transportes del Valle Ltda', detail: 'NIT 830.998.112 · Bogotá' },
  ],
};

describe('la pregunta con opciones', () => {
  it('devuelve el centinela con la pregunta y las opciones', () => {
    const out = askChoiceResult(cliente, { alreadyAsked: false });
    expect(isAwaitingChoice(out)).toBe(true);
    if (!isAwaitingChoice(out)) return;
    expect(out.question).toBe('¿Cuál de los tres es?');
    expect(out.options).toHaveLength(2);
    expect(out.options[0]?.detail).toBe('NIT 900.123.456 · Cali');
  });

  it('copia campo por campo: nada que el modelo invente llega a la pantalla', () => {
    const out = askChoiceResult(
      {
        question: '¿Hoy o el lunes?',
        options: [
          // @ts-expect-error — a propósito: esto es lo que un modelo podría mandar.
          { label: 'Hoy', href: 'https://algo', __proto__: { x: 1 } },
          { label: 'El lunes' },
        ],
      },
      { alreadyAsked: false },
    );
    if (!isAwaitingChoice(out)) throw new Error('debería preguntar');
    expect(Object.keys(out.options[0] ?? {})).toEqual(['label']);
  });

  it('sólo una por turno, y la segunda lo dice en vez de fallar en silencio', () => {
    const out = askChoiceResult(cliente, { alreadyAsked: true });
    expect(out.__awaiting_choice).toBe(false);
    expect(out.note).toMatch(/una pregunta esperando/i);
  });
});

describe('el sí/no, que es una aprobación con otro nombre', () => {
  it('se rechaza', () => {
    expect(looksLikeApproval([{ label: 'Sí' }, { label: 'No' }])).toBe(true);
    expect(looksLikeApproval([{ label: 'no' }, { label: 'dale' }])).toBe(true);
    expect(looksLikeApproval([{ label: 'Confirmo' }, { label: 'Cancelar' }])).toBe(true);
    const out = askChoiceResult(
      { question: '¿Lo mando?', options: [{ label: 'Sí' }, { label: 'No' }] },
      { alreadyAsked: false },
    );
    expect(out.__awaiting_choice).toBe(false);
    expect(out.note).toMatch(/su propia confirmación/i);
  });

  it('pero una decisión de verdad que empieza por sí o por no pasa', () => {
    // La comparación es por etiqueta completa y nunca por subcadena. Éstas son
    // decisiones reales y bloquearlas sería el fallo caro de esta regla.
    expect(
      looksLikeApproval([{ label: 'Sí, pero el lunes' }, { label: 'No antes del cierre' }]),
    ).toBe(false);
    expect(looksLikeApproval([{ label: 'En pesos' }, { label: 'En dólares' }])).toBe(false);
  });

  it('y tres opciones nunca son una aprobación', () => {
    expect(
      looksLikeApproval([{ label: 'Sí' }, { label: 'No' }, { label: 'Sólo el primero' }]),
    ).toBe(false);
  });
});

describe('los límites, que están en el esquema y no sólo en la descripción', () => {
  it('una sola opción no es una decisión', () => {
    expect(
      AskChoiceSchema.safeParse({ question: '¿Cuál?', options: [{ label: 'Ése' }] }).success,
    ).toBe(false);
  });

  it('seis opciones son una lista, no una decisión', () => {
    const options = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({
      label: `Opción ${i}`,
    }));
    expect(AskChoiceSchema.safeParse({ question: '¿Cuál?', options }).success).toBe(false);
  });

  it('la pregunta no puede ser un informe', () => {
    expect(
      AskChoiceSchema.safeParse({ question: 'x'.repeat(400), options: cliente.options }).success,
    ).toBe(false);
  });
});

describe('el centinela', () => {
  it('no confunde otros resultados con una pregunta', () => {
    expect(isAwaitingChoice(null)).toBe(false);
    expect(isAwaitingChoice({ __requires_confirmation: true, toolId: 'gmail.send_message' })).toBe(
      false,
    );
    expect(isAwaitingChoice({ __awaiting_choice: false, note: 'no' })).toBe(false);
    // Una pregunta con una sola opción no se dibuja: la tarjeta ofrecería un
    // botón, y un botón solo es una confirmación disfrazada.
    expect(
      isAwaitingChoice({ __awaiting_choice: true, question: '¿?', options: [{ label: 'a' }] }),
    ).toBe(false);
  });
});

describe('la descripción', () => {
  it('dice las cuatro cosas que no se pueden hacer con esto', () => {
    // No es una prueba de estilo: la descripción ES el guardarraíl de producto
    // de esta herramienta, y borrar una de las cuatro negativas al reescribirla
    // es exactamente el cambio que nadie notaría hasta ver las conversaciones.
    expect(ASK_CHOICE_DESCRIPTION).toMatch(/permission/i);
    expect(ASK_CHOICE_DESCRIPTION).toMatch(/already told you/i);
    expect(ASK_CHOICE_DESCRIPTION).toMatch(/a tool can find out/i);
    expect(ASK_CHOICE_DESCRIPTION).toMatch(/open questions/i);
    expect(ASK_CHOICE_DESCRIPTION).toMatch(/ONE per turn/);
  });
});
