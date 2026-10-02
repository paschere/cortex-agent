import {
  type ComputedView,
  type ValueFormat,
  type ViewRow,
  type ViewSource,
  aggregate,
  formatValue,
  matches,
  todayIn,
} from './compute';
import { type ViewBlock, type ViewFilter, type ViewSpec, viewSpecSchema } from './spec';

/**
 * EL PULSO DE LA EMPRESA: «DIME CÓMO VA LA EMPRESA EN UNA VISTA Y ACTUALÍZALA
 * CADA DÍA», SIN QUE NADIE DISEÑE NADA.
 *
 * Tres piezas, todas puras en este archivo (la base y el modelo viven en
 * pulse-tools.ts):
 *
 *   1. COMPONER. `composePulseSpec` recibe el INVENTARIO de lo que esta
 *      empresa tiene de verdad (qué fuentes tienen filas) y arma la mejor vista
 *      ejecutiva con los bloques que ya existen: cifras con su comparación
 *      contra el mes anterior, la tendencia, quién debe más, los pendientes.
 *      Un bloque sin datos detrás no entra: una cifra en cero que en realidad
 *      es «no está conectado» le miente a un gerente. Lo que falta sale en
 *      `missing`, con cómo conectarlo.
 *
 *   2. LAS CIFRAS DEL DÍA. `pulseFacts` saca de la vista YA CALCULADA (la
 *      misma que ve la persona) cada número que el resumen puede citar, más lo
 *      que cambió ayer en las mismas fuentes. Nada más entra al modelo.
 *
 *   3. LA GUARDA. `checkGrounding` lee cada número que el modelo escribió y lo
 *      busca entre esas cifras. Uno que no está —un porcentaje calculado de
 *      cabeza, un total redondeado a otro orden de magnitud, un «3 facturas»
 *      inventado— tumba el resumen: se pide otra vez una sola vez y, si vuelve
 *      a fallar, se escribe `fallbackSummary`, que se arma sólo con las cifras
 *      y por eso no puede inventar.
 *
 * Por qué una guarda determinista y no «confía en el prompt»: el resumen se
 * escribe a las 7 a. m. sin nadie mirando y lo lee el dueño de la empresa como
 * primera cifra del día. Una cifra falsa ahí desacredita todas las demás.
 */

// ---------------------------------------------------------------------------
// Constantes que comparten la vista, la rutina y la herramienta
// ---------------------------------------------------------------------------

/** El slug con el que se guarda el pulso: uno por espacio, se rehace encima. */
export const PULSE_SLUG = 'pulso_empresa';
export const PULSE_NAME = 'Pulso de la empresa';
/** El bloque de texto que la rutina reescribe cada mañana. */
export const SUMMARY_BLOCK_ID = 'resumen_hoy';
/** Cómo se marca en el historial de versiones el resumen de un día (idempotencia). */
export const summaryVersionPrompt = (day: string) => `Resumen del día ${day}`;

export const PULSE_DEFAULT_HOUR = 7;
export const PULSE_DEFAULT_TIMEZONE = 'America/Bogota';
export const PULSE_DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5] as const;

export const SUMMARY_PLACEHOLDER = `### Resumen de hoy

Cortex escribe aquí, cada mañana, qué cambió frente a ayer y qué necesita atención hoy, con las cifras de esta misma vista.`;

// ---------------------------------------------------------------------------
// 1. El inventario y la composición
// ---------------------------------------------------------------------------

/** Las fuentes de la plataforma que el pulso sabe usar. */
export const PULSE_PLATFORM_SOURCES = [
  'cortex.ventas',
  'cortex.pagos',
  'cortex.cartera',
  'cortex.recuperado',
  'cortex.metas',
  'cortex.gestion',
  'cortex.compromisos',
  'cortex.vencimientos',
  'cortex.rutinas',
] as const;
export type PulsePlatformSource = (typeof PULSE_PLATFORM_SOURCES)[number];

/** `data`: tiene filas; `empty`: se leyó y no hay; `error`: no se pudo leer. */
export type SourceStatus = 'data' | 'empty' | 'error';

export const PULSE_ACCOUNTING_PROVIDERS = ['siigo', 'alegra', 'quickbooks'] as const;
export type PulseAccountingProvider = (typeof PULSE_ACCOUNTING_PROVIDERS)[number];
const PROVIDER_NAME: Record<PulseAccountingProvider, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

/** Las tablas que un programa contable llena solo (accounting/tables.ts). */
export const ACCOUNTING_TABLE_RE = /^(siigo|alegra|quickbooks)_(facturas|pagos|clientes)$/;

export interface PulseInventory {
  platform: Partial<Record<PulsePlatformSource, SourceStatus>>;
  /** Las tablas de programa contable que existen, con cuántas filas tienen. */
  accounting: Array<{
    provider: PulseAccountingProvider;
    entity: 'facturas' | 'pagos' | 'clientes';
    slug: string;
    rows: number;
  }>;
}

export interface PulseMissing {
  /** Qué no se puede mostrar todavía. */
  what: string;
  /** Qué hacer para verlo, en una frase. */
  how: string;
  href: string;
}

export interface PulseComposition {
  /** Null cuando no hay NADA que mostrar: no se crea una vista vacía. */
  spec: ViewSpec | null;
  /** Lo que entró, en palabras: «Ventas del mes (Siigo)», «Cartera vencida». */
  included: string[];
  missing: PulseMissing[];
  /** De dónde salen las ventas, para decirlo: «Siigo» o «facturas confirmadas». */
  salesFrom: string | null;
}

interface SalesSource {
  tracker: string;
  date: string;
  total: string;
  client: string;
  filters: ViewFilter[];
  /** Para la cartera, cuando no hay `cortex.cartera`. */
  overdue: ViewFilter[];
  name: string;
}

function salesSource(inv: PulseInventory): SalesSource | null {
  for (const provider of PULSE_ACCOUNTING_PROVIDERS) {
    const t = inv.accounting.find(
      (a) => a.provider === provider && a.entity === 'facturas' && a.rows > 0,
    );
    if (t)
      return {
        tracker: t.slug,
        date: 'fecha',
        total: 'total',
        client: 'cliente',
        filters: [{ field: 'estado', op: 'neq', value: 'Anulada' }],
        overdue: [{ field: 'estado', op: 'eq', value: 'Vencida' }],
        name: PROVIDER_NAME[provider],
      };
  }
  if (inv.platform['cortex.ventas'] === 'data')
    return {
      tracker: 'cortex.ventas',
      date: 'emitida',
      total: 'total',
      client: 'cliente',
      filters: [],
      overdue: [{ field: 'estado', op: 'eq', value: 'Vencida' }],
      name: 'facturas confirmadas',
    };
  return null;
}

function paymentsSource(inv: PulseInventory): { tracker: string; client: string } | null {
  // Los pagos de un programa contable también entran a Pagos (payments/import.ts),
  // así que `cortex.pagos` es la cifra completa cuando tiene filas.
  if (inv.platform['cortex.pagos'] === 'data')
    return { tracker: 'cortex.pagos', client: 'cliente' };
  for (const provider of PULSE_ACCOUNTING_PROVIDERS) {
    const t = inv.accounting.find(
      (a) => a.provider === provider && a.entity === 'pagos' && a.rows > 0,
    );
    if (t) return { tracker: t.slug, client: 'cliente' };
  }
  return null;
}

const has = (inv: PulseInventory, id: PulsePlatformSource) => inv.platform[id] === 'data';

const OPEN_CASE: ViewFilter[] = [
  { field: 'estado', op: 'neq', value: 'Cerrado con evidencia' },
  { field: 'estado', op: 'neq', value: 'Descartado' },
];

/**
 * La vista ejecutiva que esta empresa puede tener HOY. Pura: el mismo
 * inventario da siempre la misma vista (ids de bloque estables, para que la
 * rutina encuentre su texto y para que rehacerla no cambie nada que no cambió).
 */
export function composePulseSpec(inv: PulseInventory): PulseComposition {
  const sales = salesSource(inv);
  const payments = paymentsSource(inv);
  const included: string[] = [];
  const missing: PulseMissing[] = [];
  const kpis: unknown[] = [];
  const charts: unknown[] = [];
  const tables: unknown[] = [];

  if (sales) {
    kpis.push({
      id: 'ventas_mes',
      type: 'metric',
      width: 'third',
      title: 'Ventas del mes',
      tracker: sales.tracker,
      filters: sales.filters,
      aggregate: 'sum',
      field: sales.total,
      format: 'money',
      tone: 'emerald',
      compare: 'previous_period',
      period: 'month',
      dateField: sales.date,
      goodWhen: 'up',
    });
    included.push(`Ventas del mes contra el anterior (${sales.name})`);
    charts.push({
      id: 'tendencia_ventas',
      type: 'chart',
      width: 'half',
      title: 'Ventas por mes',
      tracker: sales.tracker,
      filters: [...sales.filters, { field: sales.date, op: 'last_days', value: 365 }],
      chart: 'line',
      groupBy: sales.date,
      bucket: 'month',
      aggregate: 'sum',
      field: sales.total,
      format: 'money',
      limit: 12,
      tone: 'emerald',
    });
    charts.push({
      id: 'top_clientes',
      type: 'chart',
      width: 'half',
      title: 'Clientes que más compraron (90 días)',
      tracker: sales.tracker,
      filters: [...sales.filters, { field: sales.date, op: 'last_days', value: 90 }],
      chart: 'bar',
      groupBy: sales.client,
      aggregate: 'sum',
      field: sales.total,
      format: 'money',
      limit: 8,
      tone: 'primary',
    });
    included.push('Tendencia de ventas y mejores clientes');
  } else {
    missing.push({
      what: 'Ventas y facturación',
      how: 'Conecta Siigo, Alegra o QuickBooks para ver facturación, cartera y pagos solos; o sube tus facturas al Feed.',
      href: '/integrations#programas-contables',
    });
  }

  // La cartera vencida: la fuente unificada si se pudo leer (también en cero:
  // «nada vencido» es una buena noticia, no un hueco); si no, la de las ventas.
  const carteraReadable =
    inv.platform['cortex.cartera'] === 'data' ||
    (inv.platform['cortex.cartera'] === 'empty' && sales !== null);
  const overdue = carteraReadable
    ? {
        tracker: 'cortex.cartera',
        filters: [] as ViewFilter[],
        columns: ['cliente', 'numero', 'vence', 'dias_mora', 'saldo'],
      }
    : sales
      ? {
          tracker: sales.tracker,
          filters: sales.overdue,
          columns: [sales.client, 'numero', 'vence', 'saldo'],
        }
      : null;
  if (overdue) {
    kpis.push({
      id: 'cartera_vencida',
      type: 'metric',
      width: 'third',
      title: 'Cartera vencida',
      tracker: overdue.tracker,
      filters: overdue.filters,
      aggregate: 'sum',
      field: 'saldo',
      format: 'money',
      tone: 'rose',
      caption: 'Plata en riesgo: facturas que ya pasaron su fecha.',
    });
    tables.push({
      id: 'top_deudores',
      type: 'table',
      width: 'full',
      title: 'Quién debe más',
      tracker: overdue.tracker,
      filters: overdue.filters,
      columns: overdue.columns,
      sort: { field: 'saldo', dir: 'desc' },
      limit: 10,
      searchable: false,
    });
    included.push('Cartera vencida y quién debe más');
  }

  if (has(inv, 'cortex.recuperado')) {
    kpis.push({
      id: 'recuperado',
      type: 'metric',
      width: 'third',
      title: 'Recuperado con Cortex',
      tracker: 'cortex.recuperado',
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      tone: 'emerald',
      compare: 'previous_period',
      period: 'month',
      dateField: 'fecha',
      goodWhen: 'up',
    });
    included.push('Plata recuperada con Cortex');
  } else if (overdue) {
    missing.push({
      what: 'Plata recuperada con Cortex',
      how: 'Aparece cuando Cortex cobra o avisa una factura vencida y el cliente paga. Activa la cartera que avisa sola en Procesos.',
      href: '/procesos',
    });
  }

  if (payments) {
    kpis.push({
      id: 'pagos_mes',
      type: 'metric',
      width: 'third',
      title: 'Pagos recibidos',
      tracker: payments.tracker,
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      tone: 'sky',
      compare: 'previous_period',
      period: 'month',
      dateField: 'fecha',
      goodWhen: 'up',
    });
    charts.push({
      id: 'cobros_mes',
      type: 'chart',
      width: 'half',
      title: 'Pagos recibidos por mes',
      tracker: payments.tracker,
      filters: [{ field: 'fecha', op: 'last_days', value: 365 }],
      chart: 'line',
      groupBy: 'fecha',
      bucket: 'month',
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      limit: 12,
      tone: 'sky',
    });
    included.push('Pagos recibidos (la caja que entra)');
  } else {
    missing.push({
      what: 'Pagos recibidos',
      how: 'Conecta tu programa contable o registra los pagos en Pagos para ver la plata que entra.',
      href: '/payments',
    });
  }

  if (has(inv, 'cortex.metas')) {
    const recent: ViewFilter[] = [{ field: 'periodo', op: 'last_days', value: 31 }];
    kpis.push({
      id: 'metas_cumplidas',
      type: 'metric',
      width: 'third',
      title: 'Metas cumplidas',
      tracker: 'cortex.metas',
      filters: [...recent, { field: 'estado', op: 'eq', value: 'Cumplida' }],
      aggregate: 'count',
      format: 'number',
      tone: 'emerald',
      caption: 'Mediciones del último mes que llegaron al objetivo.',
    });
    tables.push({
      id: 'metas',
      type: 'table',
      width: 'half',
      title: 'Metas y su avance',
      tracker: 'cortex.metas',
      filters: recent,
      columns: ['label', 'periodo', 'valor', 'objetivo', 'estado'],
      sort: { field: 'periodo', dir: 'desc' },
      limit: 10,
      searchable: false,
    });
    included.push('Metas y su avance');
  } else {
    missing.push({
      what: 'Metas',
      how: 'Define las metas del mes (ventas, cartera, entregas) y aquí verás cuáles se cumplen.',
      href: '/goals',
    });
  }

  if (has(inv, 'cortex.gestion')) {
    kpis.push({
      id: 'pendientes',
      type: 'metric',
      width: 'third',
      title: 'Pendientes de Gerencia',
      tracker: 'cortex.gestion',
      filters: OPEN_CASE,
      aggregate: 'count',
      format: 'number',
      tone: 'amber',
      caption: 'Asuntos abiertos: por organizar, en gestión, bloqueados o por verificar.',
    });
    tables.push({
      id: 'decisiones',
      type: 'table',
      width: 'half',
      title: 'Lo que espera una decisión',
      tracker: 'cortex.gestion',
      filters: OPEN_CASE,
      columns: ['label', 'estado', 'impacto', 'responsable', 'vence'],
      sort: { field: 'vence', dir: 'asc' },
      limit: 10,
      searchable: false,
    });
    included.push('Pendientes y decisiones de Gerencia');
  } else {
    missing.push({
      what: 'Pendientes y decisiones',
      how: 'Registra los asuntos de la empresa en Gerencia y aquí verás cuántos siguen abiertos.',
      href: '/management',
    });
  }

  if (has(inv, 'cortex.compromisos'))
    kpis.push({
      id: 'compromisos_vencidos',
      type: 'metric',
      width: 'third',
      title: 'Compromisos vencidos',
      tracker: 'cortex.compromisos',
      filters: [{ field: 'estado', op: 'eq', value: 'Vencido' }],
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
      caption: 'Lo que el equipo prometió y ya pasó su fecha.',
    });

  if (has(inv, 'cortex.vencimientos'))
    kpis.push({
      id: 'vencen_semana',
      type: 'metric',
      width: 'third',
      title: 'Vencen en 7 días',
      tracker: 'cortex.vencimientos',
      filters: [
        { field: 'vence', op: 'next_days', value: 7 },
        { field: 'estado', op: 'neq', value: 'Cumplido' },
        { field: 'estado', op: 'neq', value: 'Descartado' },
      ],
      aggregate: 'count',
      format: 'number',
      tone: 'amber',
      caption: 'Pólizas, contratos, permisos y pagos con terceros.',
    });

  if (has(inv, 'cortex.rutinas'))
    kpis.push({
      id: 'procesos_fallando',
      type: 'metric',
      width: 'third',
      title: 'Procesos con error (7 días)',
      tracker: 'cortex.rutinas',
      filters: [
        { field: 'estado', op: 'eq', value: 'Con error' },
        { field: 'inicio', op: 'last_days', value: 7 },
      ],
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
      caption: 'Rutinas que corrieron y fallaron esta semana.',
    });

  if (
    has(inv, 'cortex.compromisos') ||
    has(inv, 'cortex.vencimientos') ||
    has(inv, 'cortex.rutinas')
  )
    included.push('Compromisos, vencimientos y procesos que fallan');

  if (!kpis.length && !charts.length && !tables.length)
    return { spec: null, included: [], missing, salesFrom: null };

  // Lo par se queda en mitades; uno suelto ocupa la fila entera.
  const pairUp = (list: unknown[]) =>
    list.map((b, i) =>
      list.length % 2 === 1 && i === list.length - 1 ? { ...(b as object), width: 'full' } : b,
    );
  const halves = tables.filter((t) => (t as { width: string }).width === 'half');
  const fulls = tables.filter((t) => (t as { width: string }).width === 'full');

  const raw = {
    version: 1,
    subtitle: 'Cómo va la empresa hoy, con las cifras vivas de Cortex.',
    accent: 'primary',
    refreshSeconds: 60,
    editing: 'off',
    alerts: [],
    theme: { density: 'comfortable', header: 'plain' },
    blocks: [
      { id: SUMMARY_BLOCK_ID, type: 'text', width: 'full', markdown: SUMMARY_PLACEHOLDER },
      ...kpis.slice(0, 9),
      ...pairUp(charts.slice(0, 4)),
      ...fulls,
      ...pairUp(halves),
    ],
  };
  return {
    spec: viewSpecSchema.parse(raw),
    included,
    missing,
    salesFrom: sales?.name ?? null,
  };
}

/** Lo mismo, dicho para quien no tiene NADA conectado todavía. */
export function emptyPulseMessage(missing: PulseMissing[]): string {
  return [
    'Todavía no tengo datos de la empresa para armar el pulso: no encontré ventas, pagos, cartera, metas ni pendientes. Para empezar:',
    ...missing.map((m) => `- **${m.what}:** ${m.how} (${m.href})`),
    'Cuando haya datos, pídemelo otra vez y lo armo solo.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 2. Las cifras del día
// ---------------------------------------------------------------------------

export interface PulseFact {
  /** Estable: «ventas_mes», «ventas_mes.anterior», «ventas_mes.ayer». */
  key: string;
  /** Qué es, en palabras: «Ventas del mes», «Quién debe más: Acme». */
  label: string;
  value: number | null;
  /** Exactamente como se pinta en la vista. Es lo que el modelo debe copiar. */
  display: string;
  /** Cómo se pinta un número de esta cifra (para pintar su diferencia igual). */
  format?: ValueFormat;
  /**
   * El período que acumula una cifra «de este mes / esta semana / hoy»
   * («month:2026-10»). Dos días con período distinto no se restan: la cifra
   * volvió a cero al empezar el mes, no «bajó».
   */
  period?: string;
  /** Si subir es bueno o malo. Sin él, un cambio no es ni mejora ni empeora. */
  goodWhen?: 'up' | 'down';
}

/**
 * Si subir es bueno, para los bloques del pulso que no lo dicen en el spec
 * (la cartera vencida que sube es mala noticia aunque el bloque no compare).
 */
export const PULSE_GOOD_WHEN: Readonly<Record<string, 'up' | 'down'>> = {
  ventas_mes: 'up',
  pagos_mes: 'up',
  recuperado: 'up',
  metas_cumplidas: 'up',
  cartera_vencida: 'down',
  pendientes: 'down',
  compromisos_vencidos: 'down',
  vencen_semana: 'down',
  procesos_fallando: 'down',
  'top_deudores.total': 'down',
  'decisiones.total': 'down',
};

/** «month:2026-10», «week:2026-09-28», «day:2026-10-02»: qué acumula hoy una cifra del período. */
export function periodKey(period: 'day' | 'week' | 'month', today: string): string {
  if (period === 'month') return `month:${today.slice(0, 7)}`;
  if (period === 'day') return `day:${today}`;
  const t = new Date(`${today}T12:00:00Z`);
  const back = (t.getUTCDay() + 6) % 7;
  return `week:${addDays(today, -back)}`;
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfRow(row: ViewRow, field: string): string | null {
  const v = field === 'created_at' || field === 'updated_at' ? row[field] : row.values[field];
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

const pct = (delta: number) => Math.round(delta * 1000) / 10;

/**
 * Las cifras que el resumen puede citar, sacadas de la vista calculada (lo que
 * la persona ve) y, para «qué cambió ayer», de las mismas filas con los mismos
 * filtros de cada KPI. Nada que no esté aquí puede aparecer en el resumen.
 */
export function pulseFacts(
  spec: ViewSpec,
  computed: ComputedView,
  sources: Map<string, ViewSource>,
  now: Date = new Date(),
): PulseFact[] {
  const today = todayIn(now);
  const yesterday = addDays(today, -1);
  const facts: PulseFact[] = [];
  const specById = new Map(spec.blocks.map((b) => [b.id, b]));
  for (const block of computed.blocks) {
    if (block.type === 'metric') {
      const metricDef = specById.get(block.id);
      const format = metricDef?.type === 'metric' ? metricDef.format : undefined;
      const goodWhen =
        (metricDef?.type === 'metric' ? metricDef.goodWhen : undefined) ??
        PULSE_GOOD_WHEN[block.id];
      const period = block.compare ? periodKey(block.compare.period, today) : undefined;
      facts.push({
        key: block.id,
        label: block.title,
        value: block.value,
        display: block.display,
        ...(format ? { format } : {}),
        ...(period ? { period } : {}),
        ...(goodWhen ? { goodWhen } : {}),
      });
      if (block.compare) {
        facts.push({
          key: `${block.id}.anterior`,
          label: `${block.title} (${block.compare.previousLabel})`,
          value: block.compare.previous,
          display: block.compare.previousDisplay,
          ...(format ? { format } : {}),
        });
        if (block.compare.delta !== null) {
          const p = pct(block.compare.delta);
          facts.push({
            key: `${block.id}.cambio`,
            label: `${block.title}: cambio contra el período anterior`,
            value: p,
            display: `${p > 0 ? '+' : ''}${formatValue(p, 'number')} %`,
          });
        }
      }
      // Lo de ayer, con los mismos filtros del KPI.
      const def = specById.get(block.id);
      if (def?.type === 'metric' && def.compare && def.dateField) {
        const src = sources.get(def.tracker);
        if (src && !src.blocked) {
          const rows = src.rows.filter(
            (r) =>
              def.filters.every((f) => matches(src.tracker, r, f, today)) &&
              dayOfRow(r, def.dateField as string) === yesterday,
          );
          const value =
            def.aggregate === 'count' ? rows.length : aggregate(rows, def.aggregate, def.field);
          facts.push({
            key: `${block.id}.ayer`,
            label: `${block.title}: lo de ayer (${rows.length} ${rows.length === 1 ? 'registro' : 'registros'})`,
            value: value ?? 0,
            display: formatValue(value ?? 0, def.format),
            format: def.format,
          });
          facts.push({
            key: `${block.id}.ayer_registros`,
            label: `${block.title}: registros de ayer`,
            value: rows.length,
            display: formatValue(rows.length, 'number'),
            format: 'number',
          });
        }
      }
      if (block.goal)
        facts.push({
          key: `${block.id}.meta`,
          label: `${block.title}: meta`,
          value: block.goal.value,
          display: block.goal.display,
        });
    } else if (block.type === 'chart') {
      const chartDef = specById.get(block.id);
      const format = chartDef?.type === 'chart' ? chartDef.format : undefined;
      block.points.slice(0, 6).forEach((p, i) => {
        facts.push({
          key: `${block.id}.${i}`,
          label: `${block.title}: ${p.label}`,
          value: p.value,
          display: p.display,
          ...(format ? { format } : {}),
        });
      });
    } else if (block.type === 'table') {
      const header = block.columns.map((c) => c.label);
      block.rows.slice(0, 5).forEach((r, i) => {
        facts.push({
          key: `${block.id}.${i}`,
          label: `${block.title}: ${header.map((h, j) => `${h} ${r.cells[j] ?? '—'}`).join(' · ')}`,
          value: null,
          display: r.cells.join(' · '),
        });
      });
      const goodWhen = PULSE_GOOD_WHEN[`${block.id}.total`];
      facts.push({
        key: `${block.id}.total`,
        label: `${block.title}: filas`,
        value: block.total,
        display: formatValue(block.total, 'number'),
        format: 'number',
        ...(goodWhen ? { goodWhen } : {}),
      });
    }
  }
  // La cartera que se venció AYER (un día de mora): lo que cambió hoy en riesgo.
  const cartera = sources.get('cortex.cartera');
  if (
    cartera &&
    !cartera.blocked &&
    spec.blocks.some((b) => 'tracker' in b && b.tracker === 'cortex.cartera')
  ) {
    const fresh = cartera.rows.filter((r) => Number(r.values.dias_mora) === 1);
    const sum = fresh.reduce((s, r) => s + (Number(r.values.saldo) || 0), 0);
    facts.push({
      key: 'cartera.vencio_ayer',
      label: 'Facturas que se vencieron ayer',
      value: fresh.length,
      display: formatValue(fresh.length, 'number'),
      format: 'number',
    });
    facts.push({
      key: 'cartera.vencio_ayer_saldo',
      label: 'Saldo de las facturas que se vencieron ayer',
      value: sum,
      display: formatValue(sum, 'money'),
      format: 'money',
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// 3. La guarda: ningún número que no esté en las cifras
// ---------------------------------------------------------------------------

interface NumberToken {
  raw: string;
  /** Las lecturas posibles (12.500 es doce mil quinientos en Colombia, 12,5 en inglés). */
  readings: Array<{ value: number; tolerance: number }>;
}

const SCALE: Array<[RegExp, number]> = [
  [/^\s*mil\s+millones\b/i, 1e9],
  [/^\s*(millones|millón|millon|mill\.?|M)\b/, 1e6],
  [/^\s*(mil|k)\b/i, 1e3],
];

function readings(digits: string, scale: number): Array<{ value: number; tolerance: number }> {
  const out: Array<{ value: number; tolerance: number }> = [];
  const push = (normalized: string) => {
    const value = Number(normalized);
    if (!Number.isFinite(value)) return;
    const decimals = normalized.includes('.') ? (normalized.split('.')[1]?.length ?? 0) : 0;
    out.push({ value: value * scale, tolerance: (0.5 * scale) / 10 ** decimals });
  };
  // Colombia: punto de miles, coma decimal.
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(digits) || /^\d+(,\d+)?$/.test(digits))
    push(digits.replace(/\./g, '').replace(',', '.'));
  // Inglés: coma de miles, punto decimal («12.3 millones»).
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits) || /^\d+(\.\d+)?$/.test(digits))
    push(digits.replace(/,/g, ''));
  return out;
}

/** Cada número escrito en el texto, con sus lecturas posibles. */
export function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const re = /\d[\d.,]*\d|\d/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const digits = m[0];
    const rest = text.slice(m.index + digits.length, m.index + digits.length + 16);
    let scale = 1;
    for (const [pattern, factor] of SCALE)
      if (pattern.test(rest)) {
        scale = factor;
        break;
      }
    out.push({ raw: digits, readings: readings(digits, scale) });
  }
  return out;
}

export interface GroundingResult {
  ok: boolean;
  /** Los números del texto que no están en ninguna cifra. */
  ungrounded: string[];
}

/**
 * ¿Todo número del texto sale de las cifras? Un número vale si alguna de sus
 * lecturas cae en alguna cifra (su valor, su valor absoluto, o cualquier número
 * escrito en su etiqueta o en cómo se pinta), con la tolerancia de cómo se
 * escribió: «12 millones» cubre 12.345.678, «12,3 millones» exige 12,25–12,35.
 * Las fechas de hoy y de ayer (día, mes, año) también valen.
 */
export function checkGrounding(
  text: string,
  facts: PulseFact[],
  now: Date = new Date(),
): GroundingResult {
  const allowed = new Set<number>();
  for (const f of facts) {
    if (f.value !== null && Number.isFinite(f.value)) {
      allowed.add(f.value);
      allowed.add(Math.abs(f.value));
    }
    for (const t of [...numbersIn(f.display), ...numbersIn(f.label)])
      for (const r of t.readings) allowed.add(Math.abs(r.value));
  }
  const today = todayIn(now);
  for (const day of [today, addDays(today, -1)]) {
    const [y, m, d] = day.split('-').map(Number);
    for (const n of [y, m, d]) if (n !== undefined) allowed.add(n);
  }
  const values = [...allowed];
  const ungrounded: string[] = [];
  for (const token of numbersIn(text)) {
    const ok = token.readings.some((r) =>
      values.some(
        (a) =>
          Math.abs(a - r.value) <= r.tolerance + 1e-9 ||
          (Math.abs(a) >= 1000 && Math.abs(a - r.value) / Math.abs(a) <= 0.005),
      ),
    );
    if (!ok) ungrounded.push(token.raw);
  }
  return { ok: ungrounded.length === 0, ungrounded };
}

// ---------------------------------------------------------------------------
// El resumen sin modelo, y cómo se pinta
// ---------------------------------------------------------------------------

const factBy = (facts: PulseFact[], key: string) => facts.find((f) => f.key === key);

/** «Cartera vencida subió…» → «cartera vencida subió…», para el medio de una frase. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase('es-CO') + text.slice(1);
}

/**
 * Tres frases armadas SÓLO con las cifras: lo que se escribe cuando el modelo
 * no contesta o inventa dos veces. Menos elegante, nunca falso.
 */
export function fallbackSummary(facts: PulseFact[]): string[] {
  const bullets: string[] = [];

  const yesterday = facts.filter(
    (f) => f.key.endsWith('.ayer') && f.value !== null && f.value !== 0,
  );
  const fresh = factBy(facts, 'cartera.vencio_ayer');
  // Primero lo que cambió contra el último día guardado (pulse_snapshots): su
  // etiqueta ya es la frase entera, con las dos cifras y la diferencia.
  const changes = facts
    .filter((f) => f.key.endsWith('.delta') && f.value !== null && f.value !== 0)
    .map((f) => lowerFirst(f.label));
  changes.push(
    ...yesterday.map((f) => `${f.label.replace(/: lo de ayer.*$/, '')} ayer: ${f.display}`),
  );
  if (fresh && (fresh.value ?? 0) > 0)
    changes.push(
      `se vencieron ${fresh.display} ${fresh.value === 1 ? 'factura' : 'facturas'} (${factBy(facts, 'cartera.vencio_ayer_saldo')?.display ?? ''})`,
    );
  bullets.push(
    changes.length
      ? `**Frente a ayer:** ${changes.slice(0, 3).join('; ')}.`
      : '**Frente a ayer:** no hubo movimientos nuevos en las fuentes de esta vista.',
  );

  const attention: string[] = [];
  const overdue = factBy(facts, 'cartera_vencida');
  if (overdue && (overdue.value ?? 0) > 0) attention.push(`cartera vencida por ${overdue.display}`);
  const debtor = factBy(facts, 'top_deudores.0');
  if (debtor) attention.push(`quien más debe: ${debtor.display}`);
  for (const key of ['pendientes', 'compromisos_vencidos', 'vencen_semana', 'procesos_fallando']) {
    const f = factBy(facts, key);
    if (f && (f.value ?? 0) > 0) attention.push(`${f.label.toLowerCase()}: ${f.display}`);
  }
  bullets.push(
    attention.length
      ? `**Para hoy:** ${attention.slice(0, 3).join('; ')}.`
      : '**Para hoy:** nada vencido ni pendiente en las cifras de esta vista.',
  );

  const month: string[] = [];
  for (const key of ['ventas_mes', 'pagos_mes', 'recuperado']) {
    const f = factBy(facts, key);
    if (!f || f.value === null) continue;
    const prev = factBy(facts, `${key}.anterior`);
    month.push(
      `${f.label.toLowerCase()} ${f.display}${prev ? ` (${prev.label.replace(/^[^(]*\(|\)$/g, '')}: ${prev.display})` : ''}`,
    );
  }
  const goals = factBy(facts, 'metas_cumplidas');
  if (goals) month.push(`metas cumplidas: ${goals.display}`);
  bullets.push(
    month.length
      ? `**El mes:** ${month.slice(0, 3).join('; ')}.`
      : '**El mes:** todavía no hay cifras del mes en esta vista.',
  );
  return bullets;
}

const WEEKDAY = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH = [
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

/** «jueves 2 de octubre». */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay();
  return `${WEEKDAY[weekday]} ${d} de ${MONTH[(m ?? 1) - 1]}`;
}

/** El bloque de texto entero, con la fecha y de dónde salen las cifras. */
export function renderSummary(
  day: string,
  bullets: string[],
  opts: { fallback?: boolean } = {},
): string {
  const body = bullets
    .map((b) => b.replace(/[ \t\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .map((b) => `- ${b.slice(0, 600)}`)
    .join('\n');
  const foot = opts.fallback
    ? `_Armado por Cortex el ${longDay(day)} sólo con las cifras de esta vista. Las versiones anteriores quedan en el historial._`
    : `_Escrito por Cortex el ${longDay(day)} con las cifras de esta vista. Las versiones anteriores quedan en el historial._`;
  return `### Resumen de hoy · ${longDay(day)}\n\n${body}\n\n${foot}`.slice(0, 4000);
}

/** El spec con el texto del resumen puesto; si el bloque no existe, va primero. */
export function withSummary(spec: ViewSpec, blockId: string, markdown: string): ViewSpec {
  return withTextBlock(spec, blockId, markdown);
}

/**
 * El spec con un bloque de texto puesto. Si no existe, va justo después de
 * `after` (la revisión semanal debajo del resumen de hoy) o, sin él, primero.
 */
export function withTextBlock(
  spec: ViewSpec,
  blockId: string,
  markdown: string,
  opts: { after?: string } = {},
): ViewSpec {
  const exists = spec.blocks.some((b) => b.id === blockId && b.type === 'text');
  if (exists)
    return {
      ...spec,
      blocks: spec.blocks.map((b) =>
        b.id === blockId && b.type === 'text' ? { ...b, markdown } : b,
      ),
    };
  const block: ViewBlock = { id: blockId, type: 'text', width: 'full', markdown };
  const at = opts.after ? spec.blocks.findIndex((b) => b.id === opts.after) + 1 : 0;
  const blocks = [...spec.blocks.slice(0, at), block, ...spec.blocks.slice(at)].slice(0, 24);
  return { ...spec, blocks };
}

// ---------------------------------------------------------------------------
// La rutina diaria
// ---------------------------------------------------------------------------

const DAY_NAME = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** [1,2,3,4,5] → «1-5»; los siete → «*»; lo demás, la lista. */
export function cronWeekdays(days: readonly number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (set.length === 0 || set.length === 7) return '*';
  const contiguous = set.every((d, i) => i === 0 || d === (set[i - 1] as number) + 1);
  if (contiguous && set.length > 2) return `${set[0]}-${set[set.length - 1]}`;
  return set.join(',');
}

/** «de lunes a viernes», «todos los días», «lunes, miércoles y viernes». */
export function weekdaysPhrase(days: readonly number[]): string {
  const cron = cronWeekdays(days);
  if (cron === '*') return 'todos los días';
  if (cron === '1-5') return 'de lunes a viernes';
  if (cron === '1-6') return 'de lunes a sábado';
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => DAY_NAME[d] as string);
  return names.length === 1
    ? `los ${names[0]}`
    : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

/** «7:00 a. m.», como se dice en Colombia. */
export function clockPhrase(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}

export interface PulseRoutineOptions {
  hour?: number;
  minute?: number;
  weekdays?: readonly number[];
  timezone?: string;
  notifyEmail?: boolean;
}

/**
 * La fila de `scheduled_jobs` de la rutina del resumen. Es una rutina de
 * HERRAMIENTA (`kind: 'tool'`), no de agente: corre `views.refresh_summary`
 * con la vista fija, sin un turno entero del modelo que pudiera hacer otra
 * cosa. El resultado (el resumen) llega a la conversación de la rutina y, si
 * se pidió, por correo.
 */
export function pulseRoutineRow(
  view: { id: string; name: string },
  who: { userId: string; agentId: string },
  opts: PulseRoutineOptions = {},
) {
  const hour = opts.hour ?? PULSE_DEFAULT_HOUR;
  const minute = opts.minute ?? 0;
  const weekdays = opts.weekdays?.length ? opts.weekdays : PULSE_DEFAULT_WEEKDAYS;
  return {
    user_id: who.userId,
    agent_id: who.agentId,
    name: `Resumen diario: ${view.name}`.slice(0, 120),
    kind: 'tool' as const,
    tool_id: 'views.refresh_summary',
    tool_input: { view: view.id },
    instruction: null,
    schedule_kind: 'cron' as const,
    cron: `${minute} ${hour} * * ${cronWeekdays(weekdays)}`,
    timezone: opts.timezone ?? PULSE_DEFAULT_TIMEZONE,
    run_at: null,
    allow_unattended_writes: false,
    notify_conversation: true,
    notify_email: opts.notifyEmail ?? false,
  };
}
