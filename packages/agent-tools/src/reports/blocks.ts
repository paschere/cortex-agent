import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
// Desde los módulos hoja y no desde el barril de `commitments`, por la misma
// razón que `commitments/store.ts` documenta para sí mismo: el barril de
// commitments registra sus herramientas contra el barril raíz, y el barril raíz
// carga `reports/`, así que pasar por ahí desde aquí es un ciclo — y un ciclo
// que no falla al compilar, sino en tiempo de carga y sólo a veces, según qué
// archivo entró primero.
import {
  type CommitmentKind,
  type CommitmentRow,
  KIND_LABEL,
  addDays,
  daysUntilDue,
  deriveState,
} from '../commitments/shape';
import { listCommitments } from '../commitments/store';
import type { Figure, ReportSection, ReportSource, Tone } from './document';
import { clip, cop, count, longDate, monthTick, shortDate, whenPhrase } from './format';

/**
 * LOS BLOQUES: de qué está hecho un informe «de lo que sea».
 *
 * ===========================================================================
 * EL PROBLEMA QUE RESUELVE ESTE ARCHIVO
 * ===========================================================================
 * Hasta hoy un informe nuevo costaba dos cosas: una migración (para ensanchar
 * el CHECK de `reports.kind`, pagada ya tres veces — 0088, 0100, 0103) y unas
 * trescientas líneas de constructor a medida en `build.ts`. Con ese precio,
 * «que se puedan pedir informes de lo que sea» no cabe: la lista de informes
 * crece a mano, un informe cada vez.
 *
 * La salida fácil es quitar el CHECK y dejar que el modelo redacte el informe.
 * Es la peor de todas y `document.ts` ya explica por qué en tres párrafos: un
 * modelo que escribe `<td>1.240.000</td>` se convirtió, en ese instante, en la
 * fuente de la cifra. `apps/web/app/(app)/company/_lib/gather.ts` llegó a la
 * misma conclusión por el otro lado — «si el chip dice "de tu contrato" y la
 * frase la redactó un modelo leyendo el contrato, la afirmación es falsa justo
 * donde nadie puede comprobarla».
 *
 * Así que la pieza que se generaliza NO es quién escribe las cifras. Es de
 * cuántas piezas se puede armar un informe.
 *
 * ===========================================================================
 * QUÉ ES UN BLOQUE
 * ===========================================================================
 * Una pregunta que nuestro código sabe contestar contra los datos de la
 * empresa, con sus parámetros. Un bloque:
 *
 *   - CONSULTA. Es código nuestro y una consulta de verdad, igual que los tres
 *     constructores de `build.ts`. Nadie le pasa cifras: las lee.
 *   - DECLARA SU FUENTE. Devuelve su propia `ReportSource` con el sistema, el
 *     corte exacto, el instante en que leyó y cuántas filas volvieron. El
 *     instante y el conteo los pone el armazón, no el bloque, para que ningún
 *     bloque pueda afirmar que sus datos son más frescos de lo que son.
 *   - CITA CADA CIFRA. Todo `Figure` que emite lleva `sourceId` y `method`, y
 *     `validateDocument` rechaza el documento entero si una cita no resuelve.
 *
 * El modelo elige QUÉ bloques y con QUÉ parámetros. Eso es exactamente la
 * misma superficie que ya tenía con `reports.generate` (un kind y unos
 * parámetros), sólo que componible. No gana ni un milímetro de influencia sobre
 * los números.
 *
 * ===========================================================================
 * POR QUÉ UN REGISTRO Y NO UN CHECK MÁS ANCHO
 * ===========================================================================
 * Un bloque nuevo es una entrada en `BLOCKS`: una función, un esquema de
 * parámetros y ninguna migración. Un informe nuevo es una combinación de
 * bloques: ninguna función y ninguna migración. Eso es lo que hace que «de lo
 * que sea» deje de costar una lista que crece a mano.
 *
 * Lo que sigue cerrado es el registro: el modelo escoge de una unión
 * discriminada que el compilador conoce, no de un texto libre. Una petición que
 * ningún bloque contesta se rechaza diciendo qué falta, en vez de forzar el
 * bloque más parecido — que es la versión de este módulo del «si lo que piden
 * no es ninguno de los tres informes, dilo» que ya trae `reports.generate`.
 *
 * ===========================================================================
 * `restricted`: LO QUE NO SALE POR UN ENLACE PÚBLICO
 * ===========================================================================
 * Un informe a la medida se comparte con el mismo enlace sin contraseña que
 * todos los demás (`store.ts`), y ahí «de lo que sea» se vuelve una superficie
 * de fuga: hasta hoy los tres informes hablaban de papeles y de terceros, y
 * ninguno nombraba a un empleado. Un bloque que sí lo hace se marca
 * `restricted: true`, y `shareReport` se niega a acuñar un enlace para un
 * informe que declare una fuente restringida. Adentro se ve entero; afuera no
 * sale. La decisión se toma en el bloque, que es quien sabe qué lee, y no en
 * quien pulsa «compartir», que es quien no lo sabe.
 */

/** Ninguna lectura sin techo; un informe no puede tumbar una página. */
const ROW_CAP = 1000;

/** Qué recibe un bloque para construirse. */
export interface BlockBuildInput<P> {
  db: SupabaseClient;
  params: P;
  /** Hoy en Bogotá, `YYYY-MM-DD`. Inyectado para que los bloques sean probables. */
  today: string;
  /**
   * El id que llevarán las fuentes de este bloque dentro del documento.
   *
   * Lo asigna el armazón y no el bloque, porque el mismo bloque puede aparecer
   * dos veces en un informe con parámetros distintos («los próximos 30 días» y
   * «los próximos 90») y dos fuentes con el mismo id serían dos notas al pie
   * que se pisan: la segunda cifra citaría el corte de la primera.
   */
  slot: string;
}

/** Qué devuelve un bloque. El instante y el conteo los pone el armazón. */
export interface BlockOutput {
  /**
   * Las fuentes que este bloque leyó. `readAt` NO viene aquí: lo estampa
   * `runBlock` con el instante del informe, para que un bloque no pueda decir
   * que sus datos son de un momento distinto del que son.
   */
  sources: Array<Omit<ReportSource, 'readAt'>>;
  sections: ReportSection[];
  /** Salvedades que suben a las notas del documento. */
  notes?: string[];
}

export interface ReportBlock<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  /** Cómo se llama en la pantalla y en el encabezado de su sección. */
  label: string;
  /** La pregunta que contesta, para que el modelo sepa cuándo usarlo. */
  question: string;
  params: S;
  /**
   * True cuando lo que lee nombra a alguien de la empresa. Un informe con un
   * bloque restringido no se puede compartir por enlace público.
   */
  restricted: boolean;
  build(input: BlockBuildInput<z.infer<S>>): Promise<BlockOutput>;
}

// ---------------------------------------------------------------------------
// Constructores pequeños — la única forma de fabricar una cifra
// ---------------------------------------------------------------------------

/**
 * `sourceId` y `method` son posicionales y obligatorios, igual que en
 * `build.ts`: la forma más corta de escribir una cifra sin citar no compila.
 */
function fig(
  display: string,
  raw: number | null,
  sourceId: string,
  method: string,
  unit: string | null = null,
): Figure {
  return { display, raw, unit, sourceId, method };
}

function cell(display: string, tone: Tone | null = null) {
  return { display, tone };
}

const STATE_TONE: Record<string, Tone> = {
  overdue: 'rose',
  due_soon: 'amber',
  in_force: 'emerald',
  met: 'emerald',
  dropped: 'ink',
};

const STATE_WORD: Record<string, string> = {
  overdue: 'Vencido',
  due_soon: 'Por vencer',
  in_force: 'Vigente',
  met: 'Cumplido',
  dropped: 'Descartado',
};

/** Los `n` meses que empiezan en `startYm`, en orden. */
function monthsAhead(startYm: string, n: number): string[] {
  const [y, m] = startYm.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push(new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7));
  return out;
}

/** Cómo nombra un compromiso a su contraparte cuando no tiene ninguna. */
const NO_COUNTERPARTY = 'Sin contraparte';

// ---------------------------------------------------------------------------
// Parámetros compartidos
// ---------------------------------------------------------------------------

const horizonDays = z
  .number()
  .int()
  .min(1)
  .max(365)
  .default(60)
  .describe('Cuántos días hacia adelante mirar. «Este mes» ≈ 30, «el trimestre» ≈ 90.');

const months = z
  .number()
  .int()
  .min(2)
  .max(24)
  .default(6)
  .describe('Cuántos meses cubre. Menos de tres puntos no dibujan una tendencia.');

/**
 * Una promesa interna entre colegas no es un vencimiento con un tercero, y
 * contarla infla la cifra que alguien lee como «papeles por vencer» — la misma
 * razón por la que `buildExpiries` las excluye. Es una función y no una
 * constante para que cada llamada reciba su propio arreglo: `ListOptions` lo
 * declara mutable y una constante compartida sería un arreglo que cualquier
 * lector podría reordenar por debajo de los demás.
 */
const excludeInternal = (): { excludeKinds: CommitmentKind[] } => ({ excludeKinds: ['internal'] });

// ---------------------------------------------------------------------------
// 1. Vencimientos por estado
// ---------------------------------------------------------------------------

const commitmentsByState: ReportBlock<z.ZodObject<{ horizonDays: typeof horizonDays }>> = {
  id: 'commitments_by_state',
  label: 'Vencimientos por estado',
  question:
    'Cuántos compromisos están vencidos, por vencer y vigentes en una ventana, y cuánta plata hay en riesgo. Es el bloque que contesta «cómo vamos».',
  params: z.object({ horizonDays }),
  restricted: false,
  async build({ db, params, today, slot }) {
    const end = addDays(today, params.horizonDays);
    const rows = await listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: end,
      today,
      limit: ROW_CAP,
      ...excludeInternal(),
    });

    const open = rows.filter((r) => {
      const s = deriveState(r, today);
      return s === 'overdue' || s === 'due_soon' || s === 'in_force';
    });
    const overdue = open.filter((r) => deriveState(r, today) === 'overdue');
    const dueSoon = open.filter((r) => deriveState(r, today) === 'due_soon');
    const inForce = open.filter((r) => deriveState(r, today) === 'in_force');
    const atRisk = [...overdue, ...dueSoon].reduce((s, r) => s + (r.amount_cop ?? 0), 0);

    const window = `Compromisos confirmados con vencimiento hasta el ${longDate(end)}, más los que ya se vencieron y siguen abiertos. Excluye las promesas internas entre colegas, los cumplidos y los descartados.`;

    return {
      sources: [
        {
          id: slot,
          system: 'Cortex · commitments',
          detail: window,
          rowCount: rows.length,
          caveat:
            rows.length >= ROW_CAP
              ? `La lectura se cortó en ${ROW_CAP} filas; hay más compromisos de los que este bloque alcanzó a contar.`
              : null,
        },
      ],
      sections: [
        {
          type: 'metrics',
          heading: `Los próximos ${params.horizonDays} días`,
          items: [
            {
              label: 'Vencidos',
              figure: fig(
                count(overdue.length),
                overdue.length,
                slot,
                `Conteo de compromisos abiertos cuya fecha ya pasó al ${today}. ${window}`,
              ),
              sub: overdue.length > 0 ? 'hay que resolverlos hoy' : 'nada pendiente',
              tone: overdue.length > 0 ? 'rose' : 'ink',
            },
            {
              label: 'Por vencer',
              figure: fig(
                count(dueSoon.length),
                dueSoon.length,
                slot,
                `Conteo de compromisos abiertos dentro de su ventana de aviso al ${today}. ${window}`,
              ),
              sub: 'dentro del aviso de cada uno',
              tone: dueSoon.length > 0 ? 'amber' : 'ink',
            },
            {
              label: 'Vigentes',
              figure: fig(
                count(inForce.length),
                inForce.length,
                slot,
                `Conteo de compromisos abiertos todavía fuera de su ventana de aviso al ${today}. ${window}`,
              ),
              sub: 'sin nada que hacer todavía',
              tone: 'emerald',
            },
            {
              label: 'Plata en riesgo',
              figure: fig(
                cop(atRisk),
                atRisk,
                slot,
                'Suma de amount_cop de los compromisos vencidos y por vencer. Los que no tienen monto registrado suman cero, así que esta cifra es un piso y no un total.',
                'COP',
              ),
              sub: 'vencidos y por vencer',
              tone: atRisk > 0 ? 'amber' : 'ink',
            },
          ],
        },
      ],
      notes:
        rows.some((r) => r.amount_cop === null) && atRisk > 0
          ? ['Hay compromisos sin monto registrado: la plata en riesgo es un piso, no un total.']
          : [],
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Qué se viene, mes a mes
// ---------------------------------------------------------------------------

const commitmentsByMonth: ReportBlock<z.ZodObject<{ months: typeof months }>> = {
  id: 'commitments_by_month',
  label: 'Vencimientos mes a mes',
  question:
    'Cómo se reparten los vencimientos por mes hacia adelante: si se amontonan en septiembre o vienen parejos. Contesta «cuándo se me viene encima».',
  params: z.object({ months }),
  restricted: false,
  async build({ db, params, today, slot }) {
    const keys = monthsAhead(today.slice(0, 7), params.months);
    const last = keys[keys.length - 1] ?? today.slice(0, 7);
    // Hasta el último día del último mes pedido, sin construir un Date de la
    // fecha: el día 0 del mes siguiente es el último del anterior.
    const [ly, lm] = last.split('-').map(Number) as [number, number];
    const end = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);

    const rows = await listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: end,
      today,
      limit: ROW_CAP,
      ...excludeInternal(),
    });
    const ahead = rows.filter((r) => r.due_on >= today && isOpenRow(r, today));

    const detail = `Compromisos confirmados abiertos con vencimiento entre hoy (${today}) y el ${longDate(end)}, agrupados por el mes de su fecha. Excluye las promesas internas.`;
    const method = `Conteo de compromisos por mes de due_on, y suma de amount_cop del mismo grupo. ${detail}`;

    const buckets = keys.map((key) => {
      const items = ahead.filter((r) => r.due_on.slice(0, 7) === key);
      return {
        key,
        n: items.length,
        amount: items.reduce((s, r) => s + (r.amount_cop ?? 0), 0),
      };
    });

    return {
      sources: [
        { id: slot, system: 'Cortex · commitments', detail, rowCount: ahead.length, caveat: null },
      ],
      sections: [
        {
          type: 'chart',
          heading: `Vencimientos de los próximos ${params.months} meses`,
          chart: {
            type: 'timeseries',
            points: buckets.map((b) => ({ label: monthTick(b.key), value: b.n })),
            valueUnit: 'compromisos',
            tone: 'primary',
          },
          altText: describeShape(buckets.map((b) => ({ label: monthTick(b.key), value: b.n }))),
          caption: null,
          table: {
            columns: [
              { label: 'Mes', align: 'left', mono: false },
              { label: 'Compromisos', align: 'right', mono: true },
              { label: 'Monto', align: 'right', mono: true },
            ],
            rows: buckets.map((b) => [
              cell(monthTick(b.key)),
              cell(count(b.n)),
              cell(b.amount > 0 ? cop(b.amount) : '—'),
            ]),
            sourceId: slot,
            method,
            caption: null,
          },
          sourceId: slot,
          method,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 3. Quién concentra los vencimientos
// ---------------------------------------------------------------------------

const topN = z
  .number()
  .int()
  .min(3)
  .max(15)
  .default(8)
  .describe('Cuántas contrapartes mostrar. El resto se agrupa en «otras».');

const commitmentsByCounterparty: ReportBlock<
  z.ZodObject<{ horizonDays: typeof horizonDays; top: typeof topN }>
> = {
  id: 'commitments_by_counterparty',
  label: 'Vencimientos por contraparte',
  question:
    'Qué cliente, proveedor o autoridad concentra lo que se vence, y cuánto pesa en plata cada uno. Contesta «con quién tenemos el lío».',
  params: z.object({ horizonDays, top: topN }),
  restricted: false,
  async build({ db, params, today, slot }) {
    const end = addDays(today, params.horizonDays);
    const rows = await listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: end,
      today,
      limit: ROW_CAP,
      ...excludeInternal(),
    });
    const open = rows.filter((r) => isOpenRow(r, today));

    const byName = new Map<string, { n: number; amount: number }>();
    for (const r of open) {
      const name = r.counterparty?.trim() || NO_COUNTERPARTY;
      const cur = byName.get(name) ?? { n: 0, amount: 0 };
      cur.n += 1;
      cur.amount += r.amount_cop ?? 0;
      byName.set(name, cur);
    }
    const all = [...byName.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.amount - a.amount || b.n - a.n);
    const shown = all.slice(0, params.top);
    const rest = all.slice(params.top);
    const restTotal = rest.reduce((s, r) => s + r.amount, 0);
    const restCount = rest.reduce((s, r) => s + r.n, 0);

    const detail = `Compromisos confirmados abiertos con vencimiento hasta el ${longDate(end)}, agrupados por el texto de counterparty. Excluye las promesas internas.`;
    const method = `Suma de amount_cop por contraparte, de mayor a menor. Las contrapartes se agrupan por el texto exacto de counterparty: dos formas de escribir el mismo nombre cuentan como dos. ${detail}`;

    const bars = [
      ...shown.map((s) => ({
        label: clip(s.name, 34),
        value: s.amount,
        display: cop(s.amount),
        tone: 'primary' as Tone,
      })),
      ...(rest.length > 0
        ? [
            {
              label: `otras ${rest.length}`,
              value: restTotal,
              display: cop(restTotal),
              tone: 'ink' as Tone,
            },
          ]
        : []),
    ];

    return {
      sources: [
        { id: slot, system: 'Cortex · commitments', detail, rowCount: open.length, caveat: null },
      ],
      sections: [
        {
          type: 'chart',
          heading: 'Quién concentra lo que se vence',
          chart: { type: 'bars', bars },
          altText:
            shown.length === 0
              ? 'No hay ninguna contraparte con compromisos abiertos en esta ventana.'
              : `${shown[0]?.name ?? ''} encabeza con ${cop(shown[0]?.amount ?? 0)} de ${shown.length === 1 ? 'una sola contraparte' : `${count(all.length)} contrapartes`}.`,
          caption: null,
          table: {
            columns: [
              { label: 'Contraparte', align: 'left', mono: false },
              { label: 'Compromisos', align: 'right', mono: true },
              { label: 'Monto', align: 'right', mono: true },
            ],
            rows: [
              ...shown.map((s) => [cell(s.name), cell(count(s.n)), cell(cop(s.amount))]),
              ...(rest.length > 0
                ? [[cell(`otras ${rest.length}`), cell(count(restCount)), cell(cop(restTotal))]]
                : []),
            ],
            sourceId: slot,
            method,
            caption: null,
          },
          sourceId: slot,
          method,
        },
      ],
      notes: byName.has(NO_COUNTERPARTY)
        ? ['Hay compromisos sin contraparte registrada; van agrupados como «sin contraparte».']
        : [],
    };
  },
};

// ---------------------------------------------------------------------------
// 4. La lista de lo que se viene
// ---------------------------------------------------------------------------

const listLimit = z
  .number()
  .int()
  .min(5)
  .max(60)
  .default(20)
  .describe('Cuántas filas listar, de la más próxima a la más lejana.');

const commitmentsUpcoming: ReportBlock<
  z.ZodObject<{ horizonDays: typeof horizonDays; limit: typeof listLimit }>
> = {
  id: 'commitments_upcoming',
  label: 'Lo que se viene, uno por uno',
  question:
    'La lista concreta: qué se vence, qué día, de quién es y de dónde salió esa fecha. Es el bloque que se lleva a una reunión.',
  params: z.object({ horizonDays, limit: listLimit }),
  restricted: false,
  async build({ db, params, today, slot }) {
    const end = addDays(today, params.horizonDays);
    const rows = await listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: end,
      today,
      limit: ROW_CAP,
      ...excludeInternal(),
    });
    const open = rows.filter((r) => isOpenRow(r, today)).slice(0, params.limit);

    const detail = `Compromisos confirmados abiertos con vencimiento hasta el ${longDate(end)}, del más próximo al más lejano. Excluye las promesas internas.`;

    return {
      sources: [
        { id: slot, system: 'Cortex · commitments', detail, rowCount: open.length, caveat: null },
      ],
      sections: [
        {
          type: 'table',
          heading: `Lo que se vence antes del ${shortDate(end)}`,
          table: {
            columns: [
              { label: 'Compromiso', align: 'left', mono: false },
              { label: 'Tipo', align: 'left', mono: false },
              { label: 'Contraparte', align: 'left', mono: false },
              { label: 'Vence', align: 'left', mono: true },
              { label: 'Cuándo', align: 'left', mono: false },
              { label: 'Monto', align: 'right', mono: true },
            ],
            rows: open.map((r) => {
              const state = deriveState(r, today);
              return [
                cell(r.title),
                cell(KIND_LABEL[r.kind] ?? r.kind),
                cell(r.counterparty?.trim() || '—'),
                cell(shortDate(r.due_on), STATE_TONE[state] ?? null),
                cell(whenPhrase(daysUntilDue(r.due_on, today)), STATE_TONE[state] ?? null),
                cell(r.amount_cop === null ? '—' : cop(r.amount_cop)),
              ];
            }),
            sourceId: slot,
            method: `Una fila por compromiso abierto, ordenadas por due_on ascendente y cortadas en ${params.limit}. El estado sale de comparar due_on con hoy (${today}) y con la ventana de aviso de cada uno, no de la columna guardada. ${detail}`,
            caption:
              rows.filter((r) => isOpenRow(r, today)).length > open.length
                ? `Hay ${count(rows.filter((r) => isOpenRow(r, today)).length - open.length)} más que no caben en esta lista.`
                : null,
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 5. Papeles de la flota
// ---------------------------------------------------------------------------

interface VehicleRow {
  id: string;
  plate: string;
  label: string | null;
  soat_expires_at: string | null;
  rtm_expires_at: string | null;
  last_runt_sync: string | null;
  total_pending_cop: number | null;
  archived: boolean | null;
}

const fleetPapers: ReportBlock<z.ZodObject<{ horizonDays: typeof horizonDays }>> = {
  id: 'fleet_papers',
  label: 'Papeles de la flota',
  question:
    'SOAT y tecnomecánica de cada placa, con la fecha en que se consultó el RUNT. Contesta «qué camión no puede salir».',
  params: z.object({ horizonDays }),
  restricted: false,
  async build({ db, params, today, slot }) {
    const { data, error } = await db
      .from('vehicles')
      .select(
        'id, plate, label, soat_expires_at, rtm_expires_at, last_runt_sync, total_pending_cop, archived',
      )
      .eq('archived', false)
      .order('plate', { ascending: true })
      .limit(ROW_CAP);
    if (error) throw new Error(`No se pudo leer la flota: ${error.message}`);
    const vehicles = (data ?? []) as unknown as VehicleRow[];

    const classify = (expiry: string | null): { tone: Tone; word: string } => {
      if (!expiry) return { tone: 'ink', word: 'Sin consultar' };
      const left = daysUntilDue(expiry, today);
      if (left < 0) return { tone: 'rose', word: 'Vencido' };
      if (left <= params.horizonDays) return { tone: 'amber', word: 'Por vencer' };
      return { tone: 'emerald', word: 'Al día' };
    };

    const oldest = vehicles
      .map((v) => v.last_runt_sync)
      .filter((s): s is string => Boolean(s))
      .sort()[0];
    const never = vehicles.filter((v) => !v.last_runt_sync).length;

    const detail =
      'Placas activas (archived = false) con la vigencia de SOAT y tecnomecánica tal como las devolvió el RUNT en la última consulta de cada una.';
    const caveat = [
      oldest
        ? `La consulta más vieja de la flota es del ${longDate(oldest.slice(0, 10))}: una vigencia leída ese día es un hecho de ese día, no de hoy.`
        : null,
      never > 0
        ? `${count(never)} ${never === 1 ? 'placa nunca se ha consultado' : 'placas nunca se han consultado'} en el RUNT y aparecen como «sin consultar», no como al día.`
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    const soatOverdue = vehicles.filter((v) => classify(v.soat_expires_at).tone === 'rose').length;
    const rtmOverdue = vehicles.filter((v) => classify(v.rtm_expires_at).tone === 'rose').length;

    return {
      sources: [
        {
          id: slot,
          system: 'Cortex · vehicles (datos de RUNT)',
          detail,
          rowCount: vehicles.length,
          caveat: caveat || null,
        },
      ],
      sections: [
        {
          type: 'metrics',
          heading: 'La flota hoy',
          items: [
            {
              label: 'Placas activas',
              figure: fig(
                count(vehicles.length),
                vehicles.length,
                slot,
                'Conteo de vehículos con archived = false.',
              ),
              sub: never > 0 ? `${count(never)} sin consultar nunca` : 'todas consultadas',
              tone: 'primary',
            },
            {
              label: 'SOAT vencido',
              figure: fig(
                count(soatOverdue),
                soatOverdue,
                slot,
                `Conteo de placas cuya soat_expires_at es anterior a hoy (${today}). Una placa sin consultar no cuenta acá: cuenta como «sin consultar».`,
              ),
              sub: soatOverdue > 0 ? 'no pueden salir' : 'ninguna',
              tone: soatOverdue > 0 ? 'rose' : 'emerald',
            },
            {
              label: 'Tecnomecánica vencida',
              figure: fig(
                count(rtmOverdue),
                rtmOverdue,
                slot,
                `Conteo de placas cuya rtm_expires_at es anterior a hoy (${today}). Una placa sin consultar no cuenta acá.`,
              ),
              sub: rtmOverdue > 0 ? 'no pueden salir' : 'ninguna',
              tone: rtmOverdue > 0 ? 'rose' : 'emerald',
            },
          ],
        },
        {
          type: 'table',
          heading: 'Placa por placa',
          table: {
            columns: [
              { label: 'Placa', align: 'left', mono: true },
              { label: 'SOAT', align: 'left', mono: true },
              { label: 'Tecnomecánica', align: 'left', mono: true },
              { label: 'Consultado', align: 'left', mono: true },
            ],
            rows: vehicles.map((v) => {
              const s = classify(v.soat_expires_at);
              const r = classify(v.rtm_expires_at);
              return [
                cell(v.plate),
                cell(
                  v.soat_expires_at ? `${shortDate(v.soat_expires_at)} · ${s.word}` : s.word,
                  s.tone,
                ),
                cell(
                  v.rtm_expires_at ? `${shortDate(v.rtm_expires_at)} · ${r.word}` : r.word,
                  r.tone,
                ),
                cell(v.last_runt_sync ? shortDate(v.last_runt_sync.slice(0, 10)) : 'nunca'),
              ];
            }),
            sourceId: slot,
            method: `Una fila por placa activa. El estado de cada papel sale de comparar su fecha con hoy (${today}); «por vencer» es dentro de ${params.horizonDays} días. ${detail}`,
            caption: null,
          },
        },
      ],
      notes: never > 0 ? ['Las placas nunca consultadas en el RUNT no cuentan como al día.'] : [],
    };
  },
};

// ---------------------------------------------------------------------------
// 6. Promesas internas — RESTRINGIDO
// ---------------------------------------------------------------------------

const internalPromises: ReportBlock<z.ZodObject<{ horizonDays: typeof horizonDays }>> = {
  id: 'internal_promises',
  label: 'Promesas internas del equipo',
  question:
    'Qué quedó de hacer cada persona del equipo y para cuándo. Contesta «quién debe qué adentro». NOMBRA A EMPLEADOS: un informe que lo incluya no se puede compartir por enlace público.',
  params: z.object({ horizonDays }),
  restricted: true,
  async build({ db, params, today, slot }) {
    const end = addDays(today, params.horizonDays);
    const rows = await listCommitments(db, {
      reviewState: 'confirmed',
      kind: 'internal',
      dueBefore: end,
      today,
      limit: ROW_CAP,
    });
    const open = rows.filter((r) => isOpenRow(r, today));
    const unowned = open.filter((r) => !r.owner_user_id).length;

    const detail = `Compromisos internos confirmados y abiertos con fecha hasta el ${longDate(end)}. Sólo los de kind = 'internal': las promesas entre colegas, no los papeles con terceros.`;

    return {
      sources: [
        {
          id: slot,
          system: 'Cortex · commitments (internos)',
          detail,
          rowCount: open.length,
          caveat: null,
        },
      ],
      sections: [
        {
          type: 'metrics',
          heading: 'Promesas internas abiertas',
          items: [
            {
              label: 'Abiertas',
              figure: fig(
                count(open.length),
                open.length,
                slot,
                `Conteo de compromisos internos abiertos al ${today}. ${detail}`,
              ),
              sub: 'del equipo, no con terceros',
              tone: 'primary',
            },
            {
              label: 'Sin dueño',
              figure: fig(
                count(unowned),
                unowned,
                slot,
                'Conteo de compromisos internos abiertos cuyo owner_user_id es nulo: nadie los persigue.',
              ),
              sub: unowned > 0 ? 'no persiguen a nadie' : 'todas con dueño',
              tone: unowned > 0 ? 'amber' : 'emerald',
            },
          ],
        },
        {
          type: 'table',
          heading: 'Quién debe qué',
          table: {
            columns: [
              { label: 'Promesa', align: 'left', mono: false },
              { label: 'Dueño', align: 'left', mono: false },
              { label: 'Para', align: 'left', mono: true },
              { label: 'Estado', align: 'left', mono: false },
            ],
            rows: open.map((r) => {
              const state = deriveState(r, today);
              return [
                cell(r.title),
                cell(ownerName(r)),
                cell(shortDate(r.due_on), STATE_TONE[state] ?? null),
                cell(STATE_WORD[state] ?? state, STATE_TONE[state] ?? null),
              ];
            }),
            sourceId: slot,
            method: `Una fila por compromiso interno abierto, ordenadas por due_on ascendente. El dueño sale de owner_user_id resuelto contra users; «sin dueño» quiere decir que la columna está vacía. ${detail}`,
            caption: null,
          },
        },
      ],
      notes:
        unowned > 0
          ? ['Una promesa interna sin dueño no persigue a nadie: aparece listada como «sin dueño».']
          : [],
    };
  },
};

// ---------------------------------------------------------------------------
// El registro
// ---------------------------------------------------------------------------

/**
 * Todos los bloques, por id.
 *
 * Añadir uno es añadir una entrada aquí. No hay migración, no hay valor nuevo
 * en ningún CHECK y no hay pantalla que tocar: el selector, el esquema que ve
 * el modelo y las pruebas se derivan de este objeto.
 */
export const BLOCKS = {
  commitments_by_state: commitmentsByState,
  commitments_by_month: commitmentsByMonth,
  commitments_by_counterparty: commitmentsByCounterparty,
  commitments_upcoming: commitmentsUpcoming,
  fleet_papers: fleetPapers,
  internal_promises: internalPromises,
} satisfies Record<string, ReportBlock>;

export type BlockId = keyof typeof BLOCKS;

export const BLOCK_IDS = Object.keys(BLOCKS) as BlockId[];

export function isBlockId(value: string): value is BlockId {
  return Object.hasOwn(BLOCKS, value);
}

export function getBlock(id: BlockId): ReportBlock {
  return BLOCKS[id] as ReportBlock;
}

/** True cuando el bloque nombra a alguien de la empresa. */
export function blockIsRestricted(id: BlockId): boolean {
  return getBlock(id).restricted;
}

/**
 * Correr un bloque y estampar el instante.
 *
 * `readAt` se pone AQUÍ y no dentro del bloque. Es la misma decisión que toma
 * `chat-chart.ts` con el instante y el conteo de filas: un dato que describe la
 * lectura no se le pide a quien la hizo, se toma. Así ningún bloque puede
 * declarar sus datos más frescos de lo que son, ni por descuido ni de otro modo.
 */
export async function runBlock(
  id: BlockId,
  input: { db: SupabaseClient; params: unknown; today: string; now: Date; slot: string },
): Promise<{ sources: ReportSource[]; sections: ReportSection[]; notes: string[] }> {
  const block = getBlock(id);
  const params = block.params.parse(input.params ?? {});
  const out = await block.build({
    db: input.db,
    params,
    today: input.today,
    slot: input.slot,
  });
  const readAt = input.now.toISOString();
  return {
    sources: out.sources.map((s) => ({ ...s, readAt })),
    sections: out.sections,
    notes: out.notes ?? [],
  };
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function isOpenRow(row: CommitmentRow, today: string): boolean {
  const s = deriveState(row, today);
  return s === 'overdue' || s === 'due_soon' || s === 'in_force';
}

/**
 * Cómo nombra una tabla al dueño de una promesa interna.
 *
 * `hydrate` deja el nombre resuelto en `owner_name`; si no lo resolvió, se dice
 * que no hay dueño en vez de imprimir un uuid, que no le dice nada a nadie y sí
 * parece un dato.
 */
function ownerName(row: CommitmentRow): string {
  return row.owner_name?.trim() || 'Sin dueño';
}

/**
 * La forma de una serie, en una frase, para el `altText`.
 *
 * Es texto sobre la FORMA del dibujo, no sobre las cifras — las cifras están en
 * la tabla gemela, que el esquema obliga a traer. Lo escribe este código y no un
 * modelo por la misma razón que todo lo demás en este archivo.
 */
function describeShape(points: Array<{ label: string; value: number }>): string {
  if (points.length === 0) return 'No hay ningún punto en el periodo.';
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const peak = points[values.indexOf(max)];
  const first = points[0];
  const last = points[points.length - 1];
  if (max === 0) return `Ningún vencimiento entre ${first?.label} y ${last?.label}.`;
  return `Va de ${count(first?.value ?? 0)} en ${first?.label} a ${count(last?.value ?? 0)} en ${last?.label}, con el pico de ${count(max)} en ${peak?.label}.`;
}
