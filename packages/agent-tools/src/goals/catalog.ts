import type { SupabaseClient } from '@supabase/supabase-js';
// Importado del módulo hoja y no del barril del paquete: este archivo se
// alcanza desde el propio barril, y dar la vuelta por él sería un ciclo.
import { listCommitments } from '../commitments/store';
import { receivables } from '../payments/store';
import {
  type MetricDirection,
  type MetricUnit,
  type Period,
  bogotaDayAfter,
  bogotaDayStart,
  bogotaToday,
  daysBetween,
  formatValue,
  withinPeriod,
} from './shape';

/**
 * QUÉ SE PUEDE MEDIR EN ESTE PRODUCTO, Y —MÁS IMPORTANTE— QUÉ PUEDE MEDIR ESTE
 * ESPACIO DE TRABAJO HOY.
 *
 * ===========================================================================
 * LA REGLA
 * ===========================================================================
 * Una meta sin datos que la alimenten es una casilla vacía, y una casilla vacía
 * resta más confianza de la que suma. Un tablero con seis metas de las cuales
 * cuatro dicen «—» no comunica «faltan datos»: comunica «esto no funciona», y
 * contagia esa lectura a las dos que sí traen número.
 *
 * Eso NO se arregla con un mejor mensaje de estado vacío. Se arregla no dejando
 * crear la meta. Por eso cada métrica de aquí declara `available(db)`, un
 * predicado que consulta ESTE espacio de trabajo antes de ofrecerse — y cuando
 * dice que no, dice por qué y qué hacer al respecto:
 *
 *   «Para medir la cartera hace falta saber qué se ha pagado. Conecta Siigo o
 *    el banco, o registra pagos a mano en Pagos.»
 *
 * Esa frase es la mitad útil del rechazo. Un selector que sólo esconde la
 * opción deja a alguien buscando una función que existe.
 *
 * ===========================================================================
 * POR QUÉ UN REGISTRO CERRADO EN TYPESCRIPT
 * ===========================================================================
 * La forma es la de `DOCUMENT_TYPES` (documents/types.ts) y
 * `GENERATED_REPORT_KINDS` (reports/): la migración 0101 guarda `metric_key`
 * como un slug con un CHECK de forma, no de valor, así que añadir una métrica
 * es un objeto más en esta lista y no una migración más un despliegue más un
 * backfill. Y la lista tiene que vivir en código, no en una tabla, porque la
 * parte que la hace útil —`available(db)`— es una CONSULTA, y una consulta no
 * cabe en una fila de configuración.
 *
 * ===========================================================================
 * LO QUE NO ESTÁ, Y NO ESTÁ A PROPÓSITO
 * ===========================================================================
 *   MÁRGENES, COSTOS, RENTABILIDAD. No hay un solo dato de costo en cien
 *   migraciones. Una meta de margen sería una casilla vacía en TODOS los
 *   espacios de trabajo, para siempre.
 *
 *   SLA DE ENTREGA. No hay tabla de envíos. Las guías se leen como documento;
 *   nadie registra cuándo llegaron.
 *
 *   VENTAS Y PIPELINE. `hubspot` y `growth` son APIs sobre sistemas ajenos, no
 *   tablas de este esquema. Una meta sobre ellos sale vacía en cualquier
 *   espacio sin HubSpot conectado — que es exactamente la casilla que esto
 *   evita. El día que exista un espejo local de esos datos, será una entrada
 *   más aquí con su propio `available(db)`.
 */

// ---------------------------------------------------------------------------
// La forma de una métrica
// ---------------------------------------------------------------------------

export interface MetricAvailability {
  available: boolean;
  /**
   * En español, y dice QUÉ HACER. Nulo únicamente cuando está disponible.
   * Es lo que el selector enseña debajo de la opción apagada.
   */
  reason: string | null;
}

/** De dónde sale la cifra. Se congela en cada lectura, como en la 0079. */
export interface MetricSourceSpec {
  /** Se guarda en `goal_readings.source_id`. Estable: se cita. */
  id: string;
  /** El sistema, en español. */
  system: string;
  /** Qué franja exactamente. */
  detail: string;
}

export interface MetricMeasurement {
  /** El número. Nulo = no había nada que medir; NO es un incumplimiento. */
  value: number | null;
  /** Ya formateado para Colombia; se guarda formateado. */
  display: string;
  /** La aritmética en una frase, para rehacerla a mano. */
  method: string;
  /** Sobre cuántas filas está hecha la cifra. */
  sampleSize: number;
}

export interface MetricSpec {
  /** Slug guardado en `goals.metric_key`. */
  key: string;
  label: string;
  /** Una línea para el selector: qué mide, en las palabras del negocio. */
  blurb: string;
  unit: MetricUnit;
  direction: MetricDirection;
  /** Lo que la pantalla propone al elegirla. Una sugerencia, no una regla. */
  suggestedTarget: number;
  source: MetricSourceSpec;
  /** ¿Puede ESTE espacio de trabajo calcularla hoy? Ver la cabecera. */
  available(db: SupabaseClient): Promise<MetricAvailability>;
  /** El número del período, ya cerrado. */
  measure(db: SupabaseClient, period: Period): Promise<MetricMeasurement>;
}

const YES: MetricAvailability = { available: true, reason: null };
const no = (reason: string): MetricAvailability => ({ available: false, reason });

/**
 * «¿Hay al menos una fila así?», comprobando el error.
 *
 * Sin la comprobación, una migración sin aplicar haría que TODAS las métricas
 * se declararan no disponibles en silencio, y el selector diría que este
 * espacio no puede medir nada — que es la peor forma de estar equivocado, y la
 * misma que `lib/supabase/read.ts` existe para impedir en la web.
 */
async function exists(
  db: SupabaseClient,
  table: string,
  refine: (q: ReturnType<SupabaseClient['from']>) => unknown = (q) => q,
): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
  const query = refine(db.from(table).select('id') as any) as any;
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

function windowOf(period: Period): { from: string; to: string } {
  return { from: bogotaDayStart(period.start), to: bogotaDayAfter(period.end) };
}

/** El día colombiano de un instante. Ver la nota de `commitmentsOnTime`. */
function bogotaDayOf(instant: string | null | undefined): string | null {
  if (!instant) return null;
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? null : bogotaToday(parsed);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

const NOTHING = (period: Period, what: string): MetricMeasurement => ({
  value: null,
  display: '—',
  method: `No hubo ${what} entre el ${period.start} y el ${period.end}, así que no hay nada que medir en este período. Un hueco no es un incumplimiento.`,
  sampleSize: 0,
});

// ---------------------------------------------------------------------------
// 1 y 2. Compromisos cerrados a tiempo
// ---------------------------------------------------------------------------

/**
 * El trozo con más probabilidad de estar mal en todo el módulo, aislado aquí.
 *
 * `met_at` es un INSTANTE y `due_on` es un DÍA COLOMBIANO. Compararlos sin
 * traducir marca tarde todas las entregas de la noche —entre las 19:00 y la
 * medianoche en Bogotá la fecha UTC ya es la de mañana—, en silencio, para
 * siempre. Así que el instante pasa por `bogotaToday(at)` antes de tocar
 * `due_on`, y esa es la única comparación que hay.
 *
 * Y la consulta usa `metAfter`, no `dueBefore`. `listCommitments` ordena por
 * `due_on` ascendente y corta con `limit`: preguntada por `states:['met']` sin
 * `metAfter` devuelve los quinientos MÁS ANTIGUOS y los presenta como
 * recientes. No falla; contesta con seguridad usando filas de hace dos años,
 * que es la peor forma en que una consulta puede estar equivocada.
 */
async function commitmentsOnTime(
  db: SupabaseClient,
  period: Period,
  opts: { internal: boolean },
): Promise<MetricMeasurement> {
  const rows = await listCommitments(db, {
    states: ['met'],
    reviewState: 'confirmed',
    metAfter: bogotaDayStart(period.start),
    ...(opts.internal ? { kind: 'internal' as const } : { excludeKinds: ['internal' as const] }),
    limit: 2000,
  });

  const closed = rows
    .map((row) => ({ row, day: bogotaDayOf(row.met_at) }))
    .filter((item): item is { row: (typeof rows)[number]; day: string } =>
      item.day == null ? false : withinPeriod(period, item.day),
    );

  if (closed.length === 0) {
    return NOTHING(period, opts.internal ? 'ninguna promesa interna cerrada' : 'ningún cierre');
  }

  const onTime = closed.filter((item) => item.day <= item.row.due_on).length;
  const value = rate(onTime, closed.length);
  const what = opts.internal ? 'promesa(s) interna(s)' : 'vencimiento(s)';
  return {
    value,
    display: formatValue(value, 'percent'),
    sampleSize: closed.length,
    method: `${onTime} de ${closed.length} ${what} que se cerraron entre el ${period.start} y el ${period.end} se cerraron en su fecha o antes. El instante de cierre (met_at) se convierte al día de calendario en Bogotá antes de compararlo con la fecha límite, para que una entrega de las 20:00 cuente como del mismo día y no del siguiente.`,
  };
}

// ---------------------------------------------------------------------------
// El catálogo
// ---------------------------------------------------------------------------

export const METRIC_CATALOG: readonly MetricSpec[] = [
  // -------------------------------------------------------------------------
  {
    key: 'commitments_on_time',
    label: 'Vencimientos cumplidos a tiempo',
    blurb:
      'De los SOAT, contratos, pólizas y trámites que se cerraron en el período, cuántos se cerraron en su fecha o antes.',
    unit: 'percent',
    direction: 'higher_is_better',
    suggestedTarget: 95,
    source: {
      id: 'commitments',
      system: 'Compromisos (Cortex)',
      detail: 'Compromisos confirmados, sin las promesas internas, cerrados dentro del período',
    },
    async available(db) {
      const any = await exists(db, 'commitments', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any)
          .eq('review_state', 'confirmed')
          .not('kind', 'in', '(internal)'),
      );
      return any
        ? YES
        : no(
            'Todavía no hay ningún vencimiento confirmado. Anota un SOAT, un contrato o una póliza en Compromisos —o deja que Cortex los lea de un documento y confírmalos— y esta meta se podrá medir.',
          );
    },
    measure: (db, period) => commitmentsOnTime(db, period, { internal: false }),
  },

  // -------------------------------------------------------------------------
  {
    key: 'internal_promises_on_time',
    label: 'Promesas internas cumplidas a tiempo',
    blurb:
      'De lo que la gente de la casa se comprometió a entregar, cuánto se entregó en la fecha prometida. La meta más de gerente que da este producto.',
    unit: 'percent',
    direction: 'higher_is_better',
    suggestedTarget: 90,
    source: {
      id: 'commitments_internal',
      system: 'Compromisos (Cortex)',
      detail: "Compromisos confirmados de kind='internal' cerrados dentro del período",
    },
    async available(db) {
      const any = await exists(db, 'commitments', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any)
          .eq('review_state', 'confirmed')
          .eq('kind', 'internal'),
      );
      return any
        ? YES
        : no(
            'Nadie ha registrado todavía una promesa interna. Dile a Cortex «Ana quedó de mandar el informe el viernes» —o anótala en Compromisos— y a partir de ahí se puede medir quién entrega cuando dice.',
          );
    },
    measure: (db, period) => commitmentsOnTime(db, period, { internal: true }),
  },

  // -------------------------------------------------------------------------
  {
    key: 'fleet_current',
    label: 'Flota al día',
    blurb: 'Qué porcentaje de los vehículos activos tenía SOAT y tecnomecánica vigentes al cierre.',
    unit: 'percent',
    direction: 'higher_is_better',
    suggestedTarget: 100,
    source: {
      id: 'vehicles_runt',
      system: 'Vehículos (RUNT, leído por Cortex)',
      detail: 'Vehículos no archivados, con las fechas que devolvió RUNT la última vez',
    },
    async available(db) {
      const any = await exists(db, 'vehicles', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any).eq('archived', false),
      );
      return any
        ? YES
        : no(
            'No hay ningún vehículo registrado. Dale una placa a Cortex y él consulta RUNT: con eso ya sabe cuándo vencen el SOAT y la tecnomecánica de cada uno.',
          );
    },
    async measure(db, period) {
      const { data, error } = await db
        .from('vehicles')
        .select('id, plate, soat_expires_at, rtm_expires_at, last_runt_sync')
        .eq('archived', false)
        .limit(500);
      if (error) throw error;
      const fleet = (data ?? []) as Array<{
        plate: string;
        soat_expires_at: string | null;
        rtm_expires_at: string | null;
        last_runt_sync: string | null;
      }>;
      if (fleet.length === 0) return NOTHING(period, 'ningún vehículo activo');

      const current = fleet.filter(
        (v) =>
          v.soat_expires_at != null &&
          v.rtm_expires_at != null &&
          v.soat_expires_at >= period.end &&
          v.rtm_expires_at >= period.end,
      ).length;
      const value = rate(current, fleet.length);

      // CUÁNDO SE LEYÓ RUNT, dicho en la frase. Una flota «al 100%» calculada
      // sobre una lectura de hace cinco meses no es una flota al día: es una
      // fotografía vieja, y quien lee la cifra tiene derecho a saberlo.
      const reads = fleet.map((v) => v.last_runt_sync).filter(Boolean) as string[];
      const oldest = reads.length === fleet.length ? reads.sort()[0] : null;
      const staleness =
        reads.length === 0
          ? 'Ningún vehículo se ha consultado nunca en RUNT, así que estas fechas son las que alguien escribió a mano.'
          : oldest
            ? `La consulta a RUNT más antigua de la flota es del ${oldest.slice(0, 10)}.`
            : `${fleet.length - reads.length} vehículo(s) no se han consultado nunca en RUNT.`;

      return {
        value,
        display: formatValue(value, 'percent'),
        sampleSize: fleet.length,
        method:
          `${current} de ${fleet.length} vehículo(s) activo(s) tenían SOAT y tecnomecánica con ` +
          `vencimiento posterior al ${period.end}. Un vehículo sin fecha registrada cuenta como ` +
          `no vigente: no saberlo no es lo mismo que estar al día. ${staleness}`,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'review_backlog',
    label: 'Documentos esperando revisión',
    blurb:
      'Cuántas lecturas de documentos siguen sin que nadie las confirme. Nada sin revisar entra en ninguna cifra de dinero, así que esta pila es la que las bloquea todas.',
    unit: 'count',
    direction: 'lower_is_better',
    suggestedTarget: 10,
    source: {
      id: 'document_extractions_pending',
      system: 'Documentos (Brain Knowledge)',
      detail: "Lecturas con review_state='pending' en el momento de la medición",
    },
    async available(db) {
      const any = await exists(db, 'document_extractions');
      return any
        ? YES
        : no(
            'Cortex todavía no ha leído ningún documento. Sube una factura o una guía a Brain Knowledge y aparecerá una cola de revisión que medir.',
          );
    },
    async measure(db, period) {
      const { data, error } = await db
        .from('document_extractions')
        .select('id, created_at')
        .eq('review_state', 'pending')
        .order('created_at', { ascending: true })
        .limit(1000);
      if (error) throw error;
      const pending = (data ?? []) as Array<{ created_at: string }>;
      const value = pending.length;

      const oldestDay = bogotaDayOf(pending[0]?.created_at);
      const age = oldestDay == null ? null : daysBetween(oldestDay, period.end);
      const tail =
        age == null
          ? 'No queda ninguna esperando.'
          : `La más antigua lleva ${Math.max(age, 0)} día(s) esperando.`;

      return {
        value,
        display: formatValue(value, 'count'),
        sampleSize: value,
        method: `Lecturas de documentos con revisión pendiente al cerrar ${period.label}. Es una foto de una pila, no una suma del período: se cuenta lo que había sin revisar al terminar el ${period.end}. ${tail}`,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'actions_no_reply',
    label: 'Acciones sin respuesta',
    blurb:
      'Correos que Cortex mandó con tu aprobación y que nadie contestó dentro de la ventana de seguimiento. El punto de un cobro es que paguen, no que salga el correo.',
    unit: 'count',
    direction: 'lower_is_better',
    suggestedTarget: 0,
    source: {
      id: 'actions_outcome',
      system: 'Acciones (Cortex)',
      detail: "Acciones ejecutadas en el período cuyo outcome quedó en 'no_reply'",
    },
    async available(db) {
      const any = await exists(db, 'actions', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any).not('executed_at', 'is', null),
      );
      return any
        ? YES
        : no(
            'Cortex todavía no ha ejecutado ninguna acción aprobada. En cuanto salga el primer cobro o el primer recordatorio, se puede medir cuántos se quedan sin respuesta.',
          );
    },
    async measure(db, period) {
      const { from, to } = windowOf(period);
      const [executed, silent] = await Promise.all([
        db.from('actions').select('id').gte('executed_at', from).lt('executed_at', to).limit(1000),
        db
          .from('actions')
          .select('id')
          .eq('outcome', 'no_reply')
          .gte('executed_at', from)
          .lt('executed_at', to)
          .limit(1000),
      ]);
      if (executed.error) throw executed.error;
      if (silent.error) throw silent.error;

      const total = ((executed.data ?? []) as unknown[]).length;
      if (total === 0) return NOTHING(period, 'ninguna acción ejecutada');
      const value = ((silent.data ?? []) as unknown[]).length;

      return {
        value,
        display: formatValue(value, 'count'),
        sampleSize: total,
        method: `${value} de ${total} acción(es) ejecutada(s) entre el ${period.start} y el ${period.end} cerraron su ventana de seguimiento sin que nadie contestara. Una acción que todavía está esperando respuesta no cuenta aquí: cuenta cuando el barrido declara el silencio.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'extraction_quality',
    label: 'Calidad de lectura',
    blurb:
      'De los campos que alguien revisó, qué porcentaje tuvo que corregir o tirar. Es la única señal honesta de dónde falla el extractor.',
    unit: 'percent',
    direction: 'lower_is_better',
    suggestedTarget: 10,
    source: {
      id: 'document_field_corrections',
      system: 'Documentos (Brain Knowledge)',
      detail: 'Correcciones frente a campos revisados dentro del período',
    },
    async available(db) {
      const any = await exists(db, 'document_fields', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any).in('review_state', ['confirmed', 'rejected']),
      );
      return any
        ? YES
        : no(
            'Nadie ha revisado todavía ningún campo leído de un documento. La tasa de corrección se calcula sobre lo revisado, así que hace falta al menos una revisión.',
          );
    },
    async measure(db, period) {
      const { from, to } = windowOf(period);
      const [confirmed, rejected, corrections] = await Promise.all([
        db
          .from('document_fields')
          .select('id')
          .eq('review_state', 'confirmed')
          .gte('confirmed_at', from)
          .lt('confirmed_at', to)
          .limit(2000),
        db
          .from('document_fields')
          .select('id')
          .eq('review_state', 'rejected')
          .gte('rejected_at', from)
          .lt('rejected_at', to)
          .limit(2000),
        db
          .from('document_field_corrections')
          .select('id')
          .gte('corrected_at', from)
          .lt('corrected_at', to)
          .limit(2000),
      ]);
      if (confirmed.error) throw confirmed.error;
      if (rejected.error) throw rejected.error;
      if (corrections.error) throw corrections.error;

      const reviewed =
        ((confirmed.data ?? []) as unknown[]).length + ((rejected.data ?? []) as unknown[]).length;
      if (reviewed === 0) return NOTHING(period, 'ningún campo revisado');

      const touched = ((corrections.data ?? []) as unknown[]).length;
      const value = rate(touched, reviewed);
      return {
        value,
        display: formatValue(value, 'percent'),
        sampleSize: reviewed,
        method: `${touched} corrección(es) o rechazo(s) sobre ${reviewed} campo(s) revisado(s) entre el ${period.start} y el ${period.end}. El denominador son los campos que una persona confirmó o rechazó en el período; el numerador, las filas que quedaron en el registro de correcciones. Un campo confirmado sin tocar nada no suma al numerador.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // LA QUE PIDIÓ EL DUEÑO, Y EL CASO DE USO PRINCIPAL DE available().
  {
    key: 'receivables_days',
    label: 'Días de cartera',
    blurb:
      'La edad media del dinero que está por cobrar, ponderada por importe. «La cartera no debe pasar de 45 días.»',
    unit: 'days',
    direction: 'lower_is_better',
    suggestedTarget: 45,
    source: {
      id: 'receivables',
      system: 'Pagos y Documentos (Cortex)',
      detail: 'Facturas confirmadas con saldo, menos los pagos contados, al cierre del período',
    },
    async available(db) {
      // EL ORDEN IMPORTA: se nombra primero el hueco que casi siempre es el
      // real. Un espacio que acaba de empezar tiene facturas leídas y ni un
      // solo pago, y decirle «te faltan facturas» lo mandaría al sitio
      // equivocado.
      const anyPayment = await exists(db, 'payments', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any).in('state', ['reported', 'confirmed']),
      );
      if (!anyPayment) {
        return no(
          'Para medir la cartera necesito saber qué se ha pagado, y aquí todavía no hay ni un pago registrado. Conecta Siigo o el banco, o empieza a anotar los pagos a mano en Pagos. Con facturas y sin pagos, «cartera» sería el total facturado, que no dice nada.',
        );
      }
      const anyInvoice = await exists(db, 'document_extractions', (q) =>
        // biome-ignore lint/suspicious/noExplicitAny: la cadena de PostgREST no es genérica
        (q as any)
          .eq('doc_type', 'invoice')
          .eq('review_state', 'confirmed'),
      );
      return anyInvoice
        ? YES
        : no(
            'Hay pagos pero ninguna factura confirmada. La cartera se calcula sólo sobre facturas que una persona revisó: confirma las que estén esperando en Documentos y la cifra aparece.',
          );
    },
    async measure(db, period) {
      const result = await receivables(db, { today: period.end });
      // La moneda con más saldo. NUNCA se suman monedas: 3.000 USD más
      // 12.000.000 COP son 12.003.000 de nada (0098).
      const main = result.byCurrency[0];
      if (!main || main.ageDays == null) {
        return {
          value: null,
          display: '—',
          sampleSize: result.confirmedInvoices,
          method:
            `Al ${period.end} no había ninguna factura confirmada con saldo pendiente y fecha ` +
            `de emisión, así que no hay edad de cartera que calcular. ${result.sentence}`,
        };
      }
      return {
        value: main.ageDays,
        display: formatValue(main.ageDays, 'days'),
        sampleSize: main.openInvoices,
        method: `Edad media ponderada por dinero de ${main.openInvoices} factura(s) abierta(s) en ${main.currency} al ${period.end}: cada saldo pesa según su importe, contando desde su fecha de emisión. Calculado sobre ${result.confirmedInvoices} factura(s) confirmada(s); ${result.pendingExcluded} sin revisar y ${result.disputedPayments} pago(s) en disputa no entran en la cifra.`,
      };
    },
  },
];

const BY_KEY = new Map(METRIC_CATALOG.map((m) => [m.key, m]));

export function metricByKey(key: string): MetricSpec | null {
  return BY_KEY.get(key) ?? null;
}

export class UnknownMetricError extends Error {
  constructor(key: string) {
    super(
      `No existe una métrica llamada "${key}". Las que hay están en METRIC_CATALOG (packages/agent-tools/src/goals/catalog.ts): ${METRIC_CATALOG.map((m) => m.key).join(', ')}.`,
    );
    this.name = 'UnknownMetricError';
  }
}

export class MetricUnavailableError extends Error {
  constructor(
    readonly metricKey: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'MetricUnavailableError';
  }
}

export interface MetricOffer {
  spec: MetricSpec;
  available: boolean;
  reason: string | null;
}

/**
 * EL SELECTOR, DECIDIDO EN EL SERVIDOR.
 *
 * Devuelve el catálogo entero con el veredicto de cada métrica para ESTE
 * espacio, disponibles primero. La pantalla enseña las de abajo apagadas y con
 * su motivo, porque esconderlas del todo dejaría a alguien buscando una función
 * que sí existe — y `writeGoal()` vuelve a comprobar lo mismo, que es donde la
 * regla se hace cumplir de verdad: un formulario manipulado no crea una meta
 * que este espacio no sabe calcular.
 *
 * Los predicados se ejecutan en paralelo y son todos consultas de una fila.
 */
export async function offerMetrics(db: SupabaseClient): Promise<MetricOffer[]> {
  const offers = await Promise.all(
    METRIC_CATALOG.map(async (spec): Promise<MetricOffer> => {
      const verdict = await spec.available(db);
      return { spec, available: verdict.available, reason: verdict.reason };
    }),
  );
  return offers.sort((a, b) => Number(b.available) - Number(a.available));
}
