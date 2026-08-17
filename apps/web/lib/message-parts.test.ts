import { describe, expect, it } from 'vitest';
import {
  PART_MESSAGE_CAP,
  PART_RESULT_CAP,
  PART_RESULT_FLOOR,
  PART_SERVE_CAP,
  buildStoredParts,
  capResult,
  capServeParts,
  capStoredParts,
  isTruncatedResult,
  parseStoredParts,
  toolInvocationsOf,
} from './message-parts';

/**
 * Lo que se defiende aquí es LA CRONOLOGÍA Y EL TOPE. La cronología, porque es
 * la única razón de que la columna `parts` exista: una conversación reabierta
 * tiene que dibujarse igual que en vivo. El tope, porque es lo que impide que
 * un scrape de 4 MB convierta cada apertura de esa conversación en una
 * descarga de 4 MB — y un recorte sin marca sería un resultado que miente.
 */

const step = (over: Record<string, unknown> = {}) => ({
  text: 'Coltrans debe 42 millones.',
  reasoning: 'Reviso la cartera primero.',
  toolCalls: [{ toolCallId: 'c1', toolName: 'payments_receivables', args: { client: 'Coltrans' } }],
  toolResults: [{ toolCallId: 'c1', result: { total: 42_000_000 } }],
  ...over,
});

describe('la cronología reconstruida desde los steps', () => {
  it('razonamiento, texto y llamadas salen en el orden en que pasaron', () => {
    const parts = buildStoredParts([
      {
        reasoning: 'pienso',
        text: 'déjame revisar',
        toolCalls: [{ toolCallId: 'c1', toolName: 'kb_search' }],
        toolResults: [{ toolCallId: 'c1', result: { hits: [] } }],
      },
      { text: 'no hay nada.' },
    ]);
    expect(parts?.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool-invocation', 'text']);
  });

  it('un turno de solo texto no guarda parts: content ya lo lleva entero', () => {
    expect(buildStoredParts([{ text: 'Hola, ¿en qué te ayudo?' }])).toBeNull();
    expect(buildStoredParts([])).toBeNull();
  });

  it('una llamada sin resultado queda en estado call, que es la verdad de un turno interrumpido', () => {
    const parts = buildStoredParts([
      { toolCalls: [{ toolCallId: 'c9', toolName: 'gmail_search', args: {} }], toolResults: [] },
    ]);
    const inv = parts?.[0];
    expect(inv?.type).toBe('tool-invocation');
    if (inv?.type === 'tool-invocation') expect(inv.toolInvocation.state).toBe('call');
  });

  it('la invocación guarda args Y resultado completos', () => {
    const parts = buildStoredParts([step()]);
    const inv = parts?.find((p) => p.type === 'tool-invocation');
    if (inv?.type !== 'tool-invocation' || inv.toolInvocation.state !== 'result') {
      throw new Error('faltó la invocación con resultado');
    }
    expect(inv.toolInvocation.args).toEqual({ client: 'Coltrans' });
    expect(inv.toolInvocation.result).toEqual({ total: 42_000_000 });
  });
});

describe('el tope por resultado', () => {
  it('un resultado pequeño pasa intacto, sin marca y sin copia', () => {
    const result = { total: 42 };
    expect(capResult(result, PART_RESULT_CAP)).toBe(result);
  });

  it('uno que se pasa queda truncado CON marca, con su tamaño real y con el primer trozo', () => {
    const giant = { rows: 'x'.repeat(PART_RESULT_CAP * 2) };
    const capped = capResult(giant, PART_RESULT_CAP);
    if (!isTruncatedResult(capped)) throw new Error('debió truncarse');
    expect(capped.__truncated).toBe(true);
    expect(capped.originalLength).toBe(JSON.stringify(giant).length);
    expect(capped.preview).toBe(JSON.stringify(giant).slice(0, PART_RESULT_CAP));
  });

  it('re-recortar un ya-truncado conserva cuánto medía DE VERDAD', () => {
    const first = capResult({ rows: 'x'.repeat(PART_RESULT_CAP * 2) }, PART_RESULT_CAP);
    const second = capResult(first, PART_SERVE_CAP);
    if (!isTruncatedResult(first) || !isTruncatedResult(second)) throw new Error('debió truncarse');
    expect(second.originalLength).toBe(first.originalLength);
    expect(second.preview.length).toBe(PART_SERVE_CAP);
  });

  it('un resultado no serializable deja constancia en vez de tumbar la persistencia', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isTruncatedResult(capResult(circular, PART_RESULT_CAP))).toBe(true);
  });
});

describe('el tope por mensaje', () => {
  it('doce resultados de 90 KB no hacen un mensaje de un mega: baja al piso', () => {
    // Cada uno por debajo del tope por resultado, la suma muy por encima del
    // tope por mensaje — el caso que el primer recorte no puede ver.
    const parts = buildStoredParts(
      Array.from({ length: 12 }, (_, i) => ({
        toolCalls: [{ toolCallId: `c${i}`, toolName: 'web_scrape', args: {} }],
        toolResults: [{ toolCallId: `c${i}`, result: { html: 'x'.repeat(90_000) } }],
      })),
    );
    if (!parts) throw new Error('debió haber parts');
    const capped = capStoredParts(parts);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(PART_MESSAGE_CAP);
    for (const p of capped) {
      if (p.type !== 'tool-invocation' || p.toolInvocation.state !== 'result') continue;
      const r = p.toolInvocation.result;
      if (!isTruncatedResult(r)) throw new Error('todos debieron bajar al piso');
      expect(r.preview.length).toBeLessThanOrEqual(PART_RESULT_FLOOR);
    }
  });

  it('el texto y el razonamiento no se recortan nunca: los acota el modelo', () => {
    const parts = buildStoredParts([step({ text: 'y'.repeat(50_000) })]);
    if (!parts) throw new Error('debió haber parts');
    const capped = capStoredParts(parts);
    const text = capped.find((p) => p.type === 'text');
    if (text?.type !== 'text') throw new Error('faltó el texto');
    expect(text.text.length).toBe(50_000);
  });
});

describe('el ida y vuelta por jsonb', () => {
  it('lo que se escribe es exactamente lo que se vuelve a leer', () => {
    const escrito = capStoredParts(buildStoredParts([step(), { text: 'listo.' }]) ?? []);
    // El viaje de verdad: se serializa a jsonb y vuelve.
    const leido = parseStoredParts(JSON.parse(JSON.stringify(escrito)));
    expect(leido).toEqual(escrito);
  });

  it('lo que venga de la base no puede tumbar la lectura de un hilo', () => {
    expect(parseStoredParts(null)).toBeUndefined();
    expect(parseStoredParts('no soy un array')).toBeUndefined();
    expect(parseStoredParts([null, 3, { type: 'text' }])).toBeUndefined();
    // Una entrada rara se descarta y las demás se dibujan.
    const mixto = parseStoredParts([
      { type: 'text', text: 'hola' },
      { type: 'tool-invocation', toolInvocation: { toolName: 'sin id' } },
      { basura: true },
    ]);
    expect(mixto).toHaveLength(1);
  });

  it('una invocación guardada sin estado result vuelve como call', () => {
    const leido = parseStoredParts([
      { type: 'tool-invocation', toolInvocation: { toolCallId: 'c1', toolName: 'kb_search' } },
    ]);
    const inv = leido?.[0];
    if (inv?.type !== 'tool-invocation') throw new Error('faltó la invocación');
    expect(inv.toolInvocation.state).toBe('call');
  });
});

describe('las invocaciones planas que el resto del cliente lee', () => {
  it('salen de las MISMAS parts que se van a pintar, ya recortadas', () => {
    const parts = capServeParts(
      capStoredParts(
        buildStoredParts([
          step({ toolResults: [{ toolCallId: 'c1', result: { html: 'x'.repeat(60_000) } }] }),
        ]) ?? [],
      ),
    );
    const invs = toolInvocationsOf(parts);
    expect(invs).toHaveLength(1);
    const first = invs[0];
    if (first?.state !== 'result') throw new Error('debió traer resultado');
    // Al servir, el resultado viaja al tope de 20 KB — no al de 100.
    expect(JSON.stringify(first.result).length).toBeLessThanOrEqual(PART_SERVE_CAP + 200);
    expect(isTruncatedResult(first.result)).toBe(true);
  });
});
