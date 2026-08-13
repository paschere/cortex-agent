import { glanceTokens } from './screen-glance';

/**
 * VIGILAR UNA PESTAÑA: cuándo vale la pena mirar, cuánto se lleva gastado y
 * cuándo hay algo que decir.
 *
 * ===========================================================================
 * QUÉ ES ESTO Y POR QUÉ NO ES «MIRAR CADA DOS SEGUNDOS»
 * ===========================================================================
 * La otra mitad de la pantalla compartida — la de ScreenView.tsx — mira UN
 * cuadro cada vez que alguien escribe una pregunta. Esta mira sin que nadie
 * pregunte, para poder decir «ese mensaje significa que el RUT está vencido»
 * antes de que la persona tenga que ir a preguntarlo.
 *
 * Eso suena a un temporizador y NO puede serlo. Un fotograma cuesta
 * `ancho × alto / 750` tokens de entrada (ver `glanceTokens` en
 * lib/screen-glance.ts): 1 229 en una pestaña de portátil. Mirar cada dos
 * segundos son 1 800 miradas por hora, 2,2 millones de tokens, del orden de
 * US$2,2 por hora y por persona en el modelo barato — y eso por fotogramas en
 * los que no pasó nada, porque una persona llenando un formulario deja la
 * pantalla quieta la mayor parte del tiempo.
 *
 * Así que la decisión de mirar se toma AQUÍ, en el navegador, comparando el
 * cuadro nuevo con el anterior. Es aritmética sobre un thumbnail de 48×27 y no
 * cuesta un peso. El modelo sólo se entera de los cuadros que sobrevivieron a
 * esta función.
 *
 * ===========================================================================
 * TRES FILTROS, EN ESTE ORDEN, Y CADA UNO QUITA UN COSTO DISTINTO
 * ===========================================================================
 *   1. CAMBIÓ.     Si la imagen es la misma, no hay nada nuevo que leer. Quita
 *                  el 90 % de los ticks de una sesión normal.
 *   2. SE QUIETÓ.  Una página cargando cambia en diez ticks seguidos y en nueve
 *                  de ellos está a medio pintar. Se mira cuando dejó de
 *                  moverse, así que una navegación entera cuesta UNA mirada y
 *                  además es la única que sirve: la del resultado.
 *   3. NO ACABO DE MIRAR. Un enfriamiento entre miradas, para que alguien
 *                  desplazándose por una tabla larga no compre una foto por
 *                  cada rueda del mouse.
 *
 * Y encima de los tres, el tope duro: `WATCH_MAX_LOOKS` miradas por sesión y se
 * apaga solo. Nadie debería enterarse de esto en la factura.
 *
 * ===========================================================================
 * TODO AQUÍ ES PURO
 * ===========================================================================
 * Ni canvas, ni fetch, ni React. El navegador entrega píxeles y un reloj; esta
 * función decide. Por eso se puede probar entera en Node, sin llamar a
 * Anthropic ni una vez — que es también la única forma de comprobar que «no hay
 * nada que decir» no produce ningún mensaje. Ver screen-watch.test.ts.
 */

// ===========================================================================
// LOS NÚMEROS, CADA UNO CON SU RAZÓN
// ===========================================================================

/**
 * El tamaño al que se compara. No es el tamaño al que se mira.
 *
 * 48×27 son 1 296 píxeles: suficiente para que un banner de error rojo que
 * ocupa un décimo de la pantalla mueva la cifra sin discusión, y lo bastante
 * borroso para que el antialias de una fuente, el cursor parpadeando o la
 * sombra de un menú desplegándose no la muevan. Reducir es el filtro de ruido:
 * a resolución completa, el cursor de texto de un campo enfocado bastaría para
 * comprar un fotograma cada segundo.
 */
export const WATCH_THUMB_W = 48;
export const WATCH_THUMB_H = 27;

/**
 * Cada cuánto se COMPARA (que es gratis), no cada cuánto se mira.
 *
 * Dos segundos: por debajo de eso se gasta CPU del portátil de alguien para
 * detectar cambios que igual van a esperar el enfriamiento, y por encima se
 * empieza a perder el momento — un mensaje de error que aparece y una persona
 * que ya lo cerró.
 */
export const WATCH_SAMPLE_MS = 2_000;

/**
 * Lo mínimo entre dos miradas de verdad.
 *
 * Diez segundos es lo que tarda alguien en leer lo que le apareció y hacer algo
 * al respecto; mirar más seguido que eso es fotografiar la misma situación dos
 * veces. También es lo que fija el techo del gasto por minuto: seis miradas por
 * minuto en el peor caso imaginable, que es una pantalla que no para de cambiar
 * y que además alcanza a quedarse quieta entre cambio y cambio.
 */
export const WATCH_COOLDOWN_MS = 10_000;

/**
 * CUÁNTO TIENE QUE CAMBIAR LA IMAGEN PARA QUE VALGA UNA MIRADA — 0 a 1.
 *
 * 0,02 quiere decir: el brillo promedio del thumbnail se movió un 2 %.
 *
 * DE DÓNDE SALE. El grabador de trámites usa 0,012 sobre un thumbnail de 64×36
 * (ver `CHANGE_THRESHOLD` en lib/tab-recorder.ts) y ahí funciona. Aquí se sube
 * porque el costo de equivocarse es distinto en cada lado: allá un falso
 * positivo es un fotograma de más en una lista que después se recorta, y aquí
 * es una llamada al modelo que se paga. Cuando la duda es entre gastar y no
 * gastar, el umbral se inclina hacia no gastar.
 *
 * QUÉ QUEDA A CADA LADO. Por debajo: el cursor parpadeando, un reloj que avanza
 * un minuto, una fila que se resalta al pasar el mouse, el ruido del reescalado.
 * Por encima: un banner de error, un modal, un campo que se pone rojo, una
 * navegación, un desplazamiento de media pantalla. Que es exactamente la lista
 * de cosas por las que esta función existe.
 *
 * NO ESTÁ MEDIDO CONTRA UNA GRABACIÓN REAL, y se dice aquí en vez de dejarlo
 * creer. Es el número del grabador, subido por el argumento de arriba. Lo que
 * lo confirmaría es contar miradas por hora en una sesión de verdad; mientras
 * tanto el que protege la factura no es este número, es `WATCH_MAX_LOOKS`.
 */
export const WATCH_CHANGE_THRESHOLD = 0.02;

/**
 * EL TOPE DURO. Miradas por sesión, y al llegar aquí se apaga solo.
 *
 * Sesenta miradas a 1 229 tokens de imagen más ~400 de instrucción son unos
 * 98 000 tokens de entrada: **US$0,10 por sesión** a US$1 el millón (Haiku 4.5,
 * ver `WATCH_MODEL`). Ese es el techo, no el promedio, y no depende de cuánto
 * tiempo quede encendido: una hora y ocho horas cuestan lo mismo, porque lo que
 * se agota son las miradas.
 *
 * POR QUÉ 60 Y NO 200. Sesenta es lo que una persona gasta en un rato largo de
 * trabajo real, y es poco menos de lo que gastaría un caso patológico —
 * enfriamiento de 10 s, seis por minuto — en diez minutos seguidos de pantalla
 * cambiando sin parar. O sea: quien lo use normal no lo toca, y quien caiga en
 * el peor caso se entera a los diez minutos con un aviso, no a fin de mes con
 * una factura. Ese es el criterio para elegirlo, no el promedio.
 *
 * POR QUÉ ES POR SESIÓN Y NO POR DÍA. Volver a encenderlo es un acto explícito,
 * con su botón y su franja en pantalla. Un tope diario guardado en algún lado
 * sería un límite que nadie ve venir y que además habría que explicar.
 */
export const WATCH_MAX_LOOKS = 60;

/**
 * Lo que pesa todo lo que NO es la imagen, por mirada. Estimado.
 *
 * La instrucción del sistema, la frase que acompaña al cuadro y los últimos
 * avisos que se le pasan al modelo para que no se repita. Está aquí para que el
 * contador en pantalla no mienta por lo bajo: el 75 % de una mirada es la
 * imagen, pero el 25 % restante existe.
 */
export const WATCH_PROMPT_TOKENS = 400;

/** Lo que devuelve el modelo: «NADA», o una frase. Casi siempre lo primero. */
const WATCH_ANSWER_TOKENS = 40;

/** US$ por millón de tokens en Haiku 4.5. Ver `WATCH_MODEL` en model.ts. */
const USD_PER_MTOK_IN = 1;
const USD_PER_MTOK_OUT = 5;

// ===========================================================================
// ¿CAMBIÓ LA PANTALLA?
// ===========================================================================

/**
 * Cuánto se movió la imagen, de 0 a 1, sin gastar un modelo.
 *
 * Diferencia absoluta media de LUMINANCIA sobre dos thumbnails RGBA del mismo
 * tamaño. Luminancia y no los tres canales por separado porque lo que importa
 * es que aparezca o desaparezca algo, no de qué color: un banner rojo sobre
 * blanco y uno azul sobre blanco son el mismo evento y deben dar cifras
 * parecidas. Los pesos son los de siempre (0,299 / 0,587 / 0,114), en enteros
 * para no pagar coma flotante 1 296 veces cada dos segundos.
 *
 * El canal alfa se ignora: un canvas opaco lo tiene en 255 en todas partes, y
 * dejarlo entrar sólo diluiría la señal con una constante.
 *
 * Dos thumbnails de tamaños distintos devuelven 1 — «cambió todo». Pasa cuando
 * la pestaña compartida cambia de tamaño, y en ese caso efectivamente cambió
 * todo; suponer lo contrario dejaría la vigilancia ciega justo después de que
 * alguien maximizó la ventana.
 */
export function frameChange(previous: ArrayLike<number>, current: ArrayLike<number>): number {
  if (previous.length === 0 || current.length === 0) return 1;
  if (previous.length !== current.length) return 1;

  let sum = 0;
  let pixels = 0;
  for (let i = 0; i + 2 < current.length; i += 4) {
    const lumaBefore =
      299 * (previous[i] ?? 0) + 587 * (previous[i + 1] ?? 0) + 114 * (previous[i + 2] ?? 0);
    const lumaNow =
      299 * (current[i] ?? 0) + 587 * (current[i + 1] ?? 0) + 114 * (current[i + 2] ?? 0);
    sum += Math.abs(lumaNow - lumaBefore);
    pixels++;
  }
  if (pixels === 0) return 1;
  // `sum` viene en milésimas de nivel (los pesos suman 1 000) y cada nivel va de
  // 0 a 255, así que el máximo posible es pixels × 1000 × 255.
  return sum / (pixels * 1000 * 255);
}

// ===========================================================================
// ¿SE MIRA AHORA?
// ===========================================================================

/**
 * Lo que la vigilancia sabe de sí misma. Todo lo que hace falta para decidir y
 * para dibujar el contador; nada más.
 */
export interface WatchState {
  /** Cambió algo desde la última mirada y todavía no se ha ido a mirar. */
  readonly dirty: boolean;
  /** Reloj de la última mirada. 0 mientras no se haya mirado nunca. */
  readonly lastLookAt: number;
  /** Cuántas van. Contra `WATCH_MAX_LOOKS`. */
  readonly looks: number;
  /** Tokens de entrada gastados, imagen + instrucción. Estimados. */
  readonly tokensIn: number;
  /** Tokens de salida, estimados. Es la parte cara por token y la más pequeña. */
  readonly tokensOut: number;
}

export function newWatchState(): WatchState {
  return { dirty: false, lastLookAt: 0, looks: 0, tokensIn: 0, tokensOut: 0 };
}

export interface WatchTick {
  /** Lo que devolvió `frameChange` en este tick. */
  readonly change: number;
  /** El reloj, en milisegundos. */
  readonly now: number;
  /**
   * Hay un turno en curso: la persona ya preguntó algo y le están respondiendo.
   *
   * No se mira mientras tanto, y no es por el dinero. Es que un aviso que
   * aparece encima de una respuesta a medio escribir interrumpe justo lo que la
   * persona estaba leyendo, y lo que la pantalla muestre en ese momento
   * probablemente sea consecuencia de lo que se está respondiendo.
   */
  readonly busy: boolean;
  /** El tope. Parámetro y no constante para poder probar el apagado en tres ticks. */
  readonly maxLooks?: number;
}

export interface WatchStep {
  /** Ir a buscar un fotograma y mandarlo. Falso en la enorme mayoría de ticks. */
  readonly look: boolean;
  /** Se acabó el tope: hay que apagar la vigilancia y decirlo. */
  readonly exhausted: boolean;
  readonly state: WatchState;
}

/**
 * Un tick de vigilancia. La función que decide si se gasta plata.
 *
 * El orden de las guardas es el orden en que importan, y es deliberado:
 *
 *   AGOTADO primero, porque cuando se acabó el tope no hay nada más que pensar
 *   y el que llama tiene que apagar, no seguir preguntando.
 *
 *   OCUPADO antes que sucio, porque los cambios que ocurren durante un turno se
 *   ACUMULAN en `dirty`: cuando la respuesta termine, si la pantalla sigue
 *   distinta a como estaba, se mira una vez. No se pierden, se aplazan.
 *
 *   TODAVÍA SE MUEVE antes que el enfriamiento, porque es el filtro que
 *   convierte una navegación de diez ticks en una sola mirada, y la buena.
 */
export function stepWatch(state: WatchState, tick: WatchTick): WatchStep {
  const moving = tick.change >= WATCH_CHANGE_THRESHOLD;
  const dirty = state.dirty || moving;
  const next: WatchState = dirty === state.dirty ? state : { ...state, dirty };

  const max = tick.maxLooks ?? WATCH_MAX_LOOKS;
  if (state.looks >= max) return { look: false, exhausted: true, state: next };
  if (tick.busy) return { look: false, exhausted: false, state: next };
  if (!next.dirty) return { look: false, exhausted: false, state: next };
  // Sigue cambiando: la página está a medio pintar. El cuadro que sirve es el
  // de cuando pare.
  if (moving) return { look: false, exhausted: false, state: next };
  if (state.lastLookAt > 0 && tick.now - state.lastLookAt < WATCH_COOLDOWN_MS) {
    return { look: false, exhausted: false, state: next };
  }
  return { look: true, exhausted: false, state: next };
}

/**
 * Anotar una mirada que ya se hizo: baja el tope y sube el contador de gasto.
 *
 * Se llama DESPUÉS de tener el fotograma, con sus medidas de verdad, porque el
 * precio de una imagen es función de su tamaño y de nada más — y el tamaño sale
 * de la pantalla de la persona, así que no se puede saber antes.
 *
 * `dirty` vuelve a falso aquí y no en `stepWatch`: mientras la petición esté en
 * vuelo la pantalla puede volver a cambiar, y ese cambio tiene que contar para
 * la siguiente mirada en vez de perderse.
 */
export function recordLook(
  state: WatchState,
  now: number,
  width: number,
  height: number,
): WatchState {
  return {
    dirty: false,
    lastLookAt: now,
    looks: state.looks + 1,
    tokensIn: state.tokensIn + glanceTokens(width, height) + WATCH_PROMPT_TOKENS,
    tokensOut: state.tokensOut + WATCH_ANSWER_TOKENS,
  };
}

/** Lo que se lleva gastado, en dólares. Estimado — ver `glanceTokens`. */
export function spentUsd(state: WatchState): number {
  return (
    (state.tokensIn * USD_PER_MTOK_IN) / 1_000_000 +
    (state.tokensOut * USD_PER_MTOK_OUT) / 1_000_000
  );
}

/**
 * El gasto, escrito para que se lea de un vistazo y sin exagerar la precisión.
 *
 * Por debajo de un centavo dice que es menos de un centavo, en vez de «US$0,004»
 * — tres decimales en una franja de estado son ruido, y la cifra que importa a
 * esa altura no es cuánto va, es que no va casi nada.
 */
export function formatUsd(usd: number): string {
  if (usd < 0.01) return 'menos de US$0,01';
  return `US$${usd.toFixed(2).replace('.', ',')}`;
}

/** La frase del contador, tal cual va en la franja. */
export function spendSummary(state: WatchState, maxLooks: number = WATCH_MAX_LOOKS): string {
  if (state.looks === 0)
    return `Todavía no he mirado nada. Tengo ${maxLooks} miradas para esta sesión.`;
  const looks = state.looks === 1 ? 'una vez' : `${state.looks} veces`;
  return `He mirado ${looks} de ${maxLooks}, y sólo cuando la pantalla cambió. Van ${formatUsd(spentUsd(state))}.`;
}

// ===========================================================================
// ¿HAY ALGO QUE DECIR?
// ===========================================================================

/**
 * LA RESPUESTA NORMAL ES QUE NO, Y ESO NO PRODUCE NADA.
 *
 * Un asistente que comenta todo se apaga el primer día. Así que el modelo
 * contesta en un formato de dos posibilidades y este parser es deliberadamente
 * estricto en una sola dirección: **todo lo que no sea exactamente un aviso
 * bien formado se convierte en silencio**. Una respuesta rara, una explicación
 * de más, un «no veo nada relevante» redactado a mano, un timeout, un JSON a
 * medias — todos terminan en `null`, y `null` no dibuja nada en ninguna parte.
 *
 * Es el sentido de fallo correcto y es el único que se puede sostener: un aviso
 * que falta no lo nota nadie, y un aviso de más le enseña a la persona que esta
 * franja es ruido, lo que mata también a los que sí servían.
 *
 * El formato es texto y no JSON a propósito. Un modelo pequeño acierta más
 * veces con una sola línea que con una llave, y aquí un error de formato no es
 * un error recuperable: es un aviso que no aparece.
 */
export const WATCH_NOTHING = 'NADA';
const WATCH_PREFIX = 'AVISO:';

/** Menos que esto no es una frase, es un resto de formato. */
const MIN_NOTICE_CHARS = 12;
/** Un aviso es una frase, no un párrafo. Lo que no quepa aquí sobra. */
const MAX_NOTICE_CHARS = 240;

export function parseWatchVerdict(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // La primera línea con algo escrito. Un modelo que agregue una explicación
  // debajo pierde la explicación, no el aviso.
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;

  const upper = line.toUpperCase();
  if (upper.startsWith(WATCH_NOTHING)) return null;
  // Sin el prefijo exacto no hay aviso. Es la guarda que convierte cualquier
  // desvío del formato en silencio en vez de en una frase suelta en el chat.
  if (!upper.startsWith(WATCH_PREFIX)) return null;

  const text = line
    .slice(WATCH_PREFIX.length)
    .trim()
    // Comillas alrededor de la frase entera: el modelo las pone a veces y en
    // pantalla se ven como una cita de algo que nadie dijo.
    .replace(/^["'«]+/, '')
    .replace(/["'»]+$/, '')
    .trim();

  if (text.length < MIN_NOTICE_CHARS) return null;
  // Tiene que tener letras. «AVISO: ---» pasaría el largo mínimo y no dice nada.
  if (!/\p{L}/u.test(text)) return null;

  return text.slice(0, MAX_NOTICE_CHARS);
}

/**
 * ¿YA DIJE ESTO?
 *
 * El caso que arruina la función: un banner de error que se queda en pantalla.
 * La persona hace scroll, la imagen cambia, se mira otra vez y el modelo vuelve
 * a ver el mismo banner. Sin esto, un error se avisa cinco veces y la quinta ya
 * nadie lee la franja.
 *
 * La comparación es por PALABRAS DE CONTENIDO y no por texto exacto, porque el
 * modelo no repite la frase igual: «el RUT aparece vencido desde el 3 de marzo»
 * y «este documento, el RUT, figura vencido desde marzo» son el mismo aviso
 * escrito dos veces. Se normaliza (minúsculas, sin tildes, sin puntuación) y se
 * mide el solapamiento de Jaccard: por encima de 0,5 —la mitad del vocabulario
 * compartido— es lo mismo dicho de otro modo.
 *
 * TRES LETRAS ES EL MÍNIMO, y no cuatro, por una palabra concreta: «RUT». Igual
 * que «NIT», «SOAT» o una placa, las siglas son justo lo que identifica de qué
 * habla un aviso, y descartarlas por cortas hacía que dos avisos sobre el mismo
 * documento no se reconocieran entre sí. El precio es que entran también «con»,
 * «una» y «los», que inflan el parecido de dos frases cualesquiera; se paga con
 * gusto, porque este filtro está inclinado hacia callar a propósito. Dos avisos
 * distintos que colisionan pierden el segundo, y eso es mucho mejor que el mismo
 * error anunciado cinco veces hasta que nadie vuelve a leer la franja.
 */
const REPEAT_OVERLAP = 0.5;

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      // NFD separa la tilde de su letra; `\p{M}` es la clase de las marcas
      // combinantes, as\u00ed que \u00abvenc\u00eddo\u00bb y \u00abvencido\u00bb quedan iguales. Se escribe
      // como propiedad Unicode y no como rango de puntos de c\u00f3digo para no
      // partir un car\u00e1cter en dos dentro de una clase.
      .replace(/\p{M}/gu, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

export function isRepeatNotice(text: string, recent: readonly string[]): boolean {
  const now = contentTokens(text);
  if (now.size === 0) return recent.length > 0;

  for (const previous of recent) {
    const before = contentTokens(previous);
    if (before.size === 0) continue;
    let shared = 0;
    for (const word of now) if (before.has(word)) shared++;
    const union = now.size + before.size - shared;
    if (union > 0 && shared / union >= REPEAT_OVERLAP) return true;
  }
  return false;
}

/** Cuántos avisos anteriores se recuerdan, para no repetirse. */
export const WATCH_RECENT_NOTICES = 4;
