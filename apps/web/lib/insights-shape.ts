import type { ChartBody } from '@cortex/agent-tools';

/**
 * LOS HALLAZGOS: QUÉ SE PUEDE DECIR, Y SOBRE TODO QUÉ NO.
 *
 * Un hallazgo es una frase que Cortex trae sin que nadie la pida: «esto se
 * movió, y esto es lo que hay detrás». Es lo contrario de una cifra en un
 * tablero — una cifra la buscas tú, un hallazgo te busca a ti.
 *
 * ===========================================================================
 * LA REGLA QUE MANDA: SI NO SE PUEDE SUSTENTAR, NO SE DIBUJA
 * ===========================================================================
 * Este archivo es casi todo negativas. Devuelve `null` mucho más de lo que
 * devuelve un hallazgo, y esa es la funcionalidad, no una carencia:
 *
 *   · una meta con una sola lectura congelada no tiene contra qué compararse
 *   · una lectura sobre dos filas no es una tendencia, es una anécdota
 *   · un mes con cero facturas no bajó un 100%: es que nadie subió nada
 *   · un cliente que es el 45% de dos clientes no es concentración, es dividir
 *
 * Todos esos casos producen un número perfectamente calculable y perfectamente
 * mentiroso. Por eso viven aquí, con umbrales con nombre y una prueba cada uno,
 * en vez de dentro del componente que los pinta: un hallazgo falso no se ve
 * distinto de uno verdadero, y el único sitio donde se puede notar la
 * diferencia es un test.
 *
 * Cero hallazgos es un resultado legítimo y frecuente — es lo que devuelve un
 * espacio recién abierto, y lo que la pantalla dice con todas las letras en vez
 * de rellenar con ejemplos.
 *
 * ===========================================================================
 * POR QUÉ SÓLO HAY TRES FAMILIAS
 * ===========================================================================
 * Porque en todo el producto sólo hay DOS fuentes con histórico de verdad:
 *
 *   `goal_readings`  — una fila congelada por período cerrado, con el objetivo
 *                      y el veredicto de ESE momento. Sin backfill: una meta
 *                      empieza a tener historia el primer período que cierra
 *                      después de fijarla (ver `inngest/functions/goals-watch.ts`).
 *   `document_extractions.issued_on` — vía `aggregateRecords`, la única serie
 *                      de dinero real, y el único reparto por cliente con id.
 *
 * Todo lo demás —cartera, vencimientos, la ficha de la empresa, el índice de lo
 * que te espera— es una foto de hoy. Se puede describir, pero no se le puede
 * poner un «−6% frente al mes pasado» encima sin inventárselo. En cartera es
 * literalmente imposible: `receivables` no corta los pagos por fecha, así que
 * «la cartera del 30 de junio» saldría descontando pagos de julio.
 *
 * ===========================================================================
 * NADA DE ESTE ARCHIVO TOCA LA BASE
 * ===========================================================================
 * Igual que `waiting-shape.ts` y `journal-shape.ts`: entra dato plano, sale
 * frase. Del paquete sólo viaja un TIPO (`ChartBody`), que se borra al
 * compilar — importar un VALOR de `@cortex/agent-tools` arrastraría `node:dns`
 * al bundle del navegador.
 *
 * Y el gráfico sale de aquí como DATOS, nunca como markup. Quien lo dibuja es
 * `renderChart`, el mismo renderizador del informe guardado y del chat; que
 * este archivo devuelva un `ChartBody` es lo que permite que la prueba compare
 * cifras en vez de cadenas de SVG.
 */

// ---------------------------------------------------------------------------
// Los umbrales, con nombre y con motivo
// ---------------------------------------------------------------------------

/** Sin dos períodos cerrados no hay «frente a», y sin «frente a» no hay hallazgo. */
export const MIN_READINGS = 2;

/**
 * Sobre cuántas filas tiene que estar hecha una lectura para poder citarse.
 *
 * `sample_size` viene congelado en la fila. Un «100% de compromisos en fecha»
 * calculado sobre dos compromisos es verdad y no significa nada: el mes que
 * viene uno solo lo tumba a la mitad. Tres es el mínimo en que un movimiento
 * puede no ser una sola fila cambiando de sitio.
 */
export const MIN_SAMPLE = 3;

/**
 * Cuánto tiene que moverse una meta CUMPLIDA para ser noticia.
 *
 * Una décima arriba o abajo es el redondeo, y anunciarlo enseña a ignorar los
 * hallazgos. Una meta INCUMPLIDA no pasa por aquí: salirse de lo fijado es el
 * hallazgo, se haya movido lo que se haya movido.
 */
export const MIN_MOVE = 1;

/** Cuánto tiene que moverse la facturación, en porcentaje, para contarse. */
export const MIN_BILLING_MOVE_PCT = 5;

/**
 * A partir de qué porcentaje un cliente es una concentración y no una cartera.
 *
 * Cuarenta es donde perder a uno deja de ser un mal trimestre y pasa a ser un
 * problema de caja.
 */
export const CONCENTRATION_PCT = 40;

/**
 * Cuántos clientes hacen falta para que «concentración» quiera decir algo.
 *
 * Con dos clientes alguien es el 50% por aritmética, no por concentración. Con
 * tres, que uno se lleve el 40% ya es una forma que alguien eligió.
 */
export const MIN_CLIENTS = 3;

/** Cuántos hallazgos caben en el carrusel. Más que esto ya no se pasa. */
export const MAX_INSIGHTS = 5;

/** Cuántos segmentos se dibujan antes de agrupar el resto en «Otros». */
export const MAX_SLICES = 5;

// ---------------------------------------------------------------------------
// La frase, en piezas
// ---------------------------------------------------------------------------

/**
 * Una frase de hallazgo no es una cadena.
 *
 * Lleva cifras, que van en monoespaciada y con color porque son lo que alguien
 * va a citar (regla 3 del sistema de diseño), y lleva entidades, que llevan a
 * la pantalla donde vive esa entidad. Devolver una cadena obligaría a quien la
 * pinta a buscar los trozos con una expresión regular sobre texto en español,
 * que es exactamente donde se rompe el día que un cliente se llame «45%».
 */
export type Piece =
  | { t: 'text'; v: string }
  | { t: 'figure'; v: string; tone: FigureTone }
  | { t: 'entity'; v: string; href: string | null };

/**
 * El color de una cifra dice si la noticia es buena o mala, nunca de qué signo
 * es el número. Bajar 6 días de cartera es verde aunque el número sea negativo.
 */
export type FigureTone = 'emerald' | 'rose' | 'neutral';

export type InsightKind = 'goal' | 'billing' | 'concentration';

export interface Insight {
  /** Estable entre cargas: es la clave de React y el ancla del carrusel. */
  id: string;
  kind: InsightKind;
  /** La frase. Primero, porque el hallazgo es la frase y no el gráfico. */
  sentence: Piece[];
  /** Qué dibujar debajo. Datos; el markup lo hace `renderChart`. */
  chart: ChartBody;
  /** La lectura para quien no ve el gráfico. Obligatoria: `renderChart` la pide. */
  altText: string;
  /** La pregunta siguiente, escrita como la haría una persona. */
  question: string;
  /**
   * De dónde sale la cifra. Nunca opcional: un hallazgo sin procedencia no se
   * construye, porque un sello vacío devalúa todos los de verdad.
   */
  provenance: { source: string; readAt: string; detail: string };
  /** Cuánto pide una decisión. Ordena el carrusel; no se enseña. */
  weight: number;
}

// ---------------------------------------------------------------------------
// Lo que hay que traerle. Dato plano, ya formateado donde el formato depende
// de la moneda o del locale — este archivo no sabe de pesos.
// ---------------------------------------------------------------------------

export type ReadingStatusFact = 'met' | 'breached' | 'unmeasurable';
export type MetricUnitFact = 'percent' | 'days' | 'count';
export type MetricDirectionFact = 'higher_is_better' | 'lower_is_better';

/** Una fila de `goal_readings`, tal cual se congeló. */
export interface GoalReadingFact {
  periodLabel: string;
  /** `YYYY-MM-DD`. Ordena, y sólo ordena. */
  periodStart: string;
  value: number | null;
  /** Formateado al congelar, no al leer. Se cita tal cual. */
  display: string;
  status: ReadingStatusFact;
  sampleSize: number;
}

export interface GoalFact {
  id: string;
  label: string;
  unit: MetricUnitFact;
  direction: MetricDirectionFact;
  /** «al menos 95%», «no pasar de 45 d». Ya redactado por `describeTarget`. */
  targetPhrase: string;
  /** Más reciente primero, como las devuelve `listReadings`. */
  readings: GoalReadingFact[];
  source: { system: string; readAt: string; method: string };
}

export interface MonthFact {
  /** `YYYY-MM`. */
  month: string;
  /** «julio», «diciembre de 2025». */
  label: string;
  total: number;
  /** Ya en pesos: «$84.500.000». La moneda la pone quien lee. */
  display: string;
}

export interface BillingFact {
  /** Cronológico y SÓLO meses cerrados. El mes en curso no compara. */
  months: MonthFact[];
  /** Documentos que el filtro alcanzó pero nadie ha revisado. Parte de la respuesta. */
  pendingExcluded: number;
  /**
   * El barrido tocó su techo de mil filas.
   *
   * `queryRecords` ordena por `issued_on` DESCENDENTE antes de cortar, así que
   * lo que se pierde son los meses MÁS ANTIGUOS del período — justo la mitad
   * contra la que se compara. La serie saldría con una caída perfectamente
   * dibujada que en realidad es el corte. Ver `SCAN_CAP` en `lib/insights.ts`.
   */
  truncated: boolean;
  source: { system: string; readAt: string; method: string };
}

export interface ClientShareFact {
  key: string;
  label: string;
  total: number;
  display: string;
  /** Sólo cuando `key` es un cliente registrado de verdad. Si no, no se enlaza. */
  href: string | null;
}

export interface ConcentrationFact {
  /** «los últimos 12 meses». */
  windowLabel: string;
  /** Ordenados de mayor a menor. */
  clients: ClientShareFact[];
  totalDisplay: string;
  pendingExcluded: number;
  /** Igual que en la facturación: con el barrido cortado, el reparto es de otro conjunto. */
  truncated: boolean;
  source: { system: string; readAt: string; method: string };
}

export interface InsightFacts {
  goals: GoalFact[];
  billing: BillingFact | null;
  concentration: ConcentrationFact | null;
}

// ---------------------------------------------------------------------------
// 1. Una meta que cerró un período
// ---------------------------------------------------------------------------

/**
 * El hallazgo mejor sustentado que este producto sabe dar.
 *
 * Las dos lecturas son filas congeladas: llevan su propio objetivo, su propio
 * veredicto y la aritmética con que se hicieron. Nada de esto se recalcula
 * aquí, y por eso subir la meta mañana no reescribe el hallazgo de julio.
 *
 * EL VEREDICTO NO SE VUELVE A JUZGAR. `status` ya viene decidido por `judge`
 * cuando la lectura se escribió; este archivo sólo lo lee. Volver a comparar
 * `value` contra el objetivo de hoy sería la segunda opinión que la 0101 existe
 * para no tener.
 */
export function goalInsight(goal: GoalFact): Insight | null {
  // SE ORDENA AQUÍ AUNQUE YA VENGA ORDENADO. `listReadings` devuelve
  // `period_start` descendente, pero de esa promesa depende el SIGNO de la
  // frase: con las dos lecturas al revés, «−6 pp» sale «+6 pp» y no hay nada
  // en pantalla que se vea mal. Una comparación por fecha cuesta nada y
  // convierte un error silencioso en un imposible.
  const readings = [...goal.readings].sort((a, b) => b.periodStart.localeCompare(a.periodStart));

  // LA CONSTANTE ES LA QUE MANDA, Y NO LO ERA.
  //
  // `MIN_READINGS` estaba exportada y documentada como la regla —«sin dos
  // períodos cerrados no hay “frente a”»— pero lo que de verdad la aplicaba era
  // el destructuring de abajo, que casualmente pide dos. Subirla a tres no
  // habría cambiado absolutamente nada: una constante que describe una regla sin
  // ser lo que la impone es peor que no tenerla, porque el siguiente que la
  // toque creerá que cambió algo.
  if (readings.length < MIN_READINGS) return null;

  const [latest, previous] = readings;
  // Y ESTA LÍNEA NO SOBRA aunque lo parezca: `noUncheckedIndexedAccess` hace que
  // las dos posiciones lleguen como `T | undefined`, y es lo que las estrecha.
  // Borrarla «porque ya lo comprueba la de arriba» rompe el typecheck.
  if (!latest || !previous) return null;

  // `unmeasurable` es un hueco, no un incumplimiento. Un período que no se pudo
  // medir no puede ser ninguno de los dos extremos de una comparación.
  if (latest.status === 'unmeasurable' || previous.status === 'unmeasurable') return null;
  if (latest.value == null || previous.value == null) return null;

  // Sobre dos filas no se habla. Se mira el período que se está contando: el
  // anterior puede haber sido flaco sin que eso invalide la noticia de hoy.
  if (latest.sampleSize < MIN_SAMPLE) return null;

  const delta = latest.value - previous.value;
  const moved = Math.abs(delta) >= MIN_MOVE;
  const breached = latest.status === 'breached';

  // Cumplida y quieta no es noticia. Incumplida sí lo es aunque no se moviera:
  // seguir fuera de la meta un mes más es exactamente lo que hay que decir.
  if (!breached && !moved) return null;

  const improved = goal.direction === 'higher_is_better' ? delta > 0 : delta < 0;
  const deltaTone: FigureTone = delta === 0 ? 'neutral' : improved ? 'emerald' : 'rose';

  const sentence: Piece[] = [
    { t: 'entity', v: goal.label, href: '/goals' },
    { t: 'text', v: ` cerró ${latest.periodLabel} en ` },
    { t: 'figure', v: latest.display, tone: breached ? 'rose' : 'emerald' },
    { t: 'text', v: ' — ' },
    { t: 'figure', v: deltaText(delta, goal.unit), tone: deltaTone },
    { t: 'text', v: ` frente a ${previous.periodLabel}, ` },
    {
      t: 'text',
      v: breached ? 'y la meta era ' : 'y sigue cumpliendo: la meta es ',
    },
    { t: 'figure', v: goal.targetPhrase, tone: 'neutral' },
    { t: 'text', v: '.' },
  ];

  // Cronológico para el gráfico — las lecturas vienen al revés — y con tope,
  // porque ocho barras es lo que se lee de un vistazo en una tarjeta.
  const series = readings
    .filter((r) => r.value != null)
    .slice(0, 8)
    .reverse();

  return {
    id: `goal:${goal.id}`,
    kind: 'goal',
    sentence,
    chart: {
      type: 'bars',
      bars: series.map((r) => ({
        label: r.periodLabel,
        value: r.value ?? 0,
        display: r.display,
        // EL COLOR SALE DEL VEREDICTO CONGELADO, no de compararlo ahora. Es lo
        // que convierte la barra en el umbral: cada período está pintado con
        // el juicio que se emitió cuando ese período cerró.
        tone: r.status === 'breached' ? 'rose' : r.status === 'met' ? 'emerald' : 'ink',
      })),
    },
    altText: `${goal.label}, período a período. ${latest.periodLabel} cerró en ${latest.display}; la meta es ${goal.targetPhrase}.`,
    question: breached
      ? `¿por qué ${goal.label.toLowerCase()} se salió de la meta en ${latest.periodLabel}?`
      : improved
        ? `¿qué hicimos distinto en ${latest.periodLabel}?`
        : '¿esto va a seguir cayendo?',
    provenance: {
      source: goal.source.system,
      readAt: goal.source.readAt,
      detail: goal.source.method,
    },
    // Incumplida manda siempre. Entre dos incumplidas, la que más se movió.
    weight: (breached ? 100 : 40) + Math.min(Math.abs(delta), 9) / 10,
  };
}

/**
 * «−6 pp», «+3 d», «−4».
 *
 * Puntos porcentuales y no por ciento: pasar del 92% al 86% es una caída de
 * seis PUNTOS, no del seis por ciento. Decirlo mal es el error que hace que dos
 * personas discutan de dos números distintos con la misma palabra.
 */
export function deltaText(delta: number, unit: MetricUnitFact): string {
  if (delta === 0) return 'sin cambio';
  const rounded = Math.round(Math.abs(delta) * 10) / 10;
  const body = rounded.toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  const sign = delta > 0 ? '+' : '−';
  const suffix = unit === 'percent' ? ' pp' : unit === 'days' ? ' d' : '';
  return `${sign}${body}${suffix}`;
}

// ---------------------------------------------------------------------------
// 2. La facturación, mes cerrado contra mes cerrado
// ---------------------------------------------------------------------------

/**
 * Lo único que este producto sabe de dinero a lo largo del tiempo.
 *
 * DOS TRAMPAS, LAS DOS CERRADAS AQUÍ:
 *
 *   EL MES EN CURSO NO COMPARA. El 14 de agosto lleva catorce días de facturas
 *   y julio tiene treinta y uno; ponerlos uno al lado del otro dibuja una caída
 *   del 55% que no existe. Quien llama a esta función entrega SÓLO meses
 *   cerrados, y por eso el tipo lo dice en el comentario del campo.
 *
 *   UN MES EN CERO NO ES UNA CAÍDA. Si nadie subió facturas de julio, julio
 *   vale cero, y la aritmética da −100%. Eso no es que la empresa dejara de
 *   facturar: es que la empresa dejó de anotarlo. Los dos meses tienen que
 *   tener algo para que la división signifique algo.
 */
export function billingInsight(billing: BillingFact | null): Insight | null {
  if (!billing) return null;
  // Con el barrido cortado no se sabe qué mes está completo y cuál no, y la
  // caída que se dibujaría sería la del corte. Antes que un número precioso y
  // falso, ningún número.
  if (billing.truncated) return null;
  const months = billing.months;
  if (months.length < 2) return null;

  const latest = months[months.length - 1];
  const previous = months[months.length - 2];
  if (!latest || !previous) return null;
  if (latest.total <= 0 || previous.total <= 0) return null;

  const pct = ((latest.total - previous.total) / previous.total) * 100;
  if (Math.abs(pct) < MIN_BILLING_MOVE_PCT) return null;

  const down = pct < 0;
  const sentence: Piece[] = [
    { t: 'text', v: 'Facturaste ' },
    { t: 'figure', v: latest.display, tone: down ? 'rose' : 'emerald' },
    { t: 'text', v: ` en ${latest.label} — ` },
    { t: 'figure', v: pctText(pct), tone: down ? 'rose' : 'emerald' },
    { t: 'text', v: ` frente a ${previous.label}.` },
  ];

  // LA CONFESIÓN VA EN LA FRASE, no en una nota al pie. Un total presentado sin
  // decir cuánto se quedó fuera enseña a tratar un total incompleto como
  // completo — es la doctrina de `aggregateRecords`, y aquí se respeta.
  if (billing.pendingExcluded > 0) {
    sentence.push({
      t: 'text',
      v: ' Sin contar ',
    });
    sentence.push({
      t: 'figure',
      v: String(billing.pendingExcluded),
      tone: 'neutral',
    });
    sentence.push({
      t: 'text',
      v: billing.pendingExcluded === 1 ? ' documento sin revisar.' : ' documentos sin revisar.',
    });
  }

  return {
    id: `billing:${latest.month}`,
    kind: 'billing',
    sentence,
    chart: {
      type: 'timeseries',
      points: months.map((m) => ({ label: m.label, value: m.total })),
      valueUnit: null,
      tone: down ? 'rose' : 'primary',
    },
    altText: `Facturación por mes cerrado. ${latest.label} cerró en ${latest.display}, ${pctText(pct)} frente a ${previous.label}.`,
    question: down
      ? `¿por qué bajó la facturación en ${latest.label}?`
      : `¿de dónde salió el crecimiento de ${latest.label}?`,
    provenance: {
      source: billing.source.system,
      readAt: billing.source.readAt,
      detail: billing.source.method,
    },
    weight: down ? 80 : 20,
  };
}

/** «−12,4%», «+7%». Por ciento de verdad: es una división, no una resta. */
export function pctText(pct: number): string {
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  const body = rounded.toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return `${pct > 0 ? '+' : '−'}${body}%`;
}

// ---------------------------------------------------------------------------
// 3. De quién depende la plata
// ---------------------------------------------------------------------------

/**
 * El único hallazgo del producto que menciona un cliente por su nombre y lleva
 * a su ficha.
 *
 * `aggregateRecords(groupBy: 'client')` agrupa por `clientId` cuando lo hay, y
 * si no cae al NIT o a «desconocido». Por eso `href` es nulable y quien lee
 * comprueba contra la lista real de clientes antes de enlazar: una mención que
 * no lleva a ninguna parte es peor que un nombre en texto plano.
 *
 * AMBAR Y NO ROSA. Depender mucho de un cliente pide una mirada, no es un
 * incumplimiento — y `rose` está reservado a lo vencido, lo bloqueado y lo
 * irreversible. Pintarlo de rojo gastaría el color que hace falta para lo que
 * de verdad se venció.
 */
export function concentrationInsight(fact: ConcentrationFact | null): Insight | null {
  if (!fact) return null;
  // Un porcentaje sobre un subconjunto arbitrario del período no es el reparto
  // de nadie. Mismo motivo que en la facturación.
  if (fact.truncated) return null;
  const clients = fact.clients;
  if (clients.length < MIN_CLIENTS) return null;

  const total = clients.reduce((sum, c) => sum + c.total, 0);
  if (total <= 0) return null;

  const top = clients[0];
  if (!top || top.total <= 0) return null;

  const share = (top.total / total) * 100;
  if (share < CONCENTRATION_PCT) return null;

  const shareText = `${(Math.round(share * 10) / 10).toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;

  const sentence: Piece[] = [
    { t: 'figure', v: shareText, tone: 'neutral' },
    { t: 'text', v: ` de lo que facturaste en ${fact.windowLabel} sale de ` },
    { t: 'entity', v: top.label, href: top.href },
    { t: 'text', v: ' — ' },
    { t: 'figure', v: top.display, tone: 'neutral' },
    { t: 'text', v: ` de ${fact.totalDisplay}.` },
  ];

  return {
    id: `concentration:${top.key}`,
    kind: 'concentration',
    sentence,
    chart: {
      type: 'composition',
      slices: slicesOf(clients),
    },
    altText: `Reparto de la facturación de ${fact.windowLabel} por cliente. ${top.label} es el ${shareText} del total.`,
    question: '¿debería rebalancear?',
    provenance: {
      source: fact.source.system,
      readAt: fact.source.readAt,
      detail: fact.source.method,
    },
    weight: 60,
  };
}

/**
 * Los segmentos: los cinco primeros, y el resto sumado en «Otros».
 *
 * Una barra con veinte tramos de un píxel no es un reparto, es una textura. Y
 * el resto se SUMA en vez de descartarse: si los tramos no cierran el total, el
 * porcentaje de la frase y el ancho del primer tramo dejan de coincidir, que es
 * exactamente el tipo de desacuerdo que hace dudar de las dos cifras.
 */
export function slicesOf(clients: ClientShareFact[]): Array<{
  label: string;
  value: number;
  display: string;
  tone: 'primary' | 'sky' | 'ink';
}> {
  const head = clients.slice(0, MAX_SLICES);
  const tail = clients.slice(MAX_SLICES);
  const slices = head.map((c, i) => ({
    label: c.label,
    value: c.total,
    display: c.display,
    // El primero es el del hallazgo, así que va en el color del producto; los
    // demás son el contexto contra el que se lee.
    tone: (i === 0 ? 'primary' : 'sky') as 'primary' | 'sky' | 'ink',
  }));
  if (tail.length > 0) {
    const rest = tail.reduce((sum, c) => sum + c.total, 0);
    if (rest > 0) {
      slices.push({
        label: `Otros ${tail.length}`,
        value: rest,
        display: '',
        tone: 'ink' as const,
      });
    }
  }
  return slices;
}

// ---------------------------------------------------------------------------
// El carrusel
// ---------------------------------------------------------------------------

/**
 * Todo lo que se puede sustentar, lo peor primero.
 *
 * El orden es el argumento: quien abre esta pantalla ve una tarjeta, no cinco,
 * y la que ve tiene que ser la que pide una decisión. Una meta incumplida gana
 * a una caída de facturación, que gana a una concentración, que gana a una meta
 * que mejoró — porque lo primero hay que arreglarlo, lo último sólo hay que
 * saberlo.
 *
 * El desempate es el ORDEN DE ENTRADA, no el id: con `sort` estable, dos metas
 * igual de incumplidas salen siempre en el mismo orden en que se fijaron, y no
 * bailan entre dos cargas de la misma pantalla.
 */
export function pickInsights(facts: InsightFacts): Insight[] {
  const found: Insight[] = [];
  for (const goal of facts.goals) {
    const insight = goalInsight(goal);
    if (insight) found.push(insight);
  }
  const billing = billingInsight(facts.billing);
  if (billing) found.push(billing);
  const concentration = concentrationInsight(facts.concentration);
  if (concentration) found.push(concentration);

  return found.sort((a, b) => b.weight - a.weight).slice(0, MAX_INSIGHTS);
}

/** La frase entera en texto plano: para el `aria-label` y para las pruebas. */
export function plainSentence(sentence: Piece[]): string {
  return sentence.map((p) => p.v).join('');
}
