import {
  type BillingFact,
  CONCENTRATION_PCT,
  type ConcentrationFact,
  type GoalFact,
  type GoalReadingFact,
  MAX_INSIGHTS,
  MIN_READINGS,
  MIN_SAMPLE,
  billingInsight,
  concentrationInsight,
  deltaText,
  goalInsight,
  pctText,
  pickInsights,
  plainSentence,
  slicesOf,
} from '@/lib/insights-shape';
import { describe, expect, it } from 'vitest';

/**
 * LO QUE SE PRUEBA AQUÍ ES LO QUE NO SE DIBUJA.
 *
 * Un hallazgo falso se ve idéntico a uno verdadero: la misma tarjeta, la misma
 * monoespaciada, el mismo sello de procedencia. En pantalla no hay forma de
 * distinguir «la facturación cayó un 55%» de «llevamos catorce días de agosto».
 * Así que la mayoría de estos casos comprueban un `null`, y ese `null` es la
 * funcionalidad.
 */

/**
 * «Aquí sí tenía que haber un hallazgo.»
 *
 * La mitad de estas pruebas comprueban un `null`, así que la otra mitad tiene
 * que poder afirmar lo contrario sin arrastrar un `!` a cada línea: si el
 * hallazgo no está, lo que falla es el caso, con su nombre puesto.
 */
function must<T>(value: T | null): T {
  if (value === null) throw new Error('se esperaba un hallazgo y no lo hubo');
  return value;
}

const SOURCE = {
  system: 'Compromisos (Cortex)',
  readAt: '01 ago 06:12',
  method: 'cierres en fecha sobre cierres del período',
};

function reading(over: Partial<GoalReadingFact> = {}): GoalReadingFact {
  return {
    periodLabel: 'julio de 2026',
    periodStart: '2026-07-01',
    value: 92,
    display: '92%',
    status: 'met',
    sampleSize: 40,
    ...over,
  };
}

function goal(over: Partial<GoalFact> = {}): GoalFact {
  return {
    id: 'g1',
    label: 'Compromisos en fecha',
    unit: 'percent',
    direction: 'higher_is_better',
    targetPhrase: 'al menos 95%',
    readings: [
      reading({
        periodLabel: 'julio de 2026',
        periodStart: '2026-07-01',
        value: 92,
        display: '92%',
      }),
      reading({
        periodLabel: 'junio de 2026',
        periodStart: '2026-06-01',
        value: 98,
        display: '98%',
      }),
    ],
    source: SOURCE,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('una meta sin con qué compararse no es un hallazgo', () => {
  it('con una sola lectura congelada, nada', () => {
    expect(goalInsight(goal({ readings: [reading()] }))).toBeNull();
  });

  it('sin ninguna lectura, nada', () => {
    expect(goalInsight(goal({ readings: [] }))).toBeNull();
  });

  /**
   * QUE LA CONSTANTE SEA LA QUE MANDA.
   *
   * `MIN_READINGS` estaba exportada y documentada como la regla, pero lo que la
   * aplicaba de verdad era el destructuring de dos posiciones — que pide dos por
   * casualidad. Subirla a tres no habría cambiado nada, y el siguiente que la
   * tocara habría creído que sí.
   *
   * Esto no comprueba un caso: comprueba que el número de arriba GOBIERNA. Con
   * exactamente `MIN_READINGS` lecturas tiene que haber hallazgo, y con una
   * menos no — sea cual sea el valor que alguien le ponga mañana.
   */
  it('el umbral que manda es la constante, no el número de posiciones que se leen', () => {
    const periodo = (i: number) => `2026-${String(i + 1).padStart(2, '0')}-01`;
    const justas = Array.from({ length: MIN_READINGS }, (_, i) =>
      reading({ periodStart: periodo(i), value: 50 + i }),
    );
    expect(goalInsight(goal({ readings: justas }))).not.toBeNull();
    expect(goalInsight(goal({ readings: justas.slice(0, MIN_READINGS - 1) }))).toBeNull();
  });

  it('un período que no se pudo medir no es ninguno de los dos extremos', () => {
    const withGap = goal({
      readings: [
        reading({ status: 'unmeasurable', value: null, display: 'Sin datos' }),
        reading({ periodStart: '2026-06-01', value: 98, display: '98%' }),
      ],
    });
    expect(goalInsight(withGap)).toBeNull();
  });

  it('tampoco si el hueco es el período anterior', () => {
    const withGap = goal({
      readings: [
        reading(),
        reading({ periodStart: '2026-06-01', status: 'unmeasurable', value: null }),
      ],
    });
    expect(goalInsight(withGap)).toBeNull();
  });

  it('una cifra hecha sobre menos de tres filas no se cita', () => {
    const thin = goal({
      readings: [
        reading({ sampleSize: MIN_SAMPLE - 1 }),
        reading({ periodStart: '2026-06-01', value: 98, display: '98%' }),
      ],
    });
    expect(goalInsight(thin)).toBeNull();
  });

  it('pero un período anterior flaco no invalida la noticia de hoy', () => {
    const ok = goal({
      readings: [
        reading({ sampleSize: 40 }),
        reading({ periodStart: '2026-06-01', value: 98, display: '98%', sampleSize: 1 }),
      ],
    });
    expect(goalInsight(ok)).not.toBeNull();
  });
});

describe('una meta cumplida y quieta no interrumpe a nadie', () => {
  it('media décima de movimiento es redondeo, no noticia', () => {
    const still = goal({
      readings: [
        reading({ value: 98.4, display: '98,4%' }),
        reading({ periodStart: '2026-06-01', value: 98, display: '98%' }),
      ],
    });
    expect(goalInsight(still)).toBeNull();
  });

  it('pero incumplida sí, aunque no se haya movido nada', () => {
    const stuck = goal({
      readings: [
        reading({ status: 'breached', value: 80, display: '80%' }),
        reading({ periodStart: '2026-06-01', status: 'breached', value: 80, display: '80%' }),
      ],
    });
    const insight = must(goalInsight(stuck));
    expect(plainSentence(insight.sentence)).toContain('sin cambio');
    expect(plainSentence(insight.sentence)).toContain('y la meta era al menos 95%');
  });
});

describe('el color de la cifra dice si la noticia es buena, no de qué signo es', () => {
  it('subir es bueno cuando más es mejor', () => {
    const up = goal({
      readings: [
        reading({ value: 98, display: '98%' }),
        reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
      ],
    });
    const delta = must(goalInsight(up)).sentence.find(
      (p) => p.t === 'figure' && p.v.startsWith('+'),
    );
    expect(delta).toMatchObject({ tone: 'emerald', v: '+6 pp' });
  });

  it('bajar es malo cuando más es mejor', () => {
    const delta = must(goalInsight(goal())).sentence.find(
      (p) => p.t === 'figure' && p.v.startsWith('−'),
    );
    expect(delta).toMatchObject({ tone: 'rose', v: '−6 pp' });
  });

  /**
   * LA TRAMPA. `receivables_days` y `review_backlog` son `lower_is_better`:
   * bajar seis días de cartera es la mejor noticia del mes y el número es
   * negativo. Pintarlo de rojo por el signo sería decir lo contrario de lo que
   * pasó, con total aplomo.
   */
  it('bajar es BUENO cuando menos es mejor', () => {
    const better = goal({
      unit: 'days',
      direction: 'lower_is_better',
      targetPhrase: 'no pasar de 45 d',
      readings: [
        reading({ value: 38, display: '38 d' }),
        reading({ periodStart: '2026-06-01', value: 44, display: '44 d' }),
      ],
    });
    const delta = must(goalInsight(better)).sentence.find(
      (p) => p.t === 'figure' && p.v === '−6 d',
    );
    expect(delta).toMatchObject({ tone: 'emerald' });
  });

  it('y subir es MALO cuando menos es mejor', () => {
    const worse = goal({
      unit: 'count',
      direction: 'lower_is_better',
      targetPhrase: 'no pasar de 10',
      readings: [
        reading({ value: 22, display: '22', status: 'breached' }),
        reading({ periodStart: '2026-06-01', value: 9, display: '9' }),
      ],
    });
    const delta = must(goalInsight(worse)).sentence.find((p) => p.t === 'figure' && p.v === '+13');
    expect(delta).toMatchObject({ tone: 'rose' });
  });
});

describe('el gráfico de una meta lee el veredicto congelado, no lo vuelve a juzgar', () => {
  it('pinta cada período con el estado con que se cerró', () => {
    const mixed = goal({
      readings: [
        reading({ periodStart: '2026-07-01', value: 80, display: '80%', status: 'breached' }),
        reading({ periodStart: '2026-06-01', value: 98, display: '98%', status: 'met' }),
        reading({ periodStart: '2026-05-01', value: 96, display: '96%', status: 'met' }),
      ],
    });
    const chart = must(goalInsight(mixed)).chart;
    expect(chart.type).toBe('bars');
    if (chart.type !== 'bars') throw new Error('unreachable');
    // Cronológico: el gráfico se lee de izquierda a derecha, `listReadings` viene al revés.
    expect(chart.bars.map((b) => b.value)).toEqual([96, 98, 80]);
    expect(chart.bars.map((b) => b.tone)).toEqual(['emerald', 'emerald', 'rose']);
  });

  it('no dibuja más de ocho barras', () => {
    const long = goal({
      readings: Array.from({ length: 14 }, (_, i) => {
        const month = String(12 - (i % 12)).padStart(2, '0');
        return reading({ periodStart: `2026-${month}-01`, periodLabel: `mes ${i}`, value: 90 + i });
      }),
    });
    const chart = must(goalInsight(long)).chart;
    if (chart.type !== 'bars') throw new Error('unreachable');
    expect(chart.bars.length).toBe(8);
  });

  /**
   * Si las dos lecturas llegaran al revés, el signo de la frase se invierte y
   * en pantalla no se ve nada raro. Se ordena por fecha aunque el llamador ya
   * prometa hacerlo.
   */
  it('ordena por fecha aunque le entreguen las lecturas al revés', () => {
    const backwards = goal({
      readings: [
        reading({
          periodStart: '2026-06-01',
          periodLabel: 'junio de 2026',
          value: 98,
          display: '98%',
        }),
        reading({
          periodStart: '2026-07-01',
          periodLabel: 'julio de 2026',
          value: 92,
          display: '92%',
        }),
      ],
    });
    const text = plainSentence(must(goalInsight(backwards)).sentence);
    expect(text).toContain('cerró julio de 2026 en 92%');
    expect(text).toContain('−6 pp frente a junio de 2026');
  });
});

describe('la meta lleva su procedencia y su pregunta', () => {
  it('cita el sistema, la hora y la aritmética', () => {
    expect(must(goalInsight(goal())).provenance).toEqual({
      source: SOURCE.system,
      readAt: SOURCE.readAt,
      detail: SOURCE.method,
    });
  });

  it('una meta incumplida pregunta por qué', () => {
    const broken = goal({
      readings: [
        reading({ value: 80, display: '80%', status: 'breached' }),
        reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
      ],
    });
    expect(must(goalInsight(broken)).question).toBe(
      '¿por qué compromisos en fecha se salió de la meta en julio de 2026?',
    );
  });

  it('una que mejoró pregunta qué se hizo distinto', () => {
    const up = goal({
      readings: [
        reading({ value: 98, display: '98%' }),
        reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
      ],
    });
    expect(must(goalInsight(up)).question).toBe('¿qué hicimos distinto en julio de 2026?');
  });
});

// ---------------------------------------------------------------------------

function month(m: string, label: string, total: number): BillingFact['months'][number] {
  return { month: m, label, total, display: `$${total.toLocaleString('es-CO')}` };
}

function billing(over: Partial<BillingFact> = {}): BillingFact {
  return {
    months: [
      month('2026-05', 'mayo', 100_000_000),
      month('2026-06', 'junio', 120_000_000),
      month('2026-07', 'julio', 84_000_000),
    ],
    pendingExcluded: 0,
    truncated: false,
    source: {
      system: 'Documentos (Brain Knowledge)',
      readAt: '14 ago 09:00',
      method: 'suma de facturas confirmadas por mes de emisión',
    },
    ...over,
  };
}

describe('la facturación sólo compara meses que ya cerraron', () => {
  it('sin dos meses, nada', () => {
    expect(billingInsight(billing({ months: [month('2026-07', 'julio', 84_000_000)] }))).toBeNull();
  });

  it('sin facturación en absoluto, nada', () => {
    expect(billingInsight(null)).toBeNull();
  });

  /**
   * EL −100% QUE NO EXISTE. Un mes en cero casi nunca es una empresa que dejó
   * de facturar; es una empresa que dejó de subir facturas. La división da un
   * número redondo y rotundamente falso.
   */
  it('un mes anterior en cero no produce una caída del cien por cien', () => {
    const gap = billing({
      months: [month('2026-06', 'junio', 0), month('2026-07', 'julio', 84_000_000)],
    });
    expect(billingInsight(gap)).toBeNull();
  });

  it('y un mes actual en cero tampoco', () => {
    const gap = billing({
      months: [month('2026-06', 'junio', 84_000_000), month('2026-07', 'julio', 0)],
    });
    expect(billingInsight(gap)).toBeNull();
  });

  /**
   * El barrido ordena por fecha de emisión descendente antes de cortar a mil
   * filas, así que lo que se pierde son los meses más antiguos: exactamente
   * aquellos contra los que se compara. La caída dibujada sería la del corte.
   */
  it('si el barrido tocó su techo, no se dibuja una caída que es el corte', () => {
    expect(billingInsight(billing({ truncated: true }))).toBeNull();
  });

  it('un movimiento por debajo del cinco por ciento es ruido', () => {
    const flat = billing({
      months: [month('2026-06', 'junio', 100_000_000), month('2026-07', 'julio', 103_000_000)],
    });
    expect(billingInsight(flat)).toBeNull();
  });

  it('una caída se cuenta, en rosa, y pregunta por qué', () => {
    const insight = must(billingInsight(billing()));
    expect(plainSentence(insight.sentence)).toBe(
      'Facturaste $84.000.000 en julio — −30% frente a junio.',
    );
    expect(insight.question).toBe('¿por qué bajó la facturación en julio?');
    expect(insight.sentence.filter((p) => p.t === 'figure').every((p) => p.tone === 'rose')).toBe(
      true,
    );
  });

  it('una subida también, en verde, y pregunta de dónde salió', () => {
    const up = billing({
      months: [month('2026-06', 'junio', 84_000_000), month('2026-07', 'julio', 120_000_000)],
    });
    const insight = must(billingInsight(up));
    expect(insight.question).toBe('¿de dónde salió el crecimiento de julio?');
    expect(plainSentence(insight.sentence)).toContain('+42,9%');
  });

  /** Un total sin decir qué se quedó fuera enseña a tratarlo como completo. */
  it('confiesa lo que no entró en la cuenta, dentro de la frase', () => {
    const insight = must(billingInsight(billing({ pendingExcluded: 6 })));
    expect(plainSentence(insight.sentence)).toContain('Sin contar 6 documentos sin revisar.');
  });

  it('y lo dice en singular cuando es uno solo', () => {
    const insight = must(billingInsight(billing({ pendingExcluded: 1 })));
    expect(plainSentence(insight.sentence)).toContain('Sin contar 1 documento sin revisar.');
  });

  it('dibuja todos los meses cerrados, cronológicos', () => {
    const chart = must(billingInsight(billing())).chart;
    expect(chart.type).toBe('timeseries');
    if (chart.type !== 'timeseries') throw new Error('unreachable');
    expect(chart.points.map((p) => p.label)).toEqual(['mayo', 'junio', 'julio']);
    expect(chart.points.map((p) => p.value)).toEqual([100_000_000, 120_000_000, 84_000_000]);
  });
});

// ---------------------------------------------------------------------------

function share(key: string, label: string, total: number, href: string | null = `/clients/${key}`) {
  return { key, label, total, display: `$${total.toLocaleString('es-CO')}`, href };
}

function concentration(over: Partial<ConcentrationFact> = {}): ConcentrationFact {
  return {
    windowLabel: 'los últimos 12 meses',
    clients: [
      share('c1', 'Coltrans', 580_000_000),
      share('c2', 'Andina', 240_000_000),
      share('c3', 'Sur Carga', 180_000_000),
    ],
    totalDisplay: '$1.000.000.000',
    pendingExcluded: 0,
    truncated: false,
    source: {
      system: 'Documentos (Brain Knowledge)',
      readAt: '14 ago 09:00',
      method: 'suma de facturas confirmadas por cliente',
    },
    ...over,
  };
}

describe('la concentración necesita que haya de qué concentrarse', () => {
  it('con dos clientes, ser el 58% es dividir, no concentrar', () => {
    const two = concentration({
      clients: [share('c1', 'Coltrans', 580_000_000), share('c2', 'Andina', 420_000_000)],
    });
    expect(concentrationInsight(two)).toBeNull();
  });

  it('sin facturación por cliente, nada', () => {
    expect(concentrationInsight(null)).toBeNull();
  });

  it('un reparto parejo no es un hallazgo', () => {
    const even = concentration({
      clients: [
        share('c1', 'Coltrans', 350_000_000),
        share('c2', 'Andina', 340_000_000),
        share('c3', 'Sur Carga', 310_000_000),
      ],
    });
    expect(concentrationInsight(even)).toBeNull();
  });

  it('justo en el umbral sí cuenta', () => {
    const atEdge = concentration({
      clients: [
        share('c1', 'Coltrans', CONCENTRATION_PCT),
        share('c2', 'Andina', 30),
        share('c3', 'Sur Carga', 30),
      ],
    });
    expect(concentrationInsight(atEdge)).not.toBeNull();
  });

  it('con el barrido cortado, el reparto es de otro conjunto y no se dibuja', () => {
    expect(concentrationInsight(concentration({ truncated: true }))).toBeNull();
  });

  it('con todo en cero no divide por cero', () => {
    const empty = concentration({
      clients: [share('c1', 'A', 0), share('c2', 'B', 0), share('c3', 'C', 0)],
    });
    expect(concentrationInsight(empty)).toBeNull();
  });

  it('nombra al cliente, lo enlaza y pregunta si hay que rebalancear', () => {
    const insight = must(concentrationInsight(concentration()));
    expect(plainSentence(insight.sentence)).toBe(
      '58% de lo que facturaste en los últimos 12 meses sale de Coltrans — $580.000.000 de $1.000.000.000.',
    );
    expect(insight.sentence.find((p) => p.t === 'entity')).toEqual({
      t: 'entity',
      v: 'Coltrans',
      href: '/clients/c1',
    });
    expect(insight.question).toBe('¿debería rebalancear?');
  });

  /**
   * `aggregateRecords` agrupa por `clientId` cuando lo hay y si no cae al NIT.
   * Un nombre que no lleva a ninguna ficha se dice, pero no se enlaza.
   */
  it('no enlaza un nombre que no es un cliente registrado', () => {
    const loose = concentration({
      clients: [
        share('900123456', 'Transportes del Llano', 580_000_000, null),
        share('c2', 'Andina', 240_000_000),
        share('c3', 'Sur Carga', 180_000_000),
      ],
    });
    const entity = must(concentrationInsight(loose)).sentence.find((p) => p.t === 'entity');
    expect(entity).toEqual({ t: 'entity', v: 'Transportes del Llano', href: null });
  });
});

describe('los segmentos de la barra cierran el total', () => {
  it('agrupa la cola en «Otros» en vez de descartarla', () => {
    const many = Array.from({ length: 9 }, (_, i) => share(`c${i}`, `Cliente ${i}`, 100 - i * 5));
    const slices = slicesOf(many);
    expect(slices.length).toBe(6);
    expect(slices[5]?.label).toBe('Otros 4');
    const sum = slices.reduce((t, s) => t + s.value, 0);
    expect(sum).toBe(many.reduce((t, c) => t + c.total, 0));
  });

  it('sin cola, no inventa un segmento vacío', () => {
    const slices = slicesOf([share('c1', 'A', 10), share('c2', 'B', 5)]);
    expect(slices.map((s) => s.label)).toEqual(['A', 'B']);
  });

  it('el cliente del hallazgo va en el color del producto', () => {
    const slices = slicesOf([share('c1', 'A', 10), share('c2', 'B', 5), share('c3', 'C', 1)]);
    expect(slices.map((s) => s.tone)).toEqual(['primary', 'sky', 'sky']);
  });
});

// ---------------------------------------------------------------------------

describe('el carrusel enseña lo peor primero', () => {
  const breached = goal({
    id: 'g-roto',
    label: 'Compromisos en fecha',
    readings: [
      reading({ value: 80, display: '80%', status: 'breached' }),
      reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
    ],
  });
  const improved = goal({
    id: 'g-bien',
    label: 'Promesas internas',
    readings: [
      reading({ value: 98, display: '98%' }),
      reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
    ],
  });

  it('una meta incumplida gana a una caída de facturación, que gana a la concentración', () => {
    const picked = pickInsights({
      goals: [improved, breached],
      billing: billing(),
      concentration: concentration(),
    });
    expect(picked.map((i) => i.id)).toEqual([
      'goal:g-roto',
      'billing:2026-07',
      'concentration:c1',
      'goal:g-bien',
    ]);
  });

  it('un espacio sin nada que sustentar devuelve cero hallazgos, no ejemplos', () => {
    expect(pickInsights({ goals: [], billing: null, concentration: null })).toEqual([]);
  });

  it('un espacio con metas recién fijadas tampoco inventa nada', () => {
    const brandNew = goal({ readings: [reading()] });
    expect(pickInsights({ goals: [brandNew], billing: null, concentration: null })).toEqual([]);
  });

  it('no pasa de cinco', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      goal({
        id: `g${i}`,
        readings: [
          reading({ value: 80, display: '80%', status: 'breached' }),
          reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
        ],
      }),
    );
    expect(pickInsights({ goals: many, billing: null, concentration: null }).length).toBe(
      MAX_INSIGHTS,
    );
  });

  /** Dos cargas de la misma pantalla no pueden barajar las tarjetas. */
  it('mantiene el orden de entrada entre iguales', () => {
    const tied = ['a', 'b', 'c'].map((id) =>
      goal({
        id,
        readings: [
          reading({ value: 80, display: '80%', status: 'breached' }),
          reading({ periodStart: '2026-06-01', value: 92, display: '92%' }),
        ],
      }),
    );
    const ids = pickInsights({ goals: tied, billing: null, concentration: null }).map((i) => i.id);
    expect(ids).toEqual(['goal:a', 'goal:b', 'goal:c']);
  });
});

describe('cómo se escriben las variaciones', () => {
  it('puntos porcentuales, no por ciento, cuando la unidad ya es un porcentaje', () => {
    expect(deltaText(-6, 'percent')).toBe('−6 pp');
    expect(deltaText(6, 'percent')).toBe('+6 pp');
  });

  it('días y conteos llevan lo suyo', () => {
    expect(deltaText(-6, 'days')).toBe('−6 d');
    expect(deltaText(13, 'count')).toBe('+13');
  });

  it('una décima se escribe a la colombiana', () => {
    expect(deltaText(-6.25, 'percent')).toBe('−6,3 pp');
  });

  it('cero se dice con palabras', () => {
    expect(deltaText(0, 'percent')).toBe('sin cambio');
  });

  it('el por ciento sí es una división', () => {
    expect(pctText(-30)).toBe('−30%');
    expect(pctText(42.857)).toBe('+42,9%');
  });

  /** El menos es U+2212, no un guion: es el que se alinea en monoespaciada. */
  it('usa el signo menos tipográfico', () => {
    expect(deltaText(-6, 'percent').charCodeAt(0)).toBe(0x2212);
    expect(pctText(-30).charCodeAt(0)).toBe(0x2212);
  });
});
