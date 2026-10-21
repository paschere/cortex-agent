/**
 * LO QUE CUESTA UN TOKEN, EN DÓLARES, SEGÚN QUIÉN LO COBRÓ.
 *
 * La pregunta del dueño era «¿en qué se van los créditos de Anthropic?», y la
 * página de uso sabía contar tokens pero no ponerles precio — que es como un
 * extracto bancario en una moneda que nadie conoce. Este módulo es la tabla de
 * cambio, y vive solo (sin imports, funciones puras) para que la página lo use
 * en el servidor y un test lo verifique en Node sin arrastrar nada.
 *
 * LOS PRECIOS SON LOS DE LISTA DE ANTHROPIC (api first-party), verificados el
 * 2026-08-15 contra la documentación oficial. La factura real puede diferir por
 * descuentos negociados; esto es una ESTIMACIÓN y la página lo dice.
 *
 * LA VENTANA INTRO DE SONNET 5: hasta el 2026-08-31 inclusive, la entrada vale
 * $2/MTok y la salida $10/MTok; desde el 1 de septiembre, $3/$15. Por eso la
 * tarifa se elige por LA FECHA DEL CONSUMO, no por la fecha de hoy: una ventana
 * de 30 días mirada en septiembre contiene días de agosto que se cobraron al
 * precio de agosto.
 *
 * EL CACHÉ NO ES DECORACIÓN, ES EL DESCUENTO MÁS GRANDE QUE EXISTE: leer un
 * token del caché cuesta 0.1× la entrada, y escribirlo 1.25× (TTL de 5 min,
 * que es el que usa el SDK por defecto). Un chat con buen caché paga ~10% de
 * lo que aparenta; uno con el caché roto paga 125%. Por eso `stepCostUsd`
 * recibe las tres cifras por separado en vez de un total que las mezcle.
 */

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** USD por millón de tokens. */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * Lectura de caché como fracción de la entrada, si no es la de siempre (0,1×).
   * Opus 5.5 lee a $0,20 sobre una entrada de $4: 0,05×.
   */
  cacheReadMultiplier?: number;
  /**
   * Segunda tarifa para prompts largos (Haiku 5.5: más de 100K tokens de
   * prompt, que es entrada + lectura + escritura de ESA petición). La tarifa la
   * elige el tamaño del prompt de cada petición, no el del turno.
   */
  longPrompt?: { aboveTokens: number; inputPerMTok: number; outputPerMTok: number };
}

/**
 * La generación 5.5 (2026-10): ids exactos, sin sufijo de fecha. Sus tarifas son
 * planas en el tiempo — no tienen ventana de lanzamiento — y por eso se miran
 * ANTES que el prefijo «claude-sonnet-5» / «claude-opus», que también las
 * contendría.
 */
const SONNET_5_5: ModelRate = { inputPerMTok: 2, outputPerMTok: 10 };
const OPUS_5_5: ModelRate = { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 };
const HAIKU_5_5: ModelRate = {
  inputPerMTok: 0.1,
  outputPerMTok: 0.5,
  longPrompt: { aboveTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
};

const SONNET_5_INTRO_UNTIL = '2026-08-31';

/**
 * Tarifa vigente para un modelo EN UNA FECHA dada (ISO, solo se mira el día).
 * Modelos que este workspace no usa devuelven null y el que llama decide si
 * los suma sin precio o los ignora — inventar una tarifa sería peor que no
 * tenerla.
 */
export function rateFor(model: string, isoDate: string): ModelRate | null {
  const day = isoDate.slice(0, 10);
  // El id puede venir cualificado («anthropic/claude-sonnet-5») o pelado.
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  // Los históricos NO se borran: las filas viejas de `model_usage` se cobran a la
  // tarifa con la que corrieron (Sonnet 5 con su ventana intro, Opus 5 a $5/$25,
  // Haiku 4.5 a $1/$5).
  if (bare.startsWith('claude-sonnet-5-5')) return SONNET_5_5;
  if (bare.startsWith('claude-opus-5-5')) return OPUS_5_5;
  if (bare.startsWith('claude-haiku-5-5')) return HAIKU_5_5;
  if (bare.startsWith('claude-sonnet-5')) {
    return day <= SONNET_5_INTRO_UNTIL
      ? { inputPerMTok: 2, outputPerMTok: 10 }
      : { inputPerMTok: 3, outputPerMTok: 15 };
  }
  if (bare.startsWith('claude-sonnet-4')) return { inputPerMTok: 3, outputPerMTok: 15 };
  if (bare.startsWith('claude-haiku-4-5')) return { inputPerMTok: 1, outputPerMTok: 5 };
  if (bare.startsWith('claude-opus')) return { inputPerMTok: 5, outputPerMTok: 25 };
  return null;
}

/**
 * Costo en USD de UNA petición al modelo, con el caché descontado como lo
 * descuenta Anthropic: la entrada sin caché a precio pleno, lo leído del caché
 * a 0.1×, lo escrito al caché a 1.25×, y la salida a su propio precio.
 */
export function stepCostUsd(
  rate: ModelRate,
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number },
  /**
   * Tamaño del prompt de UNA petición, si se conoce. Para el tramo largo de
   * Haiku 5.5 el costo se parte por petición; con filas agregadas por turno se
   * usa el promedio por paso (`steps`) para no cobrar todo el turno como largo
   * por haber sumado varios pasos cortos.
   */
  steps = 1,
): number {
  const perStep = Math.max(1, steps);
  const promptPerStep =
    (Math.max(0, tokens.input) + Math.max(0, tokens.cacheRead) + Math.max(0, tokens.cacheWrite)) /
    perStep;
  const tier =
    rate.longPrompt && promptPerStep > rate.longPrompt.aboveTokens ? rate.longPrompt : rate;
  const inRate = tier.inputPerMTok / 1_000_000;
  const readMultiplier = rate.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
  return (
    Math.max(0, tokens.input) * inRate +
    Math.max(0, tokens.cacheRead) * inRate * readMultiplier +
    Math.max(0, tokens.cacheWrite) * inRate * CACHE_WRITE_MULTIPLIER +
    (Math.max(0, tokens.output) * tier.outputPerMTok) / 1_000_000
  );
}

/**
 * Lo que se AHORRÓ por leer del caché en vez de pagar entrada plena. Es el
 * número que convierte «93% de aciertos» en pesos: la diferencia entre 1× y
 * 0.1× sobre cada token leído.
 */
export function cacheSavingsUsd(rate: ModelRate, cacheReadTokens: number): number {
  const readMultiplier = rate.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
  return (Math.max(0, cacheReadTokens) * rate.inputPerMTok * (1 - readMultiplier)) / 1_000_000;
}

/** «$4.83» o «$0.0042» — con los decimales que el tamaño del número pida. */
export function formatUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('es-CO')}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd === 0) return '$0';
  return `$${usd.toFixed(4)}`;
}
