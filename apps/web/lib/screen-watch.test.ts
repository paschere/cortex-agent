import { describe, expect, it } from 'vitest';
import {
  WATCH_CHANGE_THRESHOLD,
  WATCH_COOLDOWN_MS,
  WATCH_MAX_LOOKS,
  formatUsd,
  frameChange,
  isRepeatNotice,
  newWatchState,
  parseWatchVerdict,
  recordLook,
  spendSummary,
  spentUsd,
  stepWatch,
} from './screen-watch';

/**
 * Las tres cosas que esta función tiene que hacer bien, probadas sin gastar un
 * peso: **NINGUNA PRUEBA DE ESTE ARCHIVO LLAMA A ANTHROPIC NI A VOYAGE**, ni a
 * un navegador, ni a la base. Los tres riesgos de la vigilancia son puros por
 * construcción, y por eso se sacaron a un módulo:
 *
 *   1. DECIDIR QUE LA PANTALLA CAMBIÓ sin modelo de por medio, que es lo que
 *      separa esto de una factura de US$2 por hora y por persona.
 *   2. EL TOPE, que es lo que separa una factura sorpresa de un aviso en
 *      pantalla.
 *   3. QUE «NO HAY NADA QUE DECIR» NO PRODUZCA MENSAJE, que es lo que separa un
 *      asistente que sirve de uno que la gente apaga el primer día.
 */

/** Un thumbnail RGBA de un solo tono. Lo que devolvería un canvas de 48×27. */
function flat(level: number, pixels = 48 * 27): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = level;
    data[i + 1] = level;
    data[i + 2] = level;
    data[i + 3] = 255;
  }
  return data;
}

/** Un thumbnail claro con una mancha oscura encima: un banner que apareció. */
function withBanner(fraction: number, pixels = 48 * 27): Uint8ClampedArray {
  const data = flat(255, pixels);
  const stained = Math.round(pixels * fraction);
  for (let p = 0; p < stained; p++) {
    const i = p * 4;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  return data;
}

describe('frameChange — decidir que la pantalla cambió, sin modelo', () => {
  it('dos cuadros idénticos no cambiaron nada', () => {
    // El caso normal, y el que paga esta función: una persona leyendo. Si esto
    // devolviera algo distinto de cero, la vigilancia miraría cada dos segundos.
    expect(frameChange(flat(200), flat(200))).toBe(0);
  });

  it('el ruido de un píxel suelto queda muy por debajo del umbral', () => {
    // Un cursor parpadeando, el antialias de una fuente, un reloj que avanza.
    // Todo eso mueve unos pocos píxeles de 1 296, y nada de eso vale una foto.
    const before = flat(255);
    const after = flat(255);
    after[0] = 0;
    after[1] = 0;
    after[2] = 0;
    expect(frameChange(before, after)).toBeLessThan(WATCH_CHANGE_THRESHOLD);
  });

  it('un banner sobre un décimo de la pantalla sí cruza el umbral', () => {
    // El evento que esta función existe para no perderse: aparece un mensaje de
    // error. Un décimo del área a contraste máximo tiene que gastar una mirada.
    expect(frameChange(flat(255), withBanner(0.1))).toBeGreaterThan(WATCH_CHANGE_THRESHOLD);
  });

  it('un cambio del 1 % del área no alcanza, y uno del 5 % sí', () => {
    // El umbral queda entre estos dos a propósito: por debajo están los adornos
    // de una interfaz, por encima está algo que alguien puso ahí para leerse.
    expect(frameChange(flat(255), withBanner(0.01))).toBeLessThan(WATCH_CHANGE_THRESHOLD);
    expect(frameChange(flat(255), withBanner(0.05))).toBeGreaterThan(WATCH_CHANGE_THRESHOLD);
  });

  it('mide luminancia y no un canal, así que el color del aviso no importa', () => {
    // Un banner rojo y uno azul del mismo tamaño son el mismo evento. Comparando
    // sólo el canal rojo, el azul casi no movería la cifra y se perdería.
    const red = flat(255);
    const blue = flat(255);
    for (let i = 0; i < 48 * 27 * 0.1 * 4; i += 4) {
      red[i] = 220;
      red[i + 1] = 30;
      red[i + 2] = 30;
      blue[i] = 30;
      blue[i + 1] = 30;
      blue[i + 2] = 220;
    }
    const rojo = frameChange(flat(255), red);
    const azul = frameChange(flat(255), blue);
    expect(rojo).toBeGreaterThan(WATCH_CHANGE_THRESHOLD);
    expect(azul).toBeGreaterThan(WATCH_CHANGE_THRESHOLD);
    expect(Math.abs(rojo - azul)).toBeLessThan(0.02);
  });

  it('un cambio de tamaño cuenta como que cambió todo', () => {
    // La pestaña se maximizó. Suponer lo contrario dejaría la vigilancia ciega
    // justo después de que alguien cambió lo que está viendo.
    expect(frameChange(flat(200, 100), flat(200, 400))).toBe(1);
  });

  it('sin cuadro anterior no hay comparación posible: cambió todo', () => {
    expect(frameChange(new Uint8ClampedArray(0), flat(200))).toBe(1);
  });
});

describe('stepWatch — cuándo se gasta una mirada', () => {
  const quiet = { change: 0, now: 100_000, busy: false };
  const moving = { change: 0.3, now: 100_000, busy: false };

  it('una pantalla quieta no cuesta nada, para siempre', () => {
    let state = newWatchState();
    for (let i = 0; i < 500; i++) {
      const step = stepWatch(state, { ...quiet, now: i * 2_000 });
      expect(step.look).toBe(false);
      state = step.state;
    }
    // Quinientos ticks son más de quince minutos compartiendo la pestaña. Cero
    // llamadas al modelo: el costo de tener esto encendido y no hacer nada es
    // exactamente cero.
    expect(state.looks).toBe(0);
    expect(spentUsd(state)).toBe(0);
  });

  it('no mira mientras la pantalla se sigue moviendo, y mira cuando se quieta', () => {
    // Una página cargando: diez ticks de cambio, todos a medio pintar. El cuadro
    // que sirve es el de cuando paró, y cuesta una mirada en vez de diez.
    let state = newWatchState();
    for (let i = 0; i < 10; i++) {
      const step = stepWatch(state, { ...moving, now: i * 2_000 });
      expect(step.look).toBe(false);
      state = step.state;
    }
    const settled = stepWatch(state, { ...quiet, now: 20_000 });
    expect(settled.look).toBe(true);
  });

  it('un cambio ocurrido durante un turno se aplaza, no se pierde', () => {
    // La persona preguntó algo y le están respondiendo. Un aviso encima de una
    // respuesta a medio escribir interrumpe justo lo que estaba leyendo.
    let state = newWatchState();
    state = stepWatch(state, { change: 0.3, now: 1_000, busy: true }).state;
    const during = stepWatch(state, { change: 0, now: 3_000, busy: true });
    expect(during.look).toBe(false);
    state = during.state;
    // Terminó el turno: la pantalla sigue distinta a como estaba, así que ahora sí.
    expect(stepWatch(state, { change: 0, now: 5_000, busy: false }).look).toBe(true);
  });

  it('respeta el enfriamiento entre dos miradas', () => {
    let state = recordLook(newWatchState(), 100_000, 1280, 720);
    state = stepWatch(state, { change: 0.3, now: 102_000, busy: false }).state;

    const tooSoon = stepWatch(state, {
      change: 0,
      now: 100_000 + WATCH_COOLDOWN_MS - 1,
      busy: false,
    });
    expect(tooSoon.look).toBe(false);

    const later = stepWatch(state, { change: 0, now: 100_000 + WATCH_COOLDOWN_MS, busy: false });
    expect(later.look).toBe(true);
  });

  it('la primera mirada no espera enfriamiento', () => {
    // `lastLookAt` arranca en 0 y un reloj de verdad está a 1,7 billones de ms,
    // así que la resta daría «hace muchísimo» por accidente. Aquí es a propósito:
    // sin mirada previa no hay nada de qué enfriarse.
    const state = stepWatch(newWatchState(), { change: 0.3, now: 5, busy: false }).state;
    expect(stepWatch(state, { change: 0, now: 6, busy: false }).look).toBe(true);
  });
});

describe('el tope — nadie descubre esto en la factura', () => {
  it('se agota exactamente en el tope y se apaga solo', () => {
    let state = newWatchState();
    let now = 0;
    let looks = 0;
    let exhausted = false;

    // Un simulacro del peor caso: la pantalla cambia y se quieta, sin parar.
    for (let tick = 0; tick < 5_000 && !exhausted; tick++) {
      now += 2_000;
      const change = tick % 2 === 0 ? 0.3 : 0;
      const step = stepWatch(state, { change, now, busy: false });
      exhausted = step.exhausted;
      state = step.state;
      if (step.look) {
        state = recordLook(state, now, 1280, 720);
        looks++;
      }
    }

    expect(looks).toBe(WATCH_MAX_LOOKS);
    expect(exhausted).toBe(true);
    // Y el techo del gasto de una sesión entera, en dólares, con el precio de
    // Haiku 4.5. Si esta cifra sube, es que alguien movió el tope o el tamaño
    // del cuadro, y las dos cosas hay que discutirlas.
    expect(spentUsd(state)).toBeLessThan(0.12);
  });

  it('agotado deja de mirar aunque la pantalla cambie', () => {
    let state = newWatchState();
    for (let i = 0; i < 3; i++) state = recordLook(state, i * 20_000, 1280, 720);

    const step = stepWatch(state, { change: 0.9, now: 999_000, busy: false, maxLooks: 3 });
    expect(step.look).toBe(false);
    expect(step.exhausted).toBe(true);
  });

  it('el peor caso por hora está acotado por el tope y no por el reloj', () => {
    // El enfriamiento permite seis miradas por minuto, o sea 360 por hora. El
    // tope corta en 60 — así que una hora encendido no puede costar más que una
    // sesión, y una sesión tiene techo.
    const perHourWithoutCap = (60 * 60 * 1000) / WATCH_COOLDOWN_MS;
    expect(perHourWithoutCap).toBeGreaterThan(WATCH_MAX_LOOKS);

    let capped = newWatchState();
    for (let i = 0; i < WATCH_MAX_LOOKS; i++) capped = recordLook(capped, i * 10_000, 1280, 720);
    expect(capped.looks).toBe(WATCH_MAX_LOOKS);
    expect(spentUsd(capped)).toBeLessThan(0.12);
  });

  it('el contador dice cuántas van, cuántas quedan y cuánto costó', () => {
    // Es lo que se dibuja en la franja. Un tope sin contador visible es una
    // sorpresa aplazada.
    expect(spendSummary(newWatchState())).toContain('Todavía no he mirado nada');
    const one = recordLook(newWatchState(), 1_000, 1280, 720);
    expect(spendSummary(one)).toContain('una vez');
    expect(spendSummary(one)).toContain(`de ${WATCH_MAX_LOOKS}`);
    expect(spendSummary(one)).toContain('menos de US$0,01');
  });

  it('el gasto se escribe sin exagerar la precisión', () => {
    expect(formatUsd(0.004)).toBe('menos de US$0,01');
    expect(formatUsd(0.1)).toBe('US$0,10');
    expect(formatUsd(1.5)).toBe('US$1,50');
  });

  it('una mirada cuesta lo que dice la fórmula publicada, ni más ni menos', () => {
    const one = recordLook(newWatchState(), 0, 1280, 720);
    // 1 229 tokens de imagen (1280 × 720 / 750) más la instrucción.
    expect(one.tokensIn).toBe(1229 + 400);
  });
});

describe('parseWatchVerdict — «no hay nada que decir» no produce mensaje', () => {
  it('NADA no produce nada', () => {
    // El caso normal. La inmensa mayoría de las miradas terminan aquí, y aquí
    // no se dibuja ningún mensaje en el chat.
    expect(parseWatchVerdict('NADA')).toBeNull();
    expect(parseWatchVerdict('  nada  ')).toBeNull();
    expect(parseWatchVerdict('NADA relevante en pantalla')).toBeNull();
  });

  it('una respuesta vacía o ausente no produce nada', () => {
    // Un timeout, una llamada que falló, un modelo que no contestó. Todos se ven
    // igual desde aquí: silencio.
    expect(parseWatchVerdict('')).toBeNull();
    expect(parseWatchVerdict(null)).toBeNull();
    expect(parseWatchVerdict(undefined)).toBeNull();
    expect(parseWatchVerdict('\n\n   \n')).toBeNull();
  });

  it('cualquier desvío del formato se convierte en silencio', () => {
    // La guarda que importa: el modelo se puso conversador, o devolvió JSON, o
    // se inventó un formato. Nada de eso llega al chat.
    expect(parseWatchVerdict('Veo un formulario del RUT bien diligenciado.')).toBeNull();
    expect(parseWatchVerdict('{"aviso": "el RUT está vencido"}')).toBeNull();
    expect(parseWatchVerdict('No hay nada que valga la pena comentar.')).toBeNull();
    expect(parseWatchVerdict('- AVISO: el RUT está vencido')).toBeNull();
  });

  it('un aviso bien formado sí sale, limpio', () => {
    expect(parseWatchVerdict('AVISO: ese mensaje significa que el RUT está vencido.')).toBe(
      'ese mensaje significa que el RUT está vencido.',
    );
    expect(parseWatchVerdict('aviso: el campo NIT quedó con un dígito de más')).toBe(
      'el campo NIT quedó con un dígito de más',
    );
  });

  it('quita las comillas que el modelo pone a veces', () => {
    expect(parseWatchVerdict('AVISO: «el RUT aparece vencido desde marzo»')).toBe(
      'el RUT aparece vencido desde marzo',
    );
  });

  it('se queda con la primera línea y descarta la explicación de más', () => {
    const raw = 'AVISO: el RUT aparece vencido\nLo digo porque la fecha dice 2024.';
    expect(parseWatchVerdict(raw)).toBe('el RUT aparece vencido');
  });

  it('un aviso demasiado corto o sin letras no es un aviso', () => {
    expect(parseWatchVerdict('AVISO: ok')).toBeNull();
    expect(parseWatchVerdict('AVISO: --- --- ---')).toBeNull();
  });

  it('recorta un aviso que se volvió párrafo', () => {
    const long = `AVISO: ${'a'.repeat(400)}`;
    expect(parseWatchVerdict(long)?.length).toBe(240);
  });
});

describe('isRepeatNotice — no decir dos veces lo mismo', () => {
  it('el mismo aviso escrito con otras palabras no se repite', () => {
    // El caso que arruina la función: un banner de error que se queda en
    // pantalla. La persona hace scroll, la imagen cambia, se mira otra vez.
    const said = ['El RUT aparece vencido desde el 3 de marzo'];
    expect(isRepeatNotice('Este documento, el RUT, figura vencido desde marzo', said)).toBe(true);
  });

  it('un aviso nuevo sí pasa', () => {
    const said = ['El RUT aparece vencido desde el 3 de marzo'];
    expect(isRepeatNotice('El campo de placa quedó con una letra de más', said)).toBe(false);
  });

  it('sin avisos previos nunca es repetición', () => {
    expect(isRepeatNotice('El RUT aparece vencido', [])).toBe(false);
  });
});
