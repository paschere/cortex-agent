import 'server-only';
import {
  type AggregateGroup,
  aggregateRecords,
  bogotaToday,
  cop,
  describeTarget,
  listClients,
  listGoals,
  listReadings,
  metricByKey,
  periodContaining,
  renderChart,
} from '@cortex/agent-tools';
import type { BillingFact, ConcentrationFact, GoalFact, Insight, Piece } from './insights-shape';
import { pickInsights } from './insights-shape';
import { getOrgScopedClient } from './supabase/service';

/**
 * DE DÓNDE SALEN LOS HALLAZGOS.
 *
 * `insights-shape.ts` decide qué se puede decir; este archivo consigue con qué.
 * La separación no es ceremonia: la parte que puede equivocarse en silencio es
 * la decisión, y la decisión está en un módulo puro con cincuenta y una pruebas
 * al lado. Aquí sólo hay lecturas.
 *
 * ===========================================================================
 * TRES LECTURAS, TRES FALLOS INDEPENDIENTES
 * ===========================================================================
 * Cada fuente se lee sola y se traga su propio error como un HUECO CON NOMBRE,
 * nunca como un hallazgo menos. Es la doctrina de `lib/waiting.ts`: enseñar
 * dos tarjetas cuando la tercera consulta falló es decir «no hay nada más»
 * cuando lo que pasó es «no pude mirar». El componente escribe los huecos.
 *
 * ===========================================================================
 * EL GRÁFICO LO DIBUJA EL RENDERIZADOR DEL INFORME, NO ESTA PANTALLA
 * ===========================================================================
 * `renderChart` es el mismo que produce el gráfico del chat y el del informe
 * guardado, y está exportado del paquete precisamente para esto («so a surface
 * that renders one section on its own does not have to reach into the module»).
 * Sale SVG como cadena, se pinta dentro de un `.rp-doc` —`REPORT_CSS` va
 * enlazada para toda la aplicación desde el layout raíz— y no entra ni una
 * librería de gráficos.
 *
 * Ésa es la garantía que este producto da sobre sus cifras: hay UN dibujante.
 * Una segunda forma de dibujar significa dos dibujos del mismo dato que nada
 * obliga a coincidir, y nos enteraríamos el día que un cliente dijera que el
 * gráfico del inicio no cuadra con el del informe. Ver la cabecera de
 * `packages/agent-tools/src/reports/charts.ts`.
 */

/**
 * El techo de `queryRecords`, repetido aquí porque lo que importa es DETECTAR
 * que se tocó.
 *
 * El barrido ordena por `issued_on` descendente y corta en mil, así que lo
 * primero que se pierde son los meses más antiguos del período: exactamente
 * contra los que se compara. `aggregateRecords` no devuelve una bandera de
 * truncamiento, pero sí devuelve los conteos por grupo, y su suma es cuántas
 * filas entraron. Si llegó al techo, la comparación no se dibuja.
 */
const SCAN_CAP = 1000;

/** Meses cerrados de la serie de facturación. Medio año se lee de un vistazo. */
const BILLING_MONTHS = 6;

/** Ventana del reparto por cliente. Un año entero absorbe la estacionalidad. */
const CONCENTRATION_MONTHS = 12;

/**
 * Cuántas metas activas se miran.
 *
 * El catálogo tiene siete métricas, así que un espacio con más de doce metas
 * activas está repitiendo métrica con otro objetivo. El corte es por
 * `created_at` ascendente —el mismo orden estable de `listGoals`— para que no
 * sea una lotería distinta en cada carga.
 */
const MAX_GOALS = 12;

export interface InsightView {
  id: string;
  kind: Insight['kind'];
  sentence: Piece[];
  /** SVG ya dibujado por `renderChart`. Se pinta dentro de un `.rp-doc`. */
  chartHtml: string;
  question: string;
  provenance: Insight['provenance'];
}

export interface InsightsView {
  insights: InsightView[];
  /** Lo que no se pudo mirar, dicho. Nunca se calla. */
  gaps: string[];
}

export async function readInsights(organizationId: string): Promise<InsightsView> {
  const db = getOrgScopedClient(organizationId);
  const today = bogotaToday();
  const gaps: string[] = [];

  const [goals, billing, concentration] = await Promise.all([
    readGoalFacts(db).catch(() => {
      gaps.push('No pude leer las metas.');
      return [] as GoalFact[];
    }),
    readBilling(db, today).catch(() => {
      gaps.push('No pude leer la facturación por mes.');
      return null;
    }),
    readConcentration(db, today).catch(() => {
      gaps.push('No pude leer el reparto por cliente.');
      return null;
    }),
  ]);

  const insights = pickInsights({ goals, billing, concentration }).map((insight, i) => ({
    id: insight.id,
    kind: insight.kind,
    sentence: insight.sentence,
    // `idPrefix` tiene que ser único en la página: ata el `<title>` y el
    // `<desc>` del SVG a su `aria-labelledby`. Dos gráficos con el mismo
    // prefijo hacen que un lector de pantalla lea la descripción del otro.
    chartHtml: renderChart(insight.chart, {
      idPrefix: `ix-${i}`,
      altText: insight.altText,
    }),
    question: insight.question,
    provenance: insight.provenance,
  }));

  return { insights, gaps };
}

// ---------------------------------------------------------------------------
// 1. Metas
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof getOrgScopedClient>;

async function readGoalFacts(db: Db): Promise<GoalFact[]> {
  const goals = await listGoals(db, { state: 'active', limit: MAX_GOALS });
  if (goals.length === 0) return [];

  const facts = await Promise.all(
    goals.map(async (goal): Promise<GoalFact | null> => {
      // SIN MÉTRICA EN EL CATÁLOGO NO HAY PROCEDENCIA, Y SIN PROCEDENCIA NO HAY
      // HALLAZGO. Pasa con una meta cuya métrica se retiró: las lecturas
      // congeladas siguen ahí y son válidas, pero no hay a quién citar como
      // fuente, y un sello vacío devalúa todos los de verdad.
      const spec = metricByKey(goal.metric_key);
      if (!spec) return null;

      // Ocho: las que caben en el gráfico. Pedir veinticuatro sería traer
      // dieciséis filas para tirarlas.
      const readings = await listReadings(db, goal.id, 8);
      if (readings.length === 0) return null;
      const newest = readings[0];
      if (!newest) return null;

      return {
        id: goal.id,
        label: goal.label,
        unit: goal.unit,
        direction: goal.direction,
        targetPhrase: describeTarget(goal.direction, goal.target_value, goal.unit),
        readings: readings.map((r) => ({
          // «julio de 2026», «semana del 3 de agosto» — como se llama el
          // período en una frase, no su primer día en ISO.
          periodLabel: periodContaining(goal.cadence, r.period_start).label,
          periodStart: r.period_start,
          value: r.value,
          display: r.display,
          status: r.status,
          sampleSize: r.sample_size,
        })),
        source: {
          system: spec.source.system,
          readAt: stamp(newest.computed_at),
          // La aritmética de la lectura más reciente, congelada con ella. Es lo
          // que permite rehacer la cifra a mano.
          method: newest.method,
        },
      };
    }),
  );

  return facts.filter((f): f is GoalFact => f !== null);
}

// ---------------------------------------------------------------------------
// 2. Facturación por mes cerrado
// ---------------------------------------------------------------------------

async function readBilling(db: Db, today: string): Promise<BillingFact | null> {
  const months = closedMonths(today, BILLING_MONTHS);
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return null;

  const result = await aggregateRecords(db, {
    groupBy: 'month',
    metric: 'total_amount',
    filters: { issuedFrom: `${first}-01`, issuedTo: endOfMonth(last), today },
  });

  const currency = dominantCurrency(result.groups);
  if (!currency) return null;
  const inCurrency = result.groups.filter((g) => g.currency === currency);
  const byMonth = new Map(inCurrency.map((g) => [g.key, g.total]));

  return {
    // TODOS los meses del período, incluidos los que valen cero. Enseñar sólo
    // los que tienen facturas comprimiría el eje y haría que un mes sin subir
    // nada desapareciera de la historia en vez de verse como el hueco que es.
    months: months.map((m) => {
      const total = byMonth.get(m) ?? 0;
      return { month: m, label: monthName(m, today), total, display: cop(total) };
    }),
    pendingExcluded: result.pendingExcluded,
    truncated: scanned(result.groups) >= SCAN_CAP,
    source: {
      system: 'Documentos (Brain Knowledge)',
      readAt: stamp(new Date().toISOString()),
      method: `suma de facturas confirmadas en ${currency}, por mes de emisión`,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Reparto por cliente
// ---------------------------------------------------------------------------

async function readConcentration(db: Db, today: string): Promise<ConcentrationFact | null> {
  const months = closedMonths(today, CONCENTRATION_MONTHS);
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return null;

  const [result, clients] = await Promise.all([
    aggregateRecords(db, {
      groupBy: 'client',
      metric: 'total_amount',
      filters: { issuedFrom: `${first}-01`, issuedTo: endOfMonth(last), today },
    }),
    listClients(db, { limit: 500 }),
  ]);

  const currency = dominantCurrency(result.groups);
  if (!currency) return null;
  const inCurrency = result.groups.filter((g) => g.currency === currency && g.total > 0);
  if (inCurrency.length === 0) return null;

  // `aggregateRecords` agrupa por `client_id` cuando lo hay y si no cae al NIT
  // o a «desconocido», y el grupo no dice cuál de los tres fue. Así que se
  // comprueba contra los clientes de verdad: un nombre que no lleva a ninguna
  // ficha se dice, pero no se enlaza. Una mención rota es peor que un nombre.
  const known = new Set(clients.map((c) => c.id));
  const total = inCurrency.reduce((sum, g) => sum + g.total, 0);

  return {
    windowLabel: `los últimos ${CONCENTRATION_MONTHS} meses`,
    clients: inCurrency.map((g) => ({
      key: g.key,
      label: g.label,
      total: g.total,
      display: cop(g.total),
      href: known.has(g.key) ? `/clients/${g.key}` : null,
    })),
    totalDisplay: cop(total),
    pendingExcluded: result.pendingExcluded,
    truncated: scanned(result.groups) >= SCAN_CAP,
    source: {
      system: 'Documentos (Brain Knowledge)',
      readAt: stamp(new Date().toISOString()),
      method: `suma de facturas confirmadas en ${currency}, por cliente`,
    },
  };
}

// ---------------------------------------------------------------------------
// Los ayudantes
// ---------------------------------------------------------------------------

/** Cuántas filas entraron en el barrido. Su techo es lo que hay que detectar. */
function scanned(groups: AggregateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.count, 0);
}

/**
 * La moneda con más saldo, y sólo ésa.
 *
 * `aggregateRecords` parte por moneda siempre, y hace bien: sumar 3.000 USD a
 * 12.000.000 COP produce 12.003.000 de nada. Un hallazgo tiene una cifra, así
 * que se queda con la moneda que pesa —lo mismo que hace `receivables_days` con
 * `byCurrency[0]`— y lo dice en el método.
 */
function dominantCurrency(groups: AggregateGroup[]): string | null {
  const totals = new Map<string, number>();
  for (const g of groups) {
    if (!g.currency) continue;
    totals.set(g.currency, (totals.get(g.currency) ?? 0) + g.total);
  }
  let best: string | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const [currency, total] of totals) {
    if (total > bestTotal) {
      best = currency;
      bestTotal = total;
    }
  }
  return best;
}

/**
 * Los últimos `count` meses CERRADOS, cronológicos, terminando en el anterior
 * al de hoy.
 *
 * El mes en curso no entra nunca. El 14 de agosto lleva catorce días de
 * facturas y julio tiene treinta y uno; ponerlos a comparar dibuja una caída
 * del 55% que es el calendario, no el negocio.
 */
export function closedMonths(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let back = count; back >= 1; back--) {
    // `month - 1 - back` en base cero; `Date.UTC` normaliza el año solo.
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Último día del mes, `YYYY-MM-DD`. El día 0 del siguiente es el último de éste. */
export function endOfMonth(ym: string): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  const d = new Date(Date.UTC(year, month, 0));
  return `${ym}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * «julio» si es de este año, «julio de 2025» si no.
 *
 * El año sobra cuando no hay ambigüedad y estorba en una frase que se lee en
 * voz alta; en cuanto la ventana cruza diciembre, deja de sobrar.
 */
export function monthName(ym: string, today: string): string {
  const name = MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
  const year = ym.slice(0, 4);
  return year === today.slice(0, 4) ? name : `${name} de ${year}`;
}

/** «14 ago 09:00», hora de Colombia. Lo que el sello de procedencia enseña. */
export function stamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp.slice(0, 10);
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month').replace('.', '')} ${get('hour')}:${get('minute')}`;
}
