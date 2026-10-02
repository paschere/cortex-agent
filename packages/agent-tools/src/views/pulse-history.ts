import { formatValue } from './compute';
import { PULSE_DEFAULT_TIMEZONE, type PulseFact, cronWeekdays, longDay, lowerFirst } from './pulse';

/**
 * LA MEMORIA DEL PULSO Y LA REVISIÓN DEL LUNES (lo puro; la base está en
 * pulse-snapshots.ts y las herramientas en pulse-weekly.ts).
 *
 * Hasta la 0171 el pulso no tenía memoria: «frente a ayer» sólo podía contar
 * lo que traía fecha de ayer. Ahora cada corrida guarda sus cifras del día
 * (`pulse_snapshots`) y aquí se resta:
 *
 *   1. CONTRA EL ÚLTIMO DÍA GUARDADO. `compareFacts` toma las cifras de hoy y
 *      las de un día guardado y devuelve, para cada cifra que se puede restar,
 *      una cifra NUEVA con la diferencia: su valor es la resta, su etiqueta es
 *      la frase entera («Cartera vencida subió $ 1.200.000 desde ayer (de
 *      $ 3.050.000 a $ 4.250.000)»). Entra a las cifras del resumen como
 *      cualquier otra, así que la guarda de números (`checkGrounding`) sigue
 *      sin aceptar nada que no esté ahí: el modelo nunca resta, copia.
 *
 *   2. QUÉ NO SE RESTA. Una cifra «del mes» del 1 de octubre contra la del 30
 *      de septiembre no «bajó»: empezó de cero (`period` distinto). Un punto de
 *      gráfica o una fila de tabla van por posición, y la posición cambia. Lo
 *      «de ayer» sólo se compara con lo «de anteayer» si el día guardado es
 *      exactamente ayer. Las cifras derivadas (el anterior, el porcentaje, la
 *      meta) ya son comparaciones.
 *
 *   3. LA SEMANA. `weeklyFacts` junta la resta contra hace una semana, lo que
 *      Cortex hizo en los últimos siete días (envíos, avisos, plata recuperada,
 *      rutinas, aprobaciones) y lo que hay hoy; `weeklyRecommendations` saca de
 *      ESAS cifras qué hacer esta semana, y `fallbackWeekly` escribe la
 *      revisión sin modelo. Si no hay semana anterior guardada lo dice — una
 *      «mejora» contra nada sería inventada.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Cuánto se guardan las cifras de cada día: un año y un mes. */
export const SNAPSHOT_KEEP_DAYS = 400;
/** El bloque de texto de la revisión semanal en la vista. */
export const WEEK_BLOCK_ID = 'semana';
/** Cómo se marca en el historial de versiones la revisión de una semana (idempotencia). */
export const weeklyVersionPrompt = (weekStart: string) => `Revisión semanal ${weekStart}`;

export const WEEKLY_DEFAULT_WEEKDAY = 1;
export const WEEKLY_DEFAULT_HOUR = 7;
export const WEEKLY_DEFAULT_MINUTE = 30;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** El lunes de la semana ISO de `day`: la clave de «una vez por semana». */
export function isoWeekStart(day: string): string {
  const back = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return shiftDay(day, -back);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

const WEEKDAY = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «el viernes»: el nombre del día, sin números (no le regala cifras a la guarda). */
function weekdayOf(day: string): string {
  return WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()] as string;
}

// ---------------------------------------------------------------------------
// 1. Lo que se guarda
// ---------------------------------------------------------------------------

export interface PulseSnapshot {
  day: string;
  facts: PulseFact[];
}

/** Lo que se derivó al leer (diferencias) no se guarda: se recalcula siempre. */
const DERIVED_RE = /\.(delta|semana|semana_pct)$/;

/** Las cifras del día tal como se guardan: sin las diferencias, con su forma justa. */
export function snapshotFacts(facts: PulseFact[]): PulseFact[] {
  return facts
    .filter((f) => !DERIVED_RE.test(f.key))
    .slice(0, 400)
    .map((f) => ({
      key: f.key.slice(0, 120),
      label: f.label.slice(0, 400),
      value: typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null,
      display: f.display.slice(0, 400),
      ...(f.format ? { format: f.format } : {}),
      ...(f.period ? { period: f.period } : {}),
      ...(f.goodWhen ? { goodWhen: f.goodWhen } : {}),
    }));
}

/** Lee lo que vino de la base sin confiar en su forma: lo que no es una cifra se bota. */
export function parseSnapshotFacts(raw: unknown): PulseFact[] {
  if (!Array.isArray(raw)) return [];
  const out: PulseFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.label !== 'string' || typeof r.display !== 'string')
      continue;
    const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
    const format =
      r.format === 'number' || r.format === 'money' || r.format === 'percent'
        ? r.format
        : undefined;
    const goodWhen = r.goodWhen === 'up' || r.goodWhen === 'down' ? r.goodWhen : undefined;
    out.push({
      key: r.key,
      label: r.label,
      value,
      display: r.display,
      ...(format ? { format } : {}),
      ...(typeof r.period === 'string' ? { period: r.period } : {}),
      ...(goodWhen ? { goodWhen } : {}),
    });
  }
  return out;
}

/**
 * El día guardado contra el que se compara: el más cercano a `today - target`
 * dentro de [today - max, today - min]. Para el resumen diario es «ayer, o el
 * último día hábil» (1..4); para la semana, «hace siete días, más o menos
 * tres» (5..10, porque la rutina diaria no corre el fin de semana).
 */
export function pickBaseline(
  snapshots: PulseSnapshot[],
  today: string,
  window: { target: number; min: number; max: number },
): PulseSnapshot | null {
  let best: PulseSnapshot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of snapshots) {
    const age = daysBetween(s.day, today);
    if (age < window.min || age > window.max || !s.facts.length) continue;
    // A igual distancia, el más viejo: «hace una semana» antes que «hace seis días».
    const score = Math.abs(age - window.target) * 2 - (age > window.target ? 1 : 0);
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

export const DAILY_BASELINE = { target: 1, min: 1, max: 4 } as const;
export const WEEKLY_BASELINE = { target: 7, min: 5, max: 10 } as const;

// ---------------------------------------------------------------------------
// 2. Restar sin inventar
// ---------------------------------------------------------------------------

/** Lo que ya es una comparación, o va por posición: no se resta. */
const NOT_COMPARABLE_RE =
  /\.(anterior|cambio|meta|delta|semana|semana_pct|\d+)$|^cartera\.vencio_ayer/;
const DAILY_RE = /\.ayer(_registros)?$/;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** «+$ 1.200.000», «-3», «0». */
export function signedDisplay(diff: number, format: PulseFact['format'] = 'number'): string {
  const abs = formatValue(Math.abs(diff), format ?? 'number');
  if (diff > 0) return `+${abs}`;
  if (diff < 0) return `-${abs}`;
  return abs;
}

/** El nombre de la cifra, sin lo que trae pegado: «Pagos recibidos: lo de ayer (2 registros)» → «Pagos recibidos». */
function titleOf(f: PulseFact): string {
  return f.label.replace(/:.*$/, '').trim();
}

export interface CompareOptions {
  /** «delta» para el resumen diario, «semana» para la revisión. */
  suffix: 'delta' | 'semana';
  /** «desde ayer», «frente a hace una semana». */
  since: string;
  /** Comparar lo «de ayer» con lo «de anteayer» (sólo si el día guardado es ayer). */
  daily: boolean;
}

/**
 * Las diferencias entre las cifras de hoy y las de un día guardado, como
 * cifras nuevas. Cada una trae su frase en la etiqueta y su resta en el valor;
 * nada aquí sale de un modelo.
 */
export function compareFacts(
  current: PulseFact[],
  base: PulseSnapshot,
  opts: CompareOptions,
): PulseFact[] {
  const before = new Map(base.facts.map((f) => [f.key, f]));
  const out: PulseFact[] = [];
  for (const f of current) {
    if (f.value === null || !Number.isFinite(f.value)) continue;
    if (NOT_COMPARABLE_RE.test(f.key)) continue;
    const isDaily = DAILY_RE.test(f.key);
    if (isDaily && !opts.daily) continue;
    const prev = before.get(f.key);
    if (!prev || prev.value === null || !Number.isFinite(prev.value)) continue;
    // Una cifra del período (del mes, de la semana) sólo se resta dentro del mismo período.
    if ((f.period ?? null) !== (prev.period ?? null)) continue;
    const diff = round2(f.value - prev.value);
    const format = f.format ?? prev.format ?? 'number';
    const abs = formatValue(Math.abs(diff), format);
    const title = titleOf(f);
    let label: string;
    if (isDaily && f.key.endsWith('_registros')) {
      label =
        diff === 0
          ? `${title}: ayer entraron ${f.display} registros, los mismos que anteayer`
          : `${title}: ayer entraron ${f.display} registros, ${abs} ${diff > 0 ? 'más' : 'menos'} que anteayer (${prev.display})`;
    } else if (isDaily) {
      label =
        diff === 0
          ? `${title}: lo de ayer (${f.display}) igual que anteayer`
          : `${title}: lo de ayer (${f.display}) ${diff > 0 ? 'superó' : 'quedó por debajo de'} lo de anteayer (${prev.display}) por ${abs}`;
    } else {
      // «Cartera vencida subió», «Ventas del mes subieron».
      const plural = /^\p{L}+s\b/u.test(title);
      const verb = diff > 0 ? (plural ? 'subieron' : 'subió') : plural ? 'bajaron' : 'bajó';
      label =
        diff === 0
          ? `${title} ${plural ? 'siguen' : 'sigue'} en ${f.display} ${opts.since}`
          : `${title} ${verb} ${abs} ${opts.since} (de ${prev.display} a ${f.display})`;
    }
    out.push({
      key: `${f.key}.${opts.suffix}`,
      label,
      value: diff,
      display: signedDisplay(diff, format),
      format,
      ...(f.goodWhen ? { goodWhen: f.goodWhen } : {}),
    });
    // El porcentaje de la semana, calculado aquí para que el modelo no lo calcule.
    if (opts.suffix === 'semana' && prev.value !== 0 && diff !== 0) {
      const pct = Math.round((diff / Math.abs(prev.value)) * 1000) / 10;
      out.push({
        key: `${f.key}.semana_pct`,
        label: `${title}: cambio porcentual ${opts.since}`,
        value: pct,
        display: `${pct > 0 ? '+' : ''}${formatValue(pct, 'number')} %`,
        format: 'percent',
      });
    }
  }
  return out;
}

/** «desde ayer», o «desde el viernes» cuando el último día guardado no es ayer. */
export function sincePhrase(baseDay: string, today: string): string {
  return daysBetween(baseDay, today) === 1 ? 'desde ayer' : `desde el ${weekdayOf(baseDay)}`;
}

/** «frente a hace una semana», o «frente al lunes de la semana pasada». */
export function weekSincePhrase(baseDay: string, today: string): string {
  return daysBetween(baseDay, today) === 7
    ? 'frente a hace una semana'
    : `frente al ${weekdayOf(baseDay)} de la semana pasada`;
}

/** Las diferencias del resumen diario contra el último día guardado. */
export function dailyDeltas(current: PulseFact[], base: PulseSnapshot | null, today: string) {
  if (!base) return [];
  return compareFacts(current, base, {
    suffix: 'delta',
    since: sincePhrase(base.day, today),
    daily: daysBetween(base.day, today) === 1,
  });
}

// ---------------------------------------------------------------------------
// 3. La semana
// ---------------------------------------------------------------------------

/** Lo que Cortex hizo en los siete días. Null: esa lectura falló (va a `gaps`). */
export interface WeeklyActivity {
  /** Correos y cobros aprobados que salieron bien. */
  actionsSent: number | null;
  actionsFailed: number | null;
  /** Avisos de factura vencida. */
  receivableNotices: number | null;
  /** Avisos de compromisos y vencimientos que llegaron. */
  commitmentNotices: number | null;
  /** Plata que volvió porque Cortex actuó, en pesos, en los siete días. */
  recoveredCop: number | null;
  recoveredInvoices: number | null;
  routineRuns: number | null;
  routineErrors: number | null;
  /** Las rutinas que fallaron, con cuántas veces. */
  failingRoutines: Array<{ name: string; errors: number }>;
  /** Llamadas paradas esperando a la persona. */
  approvalsPending: number | null;
  /** Borradores (correos, cobros) que esperan aprobación. */
  draftsPending: number | null;
  /** Tareas con efecto que Cortex ejecutó (auditoría). */
  tasksDone: number | null;
  /** Asuntos de Gerencia cerrados con evidencia. */
  closures: number | null;
  /**
   * Las alertas de la proyección de caja (ledger.forecast) que piden atención
   * —caja en rojo o bajo el mínimo, pagos grandes en semanas apretadas—, ya en
   * palabras. Vacío: no hay libro de plata, o la caja no preocupa.
   */
  cashAlerts: Array<{ severity: 'warn' | 'critical'; message: string }>;
  gaps: string[];
}

export const EMPTY_ACTIVITY: WeeklyActivity = {
  actionsSent: null,
  actionsFailed: null,
  receivableNotices: null,
  commitmentNotices: null,
  recoveredCop: null,
  recoveredInvoices: null,
  routineRuns: null,
  routineErrors: null,
  failingRoutines: [],
  approvalsPending: null,
  draftsPending: null,
  tasksDone: null,
  closures: null,
  cashAlerts: [],
  gaps: [],
};

export interface WeeklyReviewInput {
  today: string;
  /** El primer y el último día de los siete revisados (ayer es el último). */
  from: string;
  to: string;
  /** Las cifras del pulso hoy. Null: no hay pulso. */
  current: PulseFact[] | null;
  /** El día guardado de hace una semana. Null: todavía no hay. */
  base: PulseSnapshot | null;
  activity: WeeklyActivity;
}

export interface WeeklyComposition {
  facts: PulseFact[];
  /** Las diferencias de la semana que son buenas noticias, mejor primero. */
  improved: PulseFact[];
  worsened: PulseFact[];
  /** Hay semana anterior guardada contra la cual comparar. */
  hasBaseline: boolean;
  /** «del lunes 21 de septiembre al domingo 27 de septiembre». */
  span: string;
}

const count = (n: number) => formatValue(n, 'number');

function activityFact(key: string, label: string, value: number | null, money = false) {
  if (value === null) return null;
  return {
    key: `cortex.${key}`,
    label,
    value,
    display: formatValue(value, money ? 'money' : 'number'),
    format: money ? ('money' as const) : ('number' as const),
  };
}

/** Lo bueno primero por magnitud relativa; sin `goodWhen` no es ni bueno ni malo. */
function rank(a: PulseFact, b: PulseFact): number {
  return Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0);
}

/**
 * Las cifras de la revisión: la semana revisada (en una etiqueta, para que sus
 * fechas valgan), las diferencias contra hace una semana, lo que Cortex hizo y
 * lo que hay hoy. Todo lo que la revisión puede citar.
 */
export function weeklyFacts(input: WeeklyReviewInput): WeeklyComposition {
  const span = `del ${longDay(input.from)} al ${longDay(input.to)}`;
  const facts: PulseFact[] = [
    { key: 'semana.revisada', label: `Semana revisada: ${span}`, value: null, display: span },
  ];
  const current = input.current ?? [];
  // Lo de hoy que vale citar: las cifras principales y quién debe más.
  for (const f of current)
    if (!f.key.includes('.') || f.key.endsWith('.total') || f.key === 'top_deudores.0')
      facts.push(f);

  const deltas =
    input.base && current.length
      ? compareFacts(current, input.base, {
          suffix: 'semana',
          since: weekSincePhrase(input.base.day, input.today),
          daily: false,
        })
      : [];
  facts.push(...deltas);
  const moved = deltas.filter((d) => d.key.endsWith('.semana') && d.value !== 0 && d.goodWhen);
  const good = (d: PulseFact) =>
    ((d.value ?? 0) > 0 && d.goodWhen === 'up') || ((d.value ?? 0) < 0 && d.goodWhen === 'down');
  const improved = moved.filter(good).sort(rank);
  const worsened = moved.filter((d) => !good(d)).sort(rank);

  const a = input.activity;
  const extra = [
    activityFact('envios', 'Correos y cobros que Cortex envió con tu aprobación', a.actionsSent),
    activityFact('envios_fallidos', 'Envíos que fallaron', a.actionsFailed),
    activityFact(
      'avisos_cartera',
      'Avisos de facturas vencidas que mandó Cortex',
      a.receivableNotices,
    ),
    activityFact(
      'avisos_compromisos',
      'Avisos de compromisos y vencimientos que llegaron',
      a.commitmentNotices,
    ),
    activityFact('recuperado', 'Plata recuperada con Cortex en la semana', a.recoveredCop, true),
    activityFact('recuperado_facturas', 'Facturas con plata recuperada', a.recoveredInvoices),
    activityFact('rutinas', 'Corridas de rutinas', a.routineRuns),
    activityFact('rutinas_error', 'Corridas de rutinas con error', a.routineErrors),
    activityFact('aprobaciones', 'Acciones que esperan tu aprobación', a.approvalsPending),
    activityFact('borradores', 'Borradores que esperan tu aprobación', a.draftsPending),
    activityFact('tareas', 'Tareas con efecto que hizo Cortex', a.tasksDone),
    activityFact('cierres', 'Asuntos de Gerencia cerrados con evidencia', a.closures),
  ];
  for (const f of extra) if (f) facts.push(f);
  a.cashAlerts.slice(0, 3).forEach((alert, i) => {
    facts.push({
      key: `caja.alerta.${i}`,
      label: `Alerta de la proyección de caja: ${alert.message}`,
      value: alert.severity === 'critical' ? 2 : 1,
      display: alert.message,
    });
  });
  a.failingRoutines.slice(0, 3).forEach((r, i) => {
    facts.push({
      key: `cortex.rutina_fallando.${i}`,
      label: `Rutina con error: «${r.name}» (${r.errors} ${r.errors === 1 ? 'vez' : 'veces'})`,
      value: r.errors,
      display: count(r.errors),
      format: 'number',
    });
  });
  return { facts, improved, worsened, hasBaseline: Boolean(input.base), span };
}

const fact = (facts: PulseFact[], key: string) => facts.find((f) => f.key === key);
const positive = (f: PulseFact | undefined): f is PulseFact => Boolean(f && (f.value ?? 0) > 0);

/** «Ferretería El Tornillo · FV-099 · … · $ 3.000.000» → el nombre y el saldo. */
function debtorOf(f: PulseFact | undefined): { name: string; owes: string } | null {
  if (!f) return null;
  const cells = f.display.split(' · ').map((c) => c.trim());
  const name = cells[0];
  const owes = cells[cells.length - 1];
  if (!name || !owes || name === '—' || cells.length < 2) return null;
  return { name, owes };
}

/**
 * Qué hacer esta semana, en orden de urgencia, sacado sólo de las cifras: cada
 * número que aparece es el `display` de una cifra. Tres como máximo; si no hay
 * tres cosas que decir, las que haya (relleno no es consejo).
 */
export function weeklyRecommendations(
  facts: PulseFact[],
  comp: Pick<WeeklyComposition, 'worsened' | 'hasBaseline'>,
  opts: { hasPulse: boolean },
): string[] {
  const out: string[] = [];
  const worse = new Set(comp.worsened.map((d) => d.key.replace(/\.semana$/, '')));
  const cash = fact(facts, 'caja.alerta.0');
  const cashLine = cash
    ? `Mira la caja de las próximas semanas: ${cash.display} Pídeme «¿cómo va a estar la caja?» para ver por qué y qué hacer.`
    : null;
  // La caja en rojo va primero: lo demás puede esperar una semana, eso no.
  if (cashLine && cash?.value === 2) out.push(cashLine);

  const overdue = fact(facts, 'cartera_vencida');
  const debtor = debtorOf(fact(facts, 'top_deudores.0'));
  if (positive(overdue) && debtor)
    out.push(
      `Cobra primero a ${debtor.name}: es quien más debe (${debtor.owes}) de una cartera vencida de ${overdue.display}.`,
    );
  else if (positive(overdue))
    out.push(`Ponle fecha de cobro a la cartera vencida: suma ${overdue.display}.`);
  if (cashLine && cash?.value !== 2) out.push(cashLine);
  const notices = fact(facts, 'cortex.avisos_cartera');
  if (positive(overdue) && notices && notices.value === 0)
    out.push(
      'Activa en /procesos la cartera que avisa sola, para que Cortex le escriba a cada cliente cuando se le vence una factura.',
    );

  const approvals = fact(facts, 'cortex.aprobaciones');
  const drafts = fact(facts, 'cortex.borradores');
  if (positive(approvals) || positive(drafts)) {
    const parts = [
      positive(approvals)
        ? `${approvals.display} ${approvals.value === 1 ? 'acción' : 'acciones'}`
        : null,
      positive(drafts)
        ? `${drafts.display} ${drafts.value === 1 ? 'borrador' : 'borradores'}`
        : null,
    ].filter(Boolean);
    out.push(
      `Revisa lo que espera tu aprobación (${parts.join(' y ')}) en /approvals y /actions: sin tu sí, Cortex no lo hace.`,
    );
  }

  const failing = fact(facts, 'cortex.rutina_fallando.0');
  if (failing) {
    const name = /«(.+)»/.exec(failing.label)?.[1] ?? 'la rutina';
    out.push(
      `Arregla «${name}», que falló ${failing.display} ${failing.value === 1 ? 'vez' : 'veces'} esta semana: ábrela en /schedules y mira el error.`,
    );
  }

  const late = fact(facts, 'compromisos_vencidos');
  if (positive(late))
    out.push(
      `Cierra o ponle nueva fecha a los ${late.display} compromisos vencidos en /commitments.`,
    );
  const due = fact(facts, 'vencen_semana');
  if (positive(due))
    out.push(`Prepara los ${due.display} vencimientos de los próximos siete días (/commitments).`);
  const open = fact(facts, 'pendientes');
  if (positive(open) && (worse.has('pendientes') || out.length < 3))
    out.push(`Decide los ${open.display} asuntos abiertos de Gerencia (/management).`);
  if (worse.has('ventas_mes'))
    out.push(
      'Las ventas del mes van por debajo de hace una semana: revisa con el equipo comercial a los clientes que más compraban.',
    );
  if (worse.has('pagos_mes') && !positive(overdue))
    out.push('Entró menos plata que la semana anterior: confirma los pagos que te prometieron.');

  if (!opts.hasPulse)
    out.push(
      'Arma el pulso de la empresa (pídeme «dime cómo va la empresa») para que la próxima revisión compare tus cifras semana contra semana.',
    );
  else if (!comp.hasBaseline)
    out.push(
      'Deja corriendo el resumen diario del pulso: con las cifras de cada día guardadas, el próximo lunes te digo qué mejoró y qué empeoró.',
    );
  if (opts.hasPulse && !fact(facts, 'metas_cumplidas'))
    out.push('Define las metas del mes en /goals para medir cada semana si se van cumpliendo.');
  return [...new Set(out)].slice(0, 3);
}

/** Lo que Cortex hizo, en una lista corta y sólo con cifras. */
function cortexLines(facts: PulseFact[]): string[] {
  const lines: string[] = [];
  const f = (key: string) => fact(facts, key);
  const sent = f('cortex.envios');
  if (positive(sent))
    lines.push(
      `Envió ${sent.display} ${sent.value === 1 ? 'correo o cobro' : 'correos y cobros'} que aprobaste${positive(f('cortex.envios_fallidos')) ? ` (${f('cortex.envios_fallidos')?.display} fallaron)` : ''}.`,
    );
  const notices = [f('cortex.avisos_cartera'), f('cortex.avisos_compromisos')];
  const noticeParts = [
    positive(notices[0]) ? `${notices[0].display} de facturas vencidas` : null,
    positive(notices[1]) ? `${notices[1].display} de compromisos y vencimientos` : null,
  ].filter(Boolean);
  if (noticeParts.length) lines.push(`Mandó avisos: ${noticeParts.join(' y ')}.`);
  const recovered = f('cortex.recuperado');
  if (positive(recovered)) {
    const n = f('cortex.recuperado_facturas');
    lines.push(
      `Recuperó ${recovered.display}${positive(n) ? ` en ${n.display} ${n.value === 1 ? 'factura' : 'facturas'}` : ''} después de cobrar o avisar.`,
    );
  }
  const runs = f('cortex.rutinas');
  if (positive(runs)) {
    const errors = f('cortex.rutinas_error');
    lines.push(
      `Corrió ${runs.display} ${runs.value === 1 ? 'vez' : 'veces'} tus rutinas${positive(errors) ? `, ${errors.display} con error` : ', todas sin error'}.`,
    );
  }
  const tasks = f('cortex.tareas');
  if (positive(tasks))
    lines.push(`Hizo ${tasks.display} tareas con efecto (registros, envíos, cambios).`);
  const closures = f('cortex.cierres');
  if (positive(closures))
    lines.push(`Se cerraron ${closures.display} asuntos de Gerencia con evidencia.`);
  if (!lines.length)
    lines.push('Esta semana Cortex no registró envíos, avisos, plata recuperada ni rutinas.');
  return lines.slice(0, 5);
}

export interface WeeklyDraft {
  improved: string[];
  worsened: string[];
  cortex: string[];
  next: string[];
}

/** La revisión sin modelo: sólo cifras. Menos elegante, nunca falsa. */
export function fallbackWeekly(comp: WeeklyComposition, recommendations: string[]): WeeklyDraft {
  const line = (d: PulseFact) =>
    `${d.label.charAt(0).toLocaleUpperCase('es-CO')}${d.label.slice(1)}.`;
  return {
    improved: comp.improved.slice(0, 3).map(line),
    worsened: comp.worsened.slice(0, 3).map(line),
    cortex: cortexLines(comp.facts),
    next: recommendations,
  };
}

/** Lo que se dice cuando no hay semana anterior guardada. */
export const NO_BASELINE_LINE =
  'Aún no hay semana anterior para comparar: Cortex guarda las cifras del pulso cada día y el próximo lunes ya dirá qué mejoró y qué empeoró.';
export const NO_PULSE_LINE =
  'No hay un pulso de la empresa con cifras para comparar semana contra semana; abajo va lo que hizo Cortex.';

/** El texto entero de la revisión, para la vista y para la conversación de la rutina. */
export function renderWeekly(
  comp: Pick<WeeklyComposition, 'span' | 'hasBaseline'>,
  draft: WeeklyDraft,
  opts: { today: string; hasPulse: boolean; fallback?: boolean; gaps?: string[] },
): string {
  const clean = (t: string) =>
    t
      .replace(/[ \t\r\n]+/g, ' ')
      .trim()
      .slice(0, 500);
  const list = (items: string[], empty: string) =>
    (items.map(clean).filter(Boolean).length ? items.map(clean).filter(Boolean) : [empty])
      .map((t) => `- ${t}`)
      .join('\n');
  const parts = [`### Revisión semanal · ${comp.span}`];
  if (!opts.hasPulse) parts.push(NO_PULSE_LINE);
  else if (!comp.hasBaseline) parts.push(NO_BASELINE_LINE);
  else {
    parts.push(
      `**Lo que mejoró**\n${list(draft.improved, 'Ninguna cifra del pulso mejoró frente a la semana anterior.')}`,
    );
    parts.push(
      `**Lo que empeoró**\n${list(draft.worsened, 'Ninguna cifra del pulso empeoró frente a la semana anterior.')}`,
    );
  }
  parts.push(
    `**Lo que Cortex hizo por ti**\n${list(draft.cortex, 'Esta semana Cortex no registró actividad.')}`,
  );
  const next = draft.next.map(clean).filter(Boolean).slice(0, 3);
  if (next.length)
    parts.push(`**Para esta semana**\n${next.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
  if (opts.gaps?.length)
    parts.push(`_No pude leer: ${opts.gaps.map((g) => lowerFirst(g)).join('; ')}._`);
  parts.push(
    opts.fallback
      ? `_Armada por Cortex el ${longDay(opts.today)} sólo con las cifras guardadas y el registro de lo que hizo. Las versiones anteriores quedan en el historial._`
      : `_Escrita por Cortex el ${longDay(opts.today)} con las cifras guardadas del pulso y el registro de lo que hizo. Las versiones anteriores quedan en el historial._`,
  );
  return parts.join('\n\n').slice(0, 6000);
}

// ---------------------------------------------------------------------------
// La rutina del lunes
// ---------------------------------------------------------------------------

export interface WeeklyRoutineOptions {
  weekday?: number;
  hour?: number;
  minute?: number;
  timezone?: string;
  notifyEmail?: boolean;
}

/**
 * La fila de `scheduled_jobs` de la revisión semanal: una rutina de
 * HERRAMIENTA (`views.weekly_review`) con la vista fija, igual que el resumen
 * diario. Por defecto, los lunes a las 7:30 a. m. de Bogotá — media hora
 * después del resumen del día, para que la cifra de hoy ya esté guardada.
 */
export function weeklyRoutineRow(
  view: { ref: string; name: string },
  who: { userId: string; agentId: string },
  opts: WeeklyRoutineOptions = {},
) {
  const weekday = opts.weekday ?? WEEKLY_DEFAULT_WEEKDAY;
  const hour = opts.hour ?? WEEKLY_DEFAULT_HOUR;
  const minute = opts.minute ?? WEEKLY_DEFAULT_MINUTE;
  return {
    user_id: who.userId,
    agent_id: who.agentId,
    name: `Revisión semanal: ${view.name}`.slice(0, 120),
    kind: 'tool' as const,
    tool_id: 'views.weekly_review',
    tool_input: { view: view.ref },
    instruction: null,
    schedule_kind: 'cron' as const,
    cron: `${minute} ${hour} * * ${cronWeekdays([weekday])}`,
    timezone: opts.timezone ?? PULSE_DEFAULT_TIMEZONE,
    run_at: null,
    allow_unattended_writes: false,
    notify_conversation: true,
    notify_email: opts.notifyEmail ?? false,
  };
}
