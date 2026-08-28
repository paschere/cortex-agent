import type { SupabaseClient } from '@supabase/supabase-js';
// Straight from the modules rather than through `../actions`, `../payments` and
// `../documents`: those barrels register tools by the mere fact of being
// imported, and a report builder has no business dragging the tool registry in
// behind it.
import { KIND_LABEL as ACTION_KIND_LABEL, type ActionRow } from '../actions/shape';
import { listActions } from '../actions/store';
import {
  type CommitmentRow,
  KIND_LABEL,
  STATE_LABEL,
  addDays,
  bogotaToday,
  daysUntilDue,
  deriveState,
  describeSource,
  listCommitments,
} from '../commitments';
import { fieldLabel, typeLabel } from '../documents/types';
import { type ReceivablesResult, receivables } from '../payments/store';
import {
  type ChartBody,
  type Figure,
  type GeneratedReportKind,
  REPORT_DOCUMENT_VERSION,
  REPORT_KIND_LABEL,
  type ReportDocument,
  type ReportSection,
  type ReportSource,
  type ReportTable,
  type Tone,
  validateDocument,
} from './document';
import {
  clip,
  cop,
  count,
  longDate,
  monthTick,
  plural,
  share,
  shortDate,
  whenPhrase,
} from './format';

/**
 * Rows → ReportDocument. Every number in this product's reports is produced
 * here, by code, from a query.
 *
 * ===========================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ===========================================================================
 * A FIGURE IS BUILT TOGETHER WITH ITS PROVENANCE OR IT IS NOT BUILT.
 *
 * `fig()` is the only way to make a `Figure` in this module, and it takes the
 * source id and the method as required arguments. There is no overload without
 * them, no default, and no "add it later". Every builder below therefore
 * declares its sources FIRST — one per read, stamped with the moment the read
 * happened and the number of rows it returned — and can only then start
 * counting.
 *
 * The queries are ordinary selects and the aggregation is plain TypeScript,
 * deliberately: a `group by` pushed into Postgres is faster and completely
 * opaque to the person who has to defend the figure. Here, the method sentence
 * on each figure is a literal description of the three lines of code above it.
 *
 * ===========================================================================
 * TENANCY
 * ===========================================================================
 * `db` is always a workspace-scoped handle (`ctx.db` / `getOrgScopedClient`).
 * Nothing here filters by organization_id by hand, because nothing here is
 * allowed to be the place that remembers to. This module aggregates and counts,
 * which is the easiest possible place to leak a row from another workspace into
 * a total where nobody would ever see it as a row — so
 * `__tests__/isolation.test.ts` builds all three reports for two companies with
 * deliberately identical-looking data and asserts on the totals, not on the
 * filters.
 *
 * ===========================================================================
 * THE `clients` TABLE (migration 0075, another change)
 * ===========================================================================
 * Not read. It may not exist yet, may exist empty, and either way a report that
 * needs it would be a report that stops working. Client-facing figures come
 * from `commitments.counterparty`, which exists today and is exactly "the
 * client, supplier or authority this is with". `reports.client_id` is the join
 * point for later: when clients has rows, attributing a report to one is a
 * write to a column that is already there, not a migration and not a rewrite.
 */

const DAY_MS = 86_400_000;

/** Nothing is read without a ceiling; a report must not be able to OOM a page. */
const ROW_CAP = 1000;

export interface BuildInput {
  db: SupabaseClient;
  /** Today in Bogotá, `YYYY-MM-DD`. Injected so the builders are testable. */
  today?: string;
  /** The instant stamped on the document and on every source. */
  now?: Date;
  params?: ReportParams;
}

export interface ReportParams {
  /** expiries: how far ahead to look. 1–365. */
  horizonDays?: number;
  /** client_activity: how many months of history to chart. 1–24. */
  months?: number;
  /** client_activity: narrow to counterparties whose name contains this. */
  client?: string | null;
}

// ---------------------------------------------------------------------------
// Small constructors — the only way a figure or a source is made
// ---------------------------------------------------------------------------

function source(input: {
  id: string;
  system: string;
  detail: string;
  readAt: string;
  rowCount: number;
  caveat?: string | null;
}): ReportSource {
  return { caveat: null, ...input };
}

/**
 * The one constructor for a number this report asserts.
 *
 * `sourceId` and `method` are positional and required. That is the mechanism:
 * you cannot absent-mindedly produce an uncited figure, because the shortest
 * way to write one does not compile.
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

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** The last `n` month keys ending at `endYm`, oldest first. */
function monthRange(endYm: string, n: number): string[] {
  const [y, m] = endYm.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** The next `n` month keys starting at `startYm`. */
function monthsAhead(startYm: string, n: number): string[] {
  const [y, m] = startYm.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

const STATE_TONE: Record<string, Tone> = {
  overdue: 'rose',
  due_soon: 'amber',
  in_force: 'emerald',
  met: 'emerald',
  dropped: 'ink',
};

// ---------------------------------------------------------------------------
// 1. Vencimientos
// ---------------------------------------------------------------------------

/**
 * The report this company opens first. What is lapsing, what already lapsed,
 * what it costs if it slips, and where each date came from.
 *
 * Only CONFIRMED commitments are counted. A date a model proposed out of a
 * contract and nobody has checked is a proposal, and putting proposals into a
 * total is how a report becomes something people argue with instead of act on.
 * The unconfirmed ones are counted separately, named in their own metric, and
 * called out in the notes — visible, and outside every other number.
 */
async function buildExpiries(
  input: Required<Omit<BuildInput, 'params'>> & { params: ReportParams },
): Promise<ReportDocument> {
  const { db, today, now, params } = input;
  const horizonDays = clampInt(params.horizonDays, 1, 365, 60);
  const horizonEnd = addDays(today, horizonDays);
  // One read, a year wide, and two different windows taken out of it. The
  // metrics answer "the next N days"; the monthly chart answers "the year
  // ahead". Reading twice would put two different `readAt` stamps on numbers
  // that a reader will compare against each other.
  const yearEnd = addDays(today, 365);
  const readAt = now.toISOString();

  // INTERNAL PROMISES ARE NOT DEADLINES, and this report counts deadlines.
  // «Ana quedó de mandar el informe el viernes» is a commitment and belongs in
  // the weekly report by name, but counting it here would inflate the figure
  // somebody reads as "papers about to expire" — a number whose whole value is
  // that it compares month to month.
  const [rows, pending] = await Promise.all([
    listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: yearEnd,
      today,
      limit: ROW_CAP,
      excludeKinds: ['internal'],
    }),
    listCommitments(db, {
      reviewState: 'pending',
      today,
      limit: 200,
      excludeKinds: ['internal'],
    }),
  ]);

  const SRC = 'commitments';
  const SRC_PENDING = 'commitments_pending';

  const sources: ReportSource[] = [
    source({
      id: SRC,
      system: 'Cortex · commitments',
      detail: `Compromisos confirmados con vencimiento hasta el ${longDate(yearEnd)}, incluidos los ya vencidos. Excluye los cumplidos y los descartados.`,
      readAt,
      rowCount: rows.length,
      caveat:
        rows.length >= ROW_CAP
          ? `La lectura se cortó en ${ROW_CAP} filas; hay más compromisos de los que este informe alcanzó a contar.`
          : null,
    }),
    source({
      id: SRC_PENDING,
      system: 'Cortex · commitments',
      detail:
        'Compromisos extraídos de documentos que todavía nadie confirmó. No entran en ninguna otra cifra de este informe.',
      readAt,
      rowCount: pending.length,
    }),
  ];

  const open = rows.filter((r) => {
    const s = deriveState(r, today);
    return s === 'overdue' || s === 'due_soon' || s === 'in_force';
  });
  const inWindow = open.filter((r) => r.due_on <= horizonEnd);
  const overdue = inWindow.filter((r) => deriveState(r, today) === 'overdue');
  const dueSoon = inWindow.filter((r) => deriveState(r, today) === 'due_soon');
  const inForce = inWindow.filter((r) => deriveState(r, today) === 'in_force');
  const atRisk = [...overdue, ...dueSoon].reduce((sum, r) => sum + (r.amount_cop ?? 0), 0);

  const windowMethod = `Compromisos confirmados con vencimiento entre hoy (${today}) y ${horizonEnd}, más los que ya se vencieron y siguen abiertos.`;

  const metrics: ReportSection = {
    type: 'metrics',
    heading: `Los próximos ${horizonDays} días`,
    items: [
      {
        label: 'Vencidos',
        figure: fig(
          count(overdue.length),
          overdue.length,
          SRC,
          `Conteo de compromisos abiertos cuya fecha ya pasó al ${today}. ${windowMethod}`,
        ),
        sub: overdue.length > 0 ? 'hay que resolverlos hoy' : 'nada pendiente',
        tone: overdue.length > 0 ? 'rose' : 'ink',
      },
      {
        label: 'Por vencer',
        figure: fig(
          count(dueSoon.length),
          dueSoon.length,
          SRC,
          `Conteo de compromisos dentro de su propia ventana de aviso (notice_days por tipo) al ${today}.`,
        ),
        sub: 'dentro de su ventana de aviso',
        tone: dueSoon.length > 0 ? 'amber' : 'ink',
      },
      {
        label: 'Vigentes',
        figure: fig(
          count(inForce.length),
          inForce.length,
          SRC,
          `Conteo de compromisos que vencen antes del ${horizonEnd} pero todavía fuera de su ventana de aviso.`,
        ),
        sub: 'con holgura',
        tone: inForce.length > 0 ? 'emerald' : 'ink',
      },
      {
        label: 'Plata en riesgo',
        figure: fig(
          atRisk > 0 ? cop(atRisk) : '—',
          atRisk,
          SRC,
          'Suma de amount_cop de los compromisos vencidos y por vencer. Los que no tienen monto registrado suman cero, así que esta cifra es un piso, no un total.',
          'COP',
        ),
        sub: 'vencidos y por vencer, con monto',
        tone: atRisk > 0 ? 'rose' : 'ink',
      },
      {
        label: 'Sin confirmar',
        figure: fig(
          count(pending.length),
          pending.length,
          SRC_PENDING,
          'Conteo de compromisos con review_state = pending. Están fuera de todas las demás cifras y no se están vigilando.',
        ),
        sub: pending.length > 0 ? 'nadie los ha revisado' : 'bandeja vacía',
        tone: pending.length > 0 ? 'amber' : 'ink',
      },
    ],
  };

  // --- Timeline -----------------------------------------------------------
  const timelineFrom =
    overdue.length > 0
      ? minDate(
          overdue.map((r) => r.due_on),
          today,
        )
      : today;
  const timelineItems = inWindow.slice(0, 60).map((r) => ({
    label: r.title,
    date: r.due_on,
    detail: `${KIND_LABEL[r.kind] ?? r.kind} · ${whenPhrase(daysUntilDue(r.due_on, today))}`,
    tone: STATE_TONE[deriveState(r, today)] ?? 'primary',
  }));

  const timeline: ChartBody = {
    type: 'timeline',
    from: timelineFrom,
    to: horizonEnd,
    today,
    items: timelineItems,
  };

  const timelineTable: ReportTable = {
    columns: [
      { label: 'Compromiso', align: 'left', mono: false },
      { label: 'Tipo', align: 'left', mono: false },
      { label: 'Vence', align: 'left', mono: true },
      { label: 'Estado', align: 'left', mono: false },
    ],
    rows: timelineItems.map((i) => {
      const row = inWindow.find((r) => r.title === i.label && r.due_on === i.date);
      const state = row ? deriveState(row, today) : 'in_force';
      return [
        cell(i.label),
        cell(row ? (KIND_LABEL[row.kind] ?? row.kind) : '—'),
        cell(shortDate(i.date)),
        cell(STATE_LABEL[state], STATE_TONE[state] ?? null),
      ];
    }),
    sourceId: SRC,
    method: windowMethod,
    caption: null,
  };

  // --- Composition by kind ------------------------------------------------
  const byKind = new Map<string, number>();
  for (const r of inWindow) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  // The modulo cannot leave the array, but an indexed read is typed as possibly
  // absent and the slice type does not accept that. Naming the palette and
  // falling back to its first entry keeps the guarantee in the code rather than
  // in a comment — and if a tone is ever removed from the list, the chart loses
  // a colour instead of failing to compile.
  const SLICE_TONES = ['primary', 'sky', 'emerald', 'amber', 'rose', 'ink'] as const;
  const kindSlices = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n], i) => ({
      label: KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind,
      value: n,
      display: `${count(n)} · ${share(n, inWindow.length)}`,
      tone: SLICE_TONES[i % SLICE_TONES.length] ?? SLICE_TONES[0],
    }));

  // --- Monthly load, a year ahead ----------------------------------------
  const ahead = monthsAhead(monthKey(today), 12);
  const perMonth = new Map<string, number>(ahead.map((m) => [m, 0]));
  for (const r of open) {
    const key = monthKey(r.due_on);
    if (perMonth.has(key)) perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
  }

  const sections: ReportSection[] = [
    {
      type: 'prose',
      heading: null,
      paragraphs: [expiriesLede(overdue.length, dueSoon.length, horizonDays, atRisk)],
    },
    metrics,
    {
      type: 'chart',
      heading: 'Línea de vencimientos',
      chart: timeline,
      altText: `Línea de tiempo con ${count(timelineItems.length)} vencimientos entre el ${shortDate(timelineFrom)} y el ${shortDate(horizonEnd)}. Hoy, ${shortDate(today)}, está marcado con una línea vertical: ${count(overdue.length)} quedan a la izquierda (ya vencidos) y ${count(dueSoon.length + inForce.length)} a la derecha.`,
      caption: `Cada punto es un compromiso, ubicado en el día que se vence. Rojo: vencido. Ámbar: dentro de su ventana de aviso. Verde: todavía con holgura.`,
      table: timelineTable,
      sourceId: SRC,
      method: windowMethod,
    },
    {
      type: 'chart',
      heading: 'De qué son los vencimientos',
      chart: { type: 'composition', slices: kindSlices },
      altText:
        kindSlices.length > 0
          ? `Composición por tipo: ${kindSlices.map((s) => `${s.label}, ${s.display}`).join('; ')}.`
          : 'Sin vencimientos en la ventana, así que no hay composición que mostrar.',
      caption: null,
      table: {
        columns: [
          { label: 'Tipo', align: 'left', mono: false },
          { label: 'Compromisos', align: 'right', mono: true },
          { label: 'Participación', align: 'right', mono: true },
        ],
        rows: kindSlices.map((s) => [
          cell(s.label),
          cell(count(s.value)),
          cell(share(s.value, inWindow.length)),
        ]),
        sourceId: SRC,
        method: `Conteo por columna kind sobre los mismos compromisos de la ventana. ${windowMethod}`,
        caption: null,
      },
      sourceId: SRC,
      method: `Conteo por columna kind sobre los compromisos de la ventana. ${windowMethod}`,
    },
    {
      type: 'chart',
      heading: 'Carga del año que viene',
      chart: {
        type: 'timeseries',
        points: ahead.map((m) => ({ label: monthTick(m), value: perMonth.get(m) ?? 0 })),
        valueUnit: 'compromisos',
        tone: 'primary',
      },
      altText: `Cuántos compromisos vencen en cada uno de los próximos doce meses, de ${monthTick(ahead[0] ?? '')} a ${monthTick(ahead[ahead.length - 1] ?? '')}. El mes más cargado tiene ${count(Math.max(0, ...perMonth.values()))}.`,
      caption:
        'Sirve para ver el mes que se congestiona antes de llegar a él. Sólo cuenta compromisos ya registrados; lo que aún nadie anotó no aparece.',
      table: {
        columns: [
          { label: 'Mes', align: 'left', mono: true },
          { label: 'Vencimientos', align: 'right', mono: true },
        ],
        rows: ahead.map((m) => [cell(monthTick(m)), cell(count(perMonth.get(m) ?? 0))]),
        sourceId: SRC,
        method:
          'Conteo de compromisos abiertos agrupados por el mes de due_on, sobre los próximos doce meses.',
        caption: null,
      },
      sourceId: SRC,
      method:
        'Conteo de compromisos abiertos agrupados por el mes de due_on, sobre los próximos doce meses.',
    },
    {
      type: 'table',
      heading: 'Detalle, con su fuente',
      table: {
        columns: [
          { label: 'Compromiso', align: 'left', mono: false },
          { label: 'Contraparte', align: 'left', mono: false },
          { label: 'Vence', align: 'left', mono: true },
          { label: 'Faltan', align: 'right', mono: true },
          { label: 'Monto', align: 'right', mono: true },
          { label: 'Estado', align: 'left', mono: false },
          { label: 'De dónde salió la fecha', align: 'left', mono: false },
        ],
        rows: inWindow.slice(0, 120).map((r) => {
          const state = deriveState(r, today);
          return [
            cell(r.title),
            cell(r.counterparty ?? '—'),
            cell(shortDate(r.due_on)),
            cell(whenPhrase(daysUntilDue(r.due_on, today))),
            cell(r.amount_cop ? cop(r.amount_cop) : '—'),
            cell(STATE_LABEL[state], STATE_TONE[state] ?? null),
            cell(sourceLabelOf(r)),
          ];
        }),
        sourceId: SRC,
        method: `${windowMethod} La última columna es la procedencia guardada en la propia fila: quién la registró, qué sistema la reportó, o de qué documento se citó.`,
        caption:
          'Cada fila trae la procedencia de su fecha; ninguna cifra de este informe existe sin ella.',
      },
    },
  ];

  const notes = [
    `Los ${count(pending.length)} compromisos sin confirmar quedan fuera de todas las cifras: son propuestas leídas de documentos que todavía nadie revisó, y no se están vigilando.`,
    'La plata en riesgo sólo suma los compromisos que tienen monto registrado. Un contrato sin monto pesa cero aquí y eso no significa que no cueste.',
    'Los cumplidos y los descartados no aparecen: este informe es sobre lo que sigue abierto.',
  ];
  if (inWindow.length > 120) {
    notes.push(
      `La tabla de detalle muestra los primeros 120 de ${count(inWindow.length)} compromisos de la ventana, ordenados por fecha.`,
    );
  }

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'expiries' satisfies GeneratedReportKind,
    title: `${REPORT_KIND_LABEL.expiries} — próximos ${horizonDays} días`,
    subtitle: `Lo que se le vence a la empresa entre hoy y el ${longDate(horizonEnd)}, y lo que ya se pasó y sigue abierto.`,
    periodLabel: `hoy · ${longDate(today)} → ${longDate(horizonEnd)}`,
    generatedAt: readAt,
    timezone: 'America/Bogota',
    sources,
    sections,
    notes,
  });
}

function expiriesLede(
  overdue: number,
  dueSoon: number,
  horizonDays: number,
  atRisk: number,
): string {
  if (overdue === 0 && dueSoon === 0) {
    return `Nada vencido y nada dentro de su ventana de aviso en los próximos ${horizonDays} días. Lo que aparece más abajo es la carga que viene después, para que no llegue de sorpresa.`;
  }
  const parts: string[] = [];
  if (overdue > 0)
    parts.push(`${count(overdue)} ${overdue === 1 ? 'ya se venció' : 'ya se vencieron'}`);
  if (dueSoon > 0)
    parts.push(`${count(dueSoon)} ${dueSoon === 1 ? 'entra' : 'entran'} en su ventana de aviso`);
  const money = atRisk > 0 ? ` Hay ${cop(atRisk)} comprometidos en esas fechas.` : '';
  return `${parts.join(' y ')} en los próximos ${horizonDays} días.${money} Cada fecha de abajo trae la fuente de la que salió.`;
}

/** How a commitment's date is cited, in the words `describeSource` already uses. */
function sourceLabelOf(row: CommitmentRow): string {
  const s = describeSource(row);
  switch (s.kind) {
    case 'system':
      return `${s.label}${s.readAt ? ` · leído ${s.readAt.slice(0, 10)}` : ''}`;
    case 'document':
      return `Documento: ${clip(s.label, 40)}`;
    default:
      return `Registrado por ${clip(s.label, 30)}`;
  }
}

function minDate(dates: string[], fallback: string): string {
  let best = fallback;
  for (const d of dates) if (d < best) best = d;
  return best;
}

// ---------------------------------------------------------------------------
// 2. Estado de la flota
// ---------------------------------------------------------------------------

interface VehicleRow {
  id: string;
  plate: string;
  label: string | null;
  brand: string | null;
  line: string | null;
  model_year: number | null;
  runt_estado: string | null;
  soat_expires_at: string | null;
  rtm_expires_at: string | null;
  last_runt_sync: string | null;
  total_pending_cop: number | null;
  last_simit_sync: string | null;
  archived: boolean | null;
}

interface FineRow {
  vehicle_id: string;
  amount_cop: number | null;
  status: string | null;
  detected_at: string | null;
}

/**
 * The fleet's paperwork, as of the last time anybody actually looked.
 *
 * The load-bearing idea: a SOAT expiry read from RUNT in March is a fact about
 * March. This report never presents one as current — every row carries the
 * moment it was consulted, the source ledger carries the oldest of those
 * moments as a caveat, and a plate nobody has ever consulted is counted in its
 * own bucket ("sin consultar") instead of quietly passing as compliant.
 */
async function buildFleet(
  input: Required<Omit<BuildInput, 'params'>> & { params: ReportParams },
): Promise<ReportDocument> {
  const { db, today, now, params } = input;
  const horizonDays = clampInt(params.horizonDays, 1, 365, 90);
  const horizonEnd = addDays(today, horizonDays);
  const readAt = now.toISOString();

  const { data: vehicleData, error: vehicleError } = await db
    .from('vehicles')
    .select(
      'id, plate, label, brand, line, model_year, runt_estado, soat_expires_at, rtm_expires_at, last_runt_sync, total_pending_cop, last_simit_sync, archived',
    )
    .eq('archived', false)
    .order('plate', { ascending: true })
    .limit(ROW_CAP);
  if (vehicleError) throw new Error(`No se pudo leer la flota: ${vehicleError.message}`);
  const vehicles = (vehicleData ?? []) as unknown as VehicleRow[];

  const { data: fineData, error: fineError } = await db
    .from('vehicle_fines')
    .select('vehicle_id, amount_cop, status, detected_at')
    .eq('status', 'PENDING')
    .limit(ROW_CAP);
  if (fineError) throw new Error(`No se pudieron leer las multas: ${fineError.message}`);
  const fines = ((fineData ?? []) as unknown as FineRow[]).filter((f) =>
    vehicles.some((v) => v.id === f.vehicle_id),
  );

  const SRC_V = 'vehicles';
  const SRC_F = 'vehicle_fines';

  const oldestRunt = vehicles
    .map((v) => v.last_runt_sync)
    .filter((s): s is string => Boolean(s))
    .sort()[0];
  const neverChecked = vehicles.filter((v) => !v.last_runt_sync).length;

  const sources: ReportSource[] = [
    source({
      id: SRC_V,
      system: 'Cortex · vehicles (datos de RUNT)',
      detail:
        'Placas activas del taller, con la vigencia de SOAT y tecnomecánica tal como las devolvió el RUNT en la última consulta de cada placa.',
      readAt,
      rowCount: vehicles.length,
      caveat: buildFleetCaveat(oldestRunt, neverChecked),
    }),
    source({
      id: SRC_F,
      system: 'Cortex · vehicle_fines (datos de SIMIT)',
      detail: 'Comparendos en estado PENDING de las placas activas, como los reportó SIMIT.',
      readAt,
      rowCount: fines.length,
      caveat: null,
    }),
  ];

  const classify = (expiry: string | null): { tone: Tone; label: string } => {
    if (!expiry) return { tone: 'ink', label: 'Sin consultar' };
    const left = daysUntilDue(expiry, today);
    if (left < 0) return { tone: 'rose', label: 'Vencido' };
    if (left <= 30) return { tone: 'amber', label: 'Por vencer' };
    return { tone: 'emerald', label: 'Al día' };
  };

  const soatOverdue = vehicles.filter((v) => classify(v.soat_expires_at).tone === 'rose').length;
  const soatSoon = vehicles.filter((v) => classify(v.soat_expires_at).tone === 'amber').length;
  const rtmOverdue = vehicles.filter((v) => classify(v.rtm_expires_at).tone === 'rose').length;
  const rtmSoon = vehicles.filter((v) => classify(v.rtm_expires_at).tone === 'amber').length;
  const finesTotal = fines.reduce((sum, f) => sum + (f.amount_cop ?? 0), 0);

  const metrics: ReportSection = {
    type: 'metrics',
    heading: 'La flota hoy',
    items: [
      {
        label: 'Placas activas',
        figure: fig(
          count(vehicles.length),
          vehicles.length,
          SRC_V,
          'Conteo de vehículos con archived = false.',
        ),
        sub: neverChecked > 0 ? `${count(neverChecked)} sin consultar nunca` : 'todas consultadas',
        tone: 'primary',
      },
      {
        label: 'SOAT vencido',
        figure: fig(
          count(soatOverdue),
          soatOverdue,
          SRC_V,
          `Conteo de placas cuya soat_expires_at es anterior a hoy (${today}).`,
        ),
        sub: soatOverdue > 0 ? 'no pueden rodar' : 'ninguno',
        tone: soatOverdue > 0 ? 'rose' : 'emerald',
      },
      {
        label: 'SOAT por vencer',
        figure: fig(
          count(soatSoon),
          soatSoon,
          SRC_V,
          `Conteo de placas cuya soat_expires_at cae dentro de los 30 días siguientes a hoy (${today}).`,
        ),
        sub: 'dentro de 30 días',
        tone: soatSoon > 0 ? 'amber' : 'ink',
      },
      {
        label: 'Tecnomecánica vencida',
        figure: fig(
          count(rtmOverdue),
          rtmOverdue,
          SRC_V,
          `Conteo de placas cuya rtm_expires_at es anterior a hoy (${today}).`,
        ),
        sub: rtmSoon > 0 ? `${count(rtmSoon)} más por vencer` : 'ninguna próxima',
        tone: rtmOverdue > 0 ? 'rose' : 'emerald',
      },
      {
        label: 'Multas pendientes',
        figure: fig(
          finesTotal > 0 ? cop(finesTotal) : '—',
          finesTotal,
          SRC_F,
          'Suma de amount_cop de los comparendos en estado PENDING de las placas activas. SIMIT incluye intereses en cada monto.',
          'COP',
        ),
        sub: `${count(fines.length)} ${fines.length === 1 ? 'comparendo' : 'comparendos'}`,
        tone: finesTotal > 0 ? 'rose' : 'emerald',
      },
    ],
  };

  // --- Timeline of fleet paperwork ---------------------------------------
  const timelineItems = vehicles
    .flatMap((v) => [
      v.soat_expires_at
        ? {
            label: `SOAT ${v.plate}`,
            date: v.soat_expires_at.slice(0, 10),
            detail: 'SOAT',
            tone: classify(v.soat_expires_at).tone,
          }
        : null,
      v.rtm_expires_at
        ? {
            label: `RTM ${v.plate}`,
            date: v.rtm_expires_at.slice(0, 10),
            detail: 'Tecnomecánica',
            tone: classify(v.rtm_expires_at).tone,
          }
        : null,
    ])
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((x) => x.date <= horizonEnd)
    .slice(0, 60);

  const timelineFrom = minDate(
    timelineItems.map((i) => i.date),
    today,
  );

  // --- Composition of documentary state ----------------------------------
  const buckets: Array<{ label: string; tone: Tone; n: number }> = [
    { label: 'Al día', tone: 'emerald', n: 0 },
    { label: 'Por vencer', tone: 'amber', n: 0 },
    { label: 'Vencido', tone: 'rose', n: 0 },
    { label: 'Sin consultar', tone: 'ink', n: 0 },
  ];
  const bump = (tone: Tone) => {
    const b = buckets.find((x) => x.tone === tone);
    if (b) b.n += 1;
  };
  for (const v of vehicles) {
    bump(classify(v.soat_expires_at).tone);
    bump(classify(v.rtm_expires_at).tone);
  }
  const docTotal = buckets.reduce((s, b) => s + b.n, 0);

  // --- Fines per plate ----------------------------------------------------
  const finesByVehicle = new Map<string, number>();
  for (const f of fines) {
    finesByVehicle.set(f.vehicle_id, (finesByVehicle.get(f.vehicle_id) ?? 0) + (f.amount_cop ?? 0));
  }
  const fineBars = [...finesByVehicle.entries()]
    .map(([id, amount]) => ({
      label: vehicles.find((v) => v.id === id)?.plate ?? '—',
      value: amount,
      display: cop(amount),
      tone: 'rose' as Tone,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const sections: ReportSection[] = [
    {
      type: 'prose',
      heading: null,
      paragraphs: [
        vehicles.length === 0
          ? 'Todavía no hay placas registradas. Registra la primera y consulta su RUNT: desde ahí el SOAT y la tecnomecánica entran solos a la vigilancia diaria.'
          : `${count(vehicles.length)} ${vehicles.length === 1 ? 'placa activa' : 'placas activas'}. Cada vigencia de abajo es lo que el RUNT reportó el día que se consultó esa placa, no una verdad permanente: la fecha de consulta está en la tabla y en la ficha de fuentes.`,
      ],
    },
    metrics,
    {
      type: 'chart',
      heading: 'Vigencias de la flota',
      chart: {
        type: 'timeline',
        from: timelineFrom,
        to: horizonEnd,
        today,
        items: timelineItems,
      },
      altText: `Línea de tiempo con ${count(timelineItems.length)} vigencias de SOAT y tecnomecánica que caen antes del ${shortDate(horizonEnd)}. Hoy está marcado con una línea vertical.`,
      caption: 'Cada punto es un documento de una placa, ubicado en el día que deja de valer.',
      table: {
        columns: [
          { label: 'Documento', align: 'left', mono: true },
          { label: 'Vence', align: 'left', mono: true },
          { label: 'Faltan', align: 'right', mono: true },
        ],
        rows: timelineItems.map((i) => [
          cell(i.label),
          cell(shortDate(i.date)),
          cell(whenPhrase(daysUntilDue(i.date, today)), i.tone),
        ]),
        sourceId: SRC_V,
        method: `Fechas soat_expires_at y rtm_expires_at de las placas activas, filtradas a las que caen antes del ${horizonEnd}.`,
        caption: null,
      },
      sourceId: SRC_V,
      method: `Fechas soat_expires_at y rtm_expires_at de las placas activas, filtradas a las que caen antes del ${horizonEnd}.`,
    },
    {
      type: 'chart',
      heading: 'Estado documental',
      chart: {
        type: 'composition',
        slices: buckets
          .filter((b) => b.n > 0)
          .map((b) => ({
            label: b.label,
            value: b.n,
            display: `${count(b.n)} · ${share(b.n, docTotal)}`,
            tone: b.tone,
          })),
      },
      altText:
        docTotal > 0
          ? `De ${count(docTotal)} documentos de flota (SOAT y tecnomecánica de cada placa): ${buckets
              .filter((b) => b.n > 0)
              .map((b) => `${b.label.toLowerCase()}, ${count(b.n)}`)
              .join('; ')}.`
          : 'Sin placas registradas, no hay estado documental que mostrar.',
      caption:
        '"Sin consultar" no es lo mismo que "al día": es una placa cuyo RUNT nadie ha mirado todavía.',
      table: {
        columns: [
          { label: 'Estado', align: 'left', mono: false },
          { label: 'Documentos', align: 'right', mono: true },
          { label: 'Participación', align: 'right', mono: true },
        ],
        rows: buckets.map((b) => [
          cell(b.label, b.tone),
          cell(count(b.n)),
          cell(share(b.n, docTotal)),
        ]),
        sourceId: SRC_V,
        method:
          'Cada placa aporta dos documentos (SOAT y tecnomecánica). Vencido: fecha anterior a hoy. Por vencer: dentro de 30 días. Sin consultar: la columna viene nula porque nunca se consultó el RUNT de esa placa.',
        caption: null,
      },
      sourceId: SRC_V,
      method:
        'Cada placa aporta dos documentos (SOAT y tecnomecánica), clasificados contra la fecha de hoy en Colombia.',
    },
    ...(fineBars.length > 0
      ? [
          {
            type: 'chart' as const,
            heading: 'Multas pendientes por placa',
            chart: { type: 'bars' as const, bars: fineBars },
            altText: `Comparendos pendientes por placa: ${fineBars
              .slice(0, 5)
              .map((b) => `${b.label}, ${b.display}`)
              .join('; ')}${fineBars.length > 5 ? ', y otras placas con menos' : ''}.`,
            caption: 'Montos como los reporta SIMIT, con intereses incluidos.',
            table: {
              columns: [
                { label: 'Placa', align: 'left' as const, mono: true },
                { label: 'Pendiente', align: 'right' as const, mono: true },
              ],
              rows: fineBars.map((b) => [cell(b.label), cell(b.display, 'rose' as Tone)]),
              sourceId: SRC_F,
              method:
                'Suma de amount_cop de los comparendos PENDING, agrupada por vehicle_id y ordenada de mayor a menor.',
              caption: null,
            },
            sourceId: SRC_F,
            method:
              'Suma de amount_cop de los comparendos PENDING, agrupada por vehicle_id y ordenada de mayor a menor.',
          },
        ]
      : []),
    {
      type: 'table',
      heading: 'Placa por placa',
      table: {
        columns: [
          { label: 'Placa', align: 'left', mono: true },
          { label: 'Vehículo', align: 'left', mono: false },
          { label: 'SOAT', align: 'left', mono: true },
          { label: 'Tecnomecánica', align: 'left', mono: true },
          { label: 'Multas', align: 'right', mono: true },
          { label: 'RUNT consultado', align: 'left', mono: true },
        ],
        rows: vehicles.map((v) => {
          const soat = classify(v.soat_expires_at);
          const rtm = classify(v.rtm_expires_at);
          const pending = finesByVehicle.get(v.id) ?? 0;
          return [
            cell(v.plate),
            cell([v.brand, v.line, v.model_year].filter(Boolean).join(' ') || (v.label ?? '—')),
            cell(
              v.soat_expires_at ? shortDate(v.soat_expires_at.slice(0, 10)) : 'sin dato',
              soat.tone,
            ),
            cell(
              v.rtm_expires_at ? shortDate(v.rtm_expires_at.slice(0, 10)) : 'sin dato',
              rtm.tone,
            ),
            cell(pending > 0 ? cop(pending) : '—', pending > 0 ? 'rose' : null),
            cell(
              v.last_runt_sync ? v.last_runt_sync.slice(0, 10) : 'nunca',
              v.last_runt_sync ? null : 'amber',
            ),
          ];
        }),
        sourceId: SRC_V,
        method:
          'Una fila por placa activa. Las vigencias son las que devolvió el RUNT en la fecha de la última columna; las multas vienen de los comparendos PENDING de SIMIT.',
        caption: 'La última columna es la que hace verificable a todas las demás.',
      },
    },
  ];

  const notes = [
    'RUNT y SIMIT se consultan por placa y bajo demanda. Una vigencia sólo es tan reciente como la fecha de su última consulta, que está en la tabla.',
    'Las placas archivadas no aparecen.',
  ];
  if (neverChecked > 0) {
    notes.push(
      `${count(neverChecked)} ${neverChecked === 1 ? 'placa no tiene' : 'placas no tienen'} ninguna consulta de RUNT: sus vigencias son desconocidas, no correctas.`,
    );
  }

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'fleet' satisfies GeneratedReportKind,
    title: `${REPORT_KIND_LABEL.fleet} — ${longDate(today)}`,
    subtitle:
      'SOAT, tecnomecánica y comparendos de cada placa activa, con la fecha en que se consultó cada registro.',
    periodLabel: `estado al ${longDate(today)} · vigencias hasta ${longDate(horizonEnd)}`,
    generatedAt: readAt,
    timezone: 'America/Bogota',
    sources,
    sections,
    notes,
  });
}

function buildFleetCaveat(oldestRunt: string | undefined, neverChecked: number): string | null {
  const bits: string[] = [];
  if (oldestRunt) {
    bits.push(`La consulta de RUNT más antigua de esta flota es del ${oldestRunt.slice(0, 10)}.`);
  }
  if (neverChecked > 0) {
    bits.push(
      `${count(neverChecked)} ${neverChecked === 1 ? 'placa nunca se ha consultado' : 'placas nunca se han consultado'}.`,
    );
  }
  return bits.length > 0 ? bits.join(' ') : null;
}

// ---------------------------------------------------------------------------
// 3. Actividad por cliente
// ---------------------------------------------------------------------------

interface DocumentRow {
  id: string;
  title: string;
  created_at: string;
}

/**
 * What each counterparty has hanging, in plata and in dates.
 *
 * Grouped on `commitments.counterparty` — the free-text name of the client,
 * supplier or authority a commitment is with. That is a deliberate choice over
 * waiting for `public.clients` (migration 0075): the column exists today, it is
 * what the operations team actually typed, and a report that needs a table that
 * may still be empty is a report that shows nothing on the day it ships.
 *
 * The cost is honest and stated in the notes: two spellings of the same client
 * are two rows here. When `clients` has rows, `reports.client_id` is where the
 * attribution goes and this grouping becomes a join — additively, without
 * touching anything that already works.
 */
async function buildClientActivity(
  input: Required<Omit<BuildInput, 'params'>> & { params: ReportParams },
): Promise<ReportDocument> {
  const { db, today, now, params } = input;
  const months = clampInt(params.months, 1, 24, 6);
  const clientFilter = (params.client ?? '').trim().toLowerCase();
  const readAt = now.toISOString();
  const window = monthRange(monthKey(today), months);
  const windowStart = `${window[0]}-01`;

  const [allRows, docs] = await Promise.all([
    // Same exclusion as the expiries report: this one is about what a CLIENT
    // has going on, and a promise between two colleagues here is not that.
    listCommitments(db, {
      reviewState: 'confirmed',
      dueBefore: addDays(today, 365),
      today,
      limit: ROW_CAP,
      excludeKinds: ['internal'],
    }),
    db
      .from('kb_documents')
      .select('id, title, created_at')
      .gte('created_at', `${windowStart}T00:00:00Z`)
      .limit(ROW_CAP)
      .then(({ data, error }) => {
        if (error) throw new Error(`No se pudo leer Brain Knowledge: ${error.message}`);
        return (data ?? []) as unknown as DocumentRow[];
      }),
  ]);

  const rows = clientFilter
    ? allRows.filter((r) => (r.counterparty ?? '').toLowerCase().includes(clientFilter))
    : allRows;

  const SRC = 'commitments';
  const SRC_DOCS = 'kb_documents';

  const sources: ReportSource[] = [
    source({
      id: SRC,
      system: 'Cortex · commitments',
      detail: clientFilter
        ? `Compromisos confirmados y abiertos cuya contraparte contiene «${params.client}».`
        : 'Compromisos confirmados y abiertos, agrupados por la contraparte anotada en cada uno.',
      readAt,
      rowCount: rows.length,
      caveat:
        'La contraparte es texto escrito a mano. Dos formas de escribir el mismo cliente cuentan como dos contrapartes distintas.',
    }),
    source({
      id: SRC_DOCS,
      system: 'Cortex · kb_documents (Brain Knowledge)',
      detail: `Documentos incorporados a Brain Knowledge desde el ${longDate(windowStart)}.`,
      readAt,
      rowCount: docs.length,
      caveat:
        'Un documento no está atado a un cliente todavía, así que esta cifra mide actividad de la empresa, no de una contraparte concreta.',
    }),
  ];

  interface Bucket {
    name: string;
    total: number;
    overdue: number;
    dueSoon: number;
    inForce: number;
    amount: number;
    next: string | null;
  }
  const byClient = new Map<string, Bucket>();
  for (const r of rows) {
    const name = (r.counterparty ?? '').trim() || 'Sin contraparte anotada';
    const b = byClient.get(name) ?? {
      name,
      total: 0,
      overdue: 0,
      dueSoon: 0,
      inForce: 0,
      amount: 0,
      next: null,
    };
    const state = deriveState(r, today);
    if (state === 'met' || state === 'dropped') continue;
    b.total += 1;
    if (state === 'overdue') b.overdue += 1;
    if (state === 'due_soon') b.dueSoon += 1;
    if (state === 'in_force') b.inForce += 1;
    b.amount += r.amount_cop ?? 0;
    if (!b.next || r.due_on < b.next) b.next = r.due_on;
    byClient.set(name, b);
  }

  const buckets = [...byClient.values()].sort(
    (a, b) => b.amount - a.amount || b.total - a.total || a.name.localeCompare(b.name),
  );
  const totalAmount = buckets.reduce((s, b) => s + b.amount, 0);
  const totalOverdue = buckets.reduce((s, b) => s + b.overdue, 0);

  const perMonth = new Map<string, number>(window.map((m) => [m, 0]));
  for (const r of rows) {
    const key = monthKey(r.created_at.slice(0, 10));
    if (perMonth.has(key)) perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
  }

  const metrics: ReportSection = {
    type: 'metrics',
    heading: 'El corte',
    items: [
      {
        label: 'Contrapartes',
        figure: fig(
          count(buckets.length),
          buckets.length,
          SRC,
          'Conteo de valores distintos de counterparty entre los compromisos abiertos y confirmados.',
        ),
        sub: 'con algo abierto',
        tone: 'primary',
      },
      {
        label: 'Comprometido',
        figure: fig(
          totalAmount > 0 ? cop(totalAmount) : '—',
          totalAmount,
          SRC,
          'Suma de amount_cop de los compromisos abiertos. Los que no tienen monto suman cero.',
          'COP',
        ),
        sub: 'en compromisos abiertos',
        tone: 'primary',
      },
      {
        label: 'Vencidos',
        figure: fig(
          count(totalOverdue),
          totalOverdue,
          SRC,
          `Conteo de compromisos abiertos cuya fecha ya pasó al ${today}, sumado sobre todas las contrapartes.`,
        ),
        sub: totalOverdue > 0 ? 'repartidos entre contrapartes' : 'ninguno',
        tone: totalOverdue > 0 ? 'rose' : 'emerald',
      },
      {
        label: 'Documentos nuevos',
        figure: fig(
          count(docs.length),
          docs.length,
          SRC_DOCS,
          `Conteo de documentos de Brain Knowledge con created_at posterior al ${windowStart}.`,
        ),
        sub: `últimos ${months} ${months === 1 ? 'mes' : 'meses'}`,
        tone: 'sky',
      },
    ],
  };

  const bars = buckets
    .filter((b) => b.amount > 0)
    .slice(0, 12)
    .map((b) => ({
      label: b.name,
      value: b.amount,
      display: cop(b.amount),
      tone: (b.overdue > 0 ? 'rose' : 'primary') as Tone,
    }));

  const stateSlices = [
    { label: 'Vencidos', tone: 'rose' as Tone, n: buckets.reduce((s, b) => s + b.overdue, 0) },
    { label: 'Por vencer', tone: 'amber' as Tone, n: buckets.reduce((s, b) => s + b.dueSoon, 0) },
    { label: 'Vigentes', tone: 'emerald' as Tone, n: buckets.reduce((s, b) => s + b.inForce, 0) },
  ];
  const stateTotal = stateSlices.reduce((s, x) => s + x.n, 0);

  const sections: ReportSection[] = [
    {
      type: 'prose',
      heading: null,
      paragraphs: [
        buckets.length === 0
          ? 'No hay compromisos abiertos con ninguna contraparte en este corte. Cuando se registre el primero — o cuando Cortex lea uno de un contrato y alguien lo confirme — aparecerá aquí.'
          : `${count(buckets.length)} ${buckets.length === 1 ? 'contraparte tiene' : 'contrapartes tienen'} algo abierto con la empresa${totalAmount > 0 ? `, por ${cop(totalAmount)}` : ''}. Están ordenadas por plata comprometida, y la que tiene algo vencido va marcada en rojo.`,
      ],
    },
    metrics,
    {
      type: 'chart',
      heading: 'Quién pesa más',
      chart: { type: 'bars', bars },
      altText:
        bars.length > 0
          ? `Contrapartes por plata comprometida: ${bars
              .slice(0, 5)
              .map((b) => `${b.label}, ${b.display}`)
              .join('; ')}${bars.length > 5 ? `, y ${count(bars.length - 5)} más` : ''}.`
          : 'Ninguna contraparte tiene compromisos con monto registrado.',
      caption: 'Rojo cuando esa contraparte tiene por lo menos un compromiso vencido.',
      table: {
        columns: [
          { label: 'Contraparte', align: 'left', mono: false },
          { label: 'Comprometido', align: 'right', mono: true },
        ],
        rows: bars.map((b) => [cell(b.label), cell(b.display, b.tone)]),
        sourceId: SRC,
        method:
          'Suma de amount_cop de los compromisos abiertos, agrupada por counterparty y ordenada de mayor a menor.',
        caption: null,
      },
      sourceId: SRC,
      method:
        'Suma de amount_cop de los compromisos abiertos, agrupada por counterparty y ordenada de mayor a menor.',
    },
    {
      type: 'chart',
      heading: 'En qué estado está lo abierto',
      chart: {
        type: 'composition',
        slices: stateSlices
          .filter((s) => s.n > 0)
          .map((s) => ({
            label: s.label,
            value: s.n,
            display: `${count(s.n)} · ${share(s.n, stateTotal)}`,
            tone: s.tone,
          })),
      },
      altText:
        stateTotal > 0
          ? `De ${count(stateTotal)} compromisos abiertos: ${stateSlices
              .filter((s) => s.n > 0)
              .map((s) => `${s.label.toLowerCase()}, ${count(s.n)}`)
              .join('; ')}.`
          : 'No hay compromisos abiertos que clasificar.',
      caption: null,
      table: {
        columns: [
          { label: 'Estado', align: 'left', mono: false },
          { label: 'Compromisos', align: 'right', mono: true },
          { label: 'Participación', align: 'right', mono: true },
        ],
        rows: stateSlices.map((s) => [
          cell(s.label, s.tone),
          cell(count(s.n)),
          cell(share(s.n, stateTotal)),
        ]),
        sourceId: SRC,
        method:
          'Estado derivado de due_on y notice_days contra la fecha de hoy en Colombia, no leído de la columna state (que es una caché).',
        caption: null,
      },
      sourceId: SRC,
      method:
        'Estado derivado de due_on y notice_days contra la fecha de hoy en Colombia, no leído de la columna state (que es una caché).',
    },
    {
      type: 'chart',
      heading: 'Cuánto se registró cada mes',
      chart: {
        type: 'timeseries',
        points: window.map((m) => ({ label: monthTick(m), value: perMonth.get(m) ?? 0 })),
        valueUnit: 'compromisos',
        tone: 'sky',
      },
      altText: `Compromisos registrados por mes, de ${monthTick(window[0] ?? '')} a ${monthTick(window[window.length - 1] ?? '')}. El mes más activo tuvo ${count(Math.max(0, ...perMonth.values()))}.`,
      caption:
        'Mide el ritmo con que la empresa anota lo que promete, no lo que se vence. Un mes flojo aquí suele ser un mes en que nadie registró, no un mes sin compromisos.',
      table: {
        columns: [
          { label: 'Mes', align: 'left', mono: true },
          { label: 'Registrados', align: 'right', mono: true },
        ],
        rows: window.map((m) => [cell(monthTick(m)), cell(count(perMonth.get(m) ?? 0))]),
        sourceId: SRC,
        method: `Conteo de compromisos agrupados por el mes de created_at, sobre los últimos ${months} meses.`,
        caption: null,
      },
      sourceId: SRC,
      method: `Conteo de compromisos agrupados por el mes de created_at, sobre los últimos ${months} meses.`,
    },
    {
      type: 'table',
      heading: 'Contraparte por contraparte',
      table: {
        columns: [
          { label: 'Contraparte', align: 'left', mono: false },
          { label: 'Abiertos', align: 'right', mono: true },
          { label: 'Vencidos', align: 'right', mono: true },
          { label: 'Comprometido', align: 'right', mono: true },
          { label: 'Próximo vencimiento', align: 'left', mono: true },
        ],
        rows: buckets
          .slice(0, 60)
          .map((b) => [
            cell(b.name),
            cell(count(b.total)),
            cell(count(b.overdue), b.overdue > 0 ? 'rose' : null),
            cell(b.amount > 0 ? cop(b.amount) : '—'),
            cell(
              b.next ? `${shortDate(b.next)} · ${whenPhrase(daysUntilDue(b.next, today))}` : '—',
              b.next && daysUntilDue(b.next, today) < 0 ? 'rose' : null,
            ),
          ]),
        sourceId: SRC,
        method:
          'Una fila por valor distinto de counterparty. Abiertos, vencidos y comprometido son conteos y sumas sobre los compromisos de esa contraparte; el próximo vencimiento es el menor due_on abierto.',
        caption: null,
      },
    },
  ];

  const notes = [
    'La contraparte es un campo de texto. «Servientrega» y «SERVIENTREGA S.A.» cuentan como dos, y esa es la limitación real de este corte mientras el directorio de clientes no esté poblado.',
    'Sólo cuenta lo que está confirmado y abierto: lo cumplido, lo descartado y lo que espera revisión quedan fuera.',
  ];
  if (clientFilter) {
    notes.push(
      `Este informe está filtrado a las contrapartes cuyo nombre contiene «${params.client}». No es el total de la empresa.`,
    );
  }

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'client_activity' satisfies GeneratedReportKind,
    title: clientFilter
      ? `${REPORT_KIND_LABEL.client_activity} — ${params.client}`
      : `${REPORT_KIND_LABEL.client_activity} — ${longDate(today)}`,
    subtitle:
      'Qué tiene comprometido cada contraparte, cuánto pesa en plata y qué se le vence primero.',
    periodLabel: `últimos ${months} ${months === 1 ? 'mes' : 'meses'} · corte al ${longDate(today)}`,
    generatedAt: readAt,
    timezone: 'America/Bogota',
    sources,
    sections,
    notes,
  });
}

// ---------------------------------------------------------------------------
// 4. El parte semanal
// ---------------------------------------------------------------------------

/**
 * EL INFORME QUE NADIE PIDE.
 *
 * Los tres de arriba se generan cuando alguien pulsa un botón. Éste sale solo,
 * cada lunes temprano en Bogotá, y va a quien responde por la empresa. Ésa es
 * toda la diferencia y cambia lo que puede decir: un informe que alguien pidió
 * puede permitirse ser un corte de datos; uno que llega sin que lo pidan tiene
 * que justificar la interrupción en la primera pantalla, o la segunda semana ya
 * nadie lo abre.
 *
 * ===========================================================================
 * DE QUÉ HABLA, Y POR QUÉ DE ESO
 * ===========================================================================
 * De hechos con dueño y con fecha, y de los huecos entre ellos:
 *
 *   1. qué se vence la semana que entra y qué se pasó   (papeles, no promesas)
 *   2. qué se cumplió la semana que acabó
 *   3. quién debe qué                                    (promesas y papeles,
 *                                                         contados aparte)
 *   4. qué propuso Cortex y en qué quedó
 *   5. los silencios: lo que salió y nadie contestó
 *   6. lo que quedó sin revisar
 *   7. la flota, con la fecha en que se consultó cada registro
 *   8. dónde se equivoca Cortex leyendo
 *   9. la cartera, si la hay, con su confesión pegada
 *
 * NUNCA: ingresos, crecimiento, márgenes, «todo va bien». No porque estén
 * prohibidos por gusto, sino porque este producto no los sabe, y una cifra de
 * negocio inventada en un correo automático desacredita de paso a las nueve que
 * sí son ciertas.
 *
 * La sección 8 es la que compra la confianza de las otras ocho: un gerente que
 * reporta sus propios errores de lectura es un gerente al que se le cree el
 * resto. Se paga barato — es un `select` sobre `document_field_corrections` — y
 * es lo único del parte que hace quedar mal a quien lo escribe.
 *
 * ===========================================================================
 * POR QUÉ EL AGRUPADO POR PERSONA SE INYECTA
 * ===========================================================================
 * «Quién debe qué» ya está resuelto, y bien, en
 * apps/web/app/(app)/commitments/_lib/people.ts: promesas y papeles nunca se
 * suman, lo que no tiene dueño va al final, y el orden es por atrasos y no por
 * volumen. Reescribirlo aquí produciría dos respuestas distintas a la misma
 * pregunta — la pantalla diciendo una cosa y el correo del lunes otra — que es
 * exactamente el fallo que un informe automático no se puede permitir.
 *
 * Y un paquete no puede importar de una aplicación. Así que la función entra
 * como argumento: `groupByPerson` está tipada estructuralmente contra lo que
 * `buildPeopleLoad` ya devuelve, sin que este archivo dependa de aquél. Quien
 * llama (el cron) le pasa la de verdad.
 */

/** Lo que el parte necesita de una persona. Subconjunto de `PersonLoad`. */
export interface WeeklyPerson {
  name: string;
  unassigned: boolean;
  /** Promesas entre personas: `kind = 'internal'`. */
  promises: { open: number; overdue: number };
  /** Papeles con vencimiento: todo lo demás. */
  papers: { open: number; overdue: number };
  items: Array<{
    title: string;
    internal: boolean;
    dueOn: string;
    daysLeft: number;
    stateLabel: string;
  }>;
}

/** Lo que el parte necesita del agrupado entero. Subconjunto de `PeopleLoad`. */
export interface WeeklyPeople {
  pending: WeeklyPerson[];
}

/**
 * La firma de `buildPeopleLoad`, escrita aquí para no depender de la app.
 *
 * Es estructural a propósito: si aquella función cambia de forma, esto deja de
 * compilar en el sitio que la inyecta, que es donde se puede arreglar.
 */
export type GroupByPerson = (input: {
  open: CommitmentRow[];
  closed: CommitmentRow[];
  today: string;
}) => WeeklyPeople;

export interface WeeklyInput {
  db: SupabaseClient;
  /** Hoy en Bogotá: el lunes en que sale el parte. */
  today?: string;
  now?: Date;
  /** El lunes con que empieza la semana que se reporta. Por defecto, la pasada. */
  weekStart?: string;
  groupByPerson: GroupByPerson;
}

/** El lunes de la semana de `date`, en el calendario colombiano. */
export function mondayOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  // getUTCDay: 0 es domingo. Se convierte a «cuántos días hay que retroceder
  // hasta el lunes», que para domingo son seis y no cero.
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return addDays(date, -back);
}

/** El día colombiano de un instante. `met_at`, `executed_at`, `created_at`: todos
 * son instantes, y la semana que reporta el parte es calendario colombiano. */
function bogotaDayOf(instant: string | null): string | null {
  if (!instant) return null;
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? null : bogotaToday(at);
}

/** "del 3 al 9 de agosto de 2026" cuando cabe, y con los dos meses cuando no. */
export function weekSpan(from: string, to: string): string {
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth
    ? `del ${Number(from.slice(8))} al ${longDate(to)}`
    : `del ${longDate(from)} al ${longDate(to)}`;
}

interface PendingExtractionRow {
  id: string;
  doc_type: string | null;
  counterparty_name: string | null;
  doc_number: string | null;
  created_at: string;
}

interface CorrectionRow {
  doc_type: string | null;
  field_key: string;
  outcome: string;
  corrected_at: string;
}

export async function buildWeekly(input: WeeklyInput): Promise<ReportDocument> {
  const db = input.db;
  const now = input.now ?? new Date();
  const today = input.today ?? bogotaToday(now);
  // Por defecto, la semana que acaba de cerrarse: el lunes de la semana de hoy,
  // menos siete. Ejecutado un lunes eso es el lunes anterior; ejecutado
  // cualquier otro día (una reejecución a mano, una prueba) sigue apuntando a la
  // última semana completa, que es lo que un parte reporta.
  const weekStart = input.weekStart ?? addDays(mondayOf(today), -7);
  const weekEnd = addDays(weekStart, 6);
  const aheadStart = addDays(weekEnd, 1);
  const aheadEnd = addDays(aheadStart, 6);
  const readAt = now.toISOString();
  // `met_at` es un instante; la semana es calendario colombiano. Bogotá es
  // UTC-5 todo el año, así que el lunes a las 00:00 de allá son las 05:00 UTC.
  const weekStartInstant = `${weekStart}T05:00:00.000Z`;

  const SRC_DUE = 'commitments_due';
  const SRC_MET = 'commitments_met';
  const SRC_OPEN = 'commitments_open';
  const SRC_ACTIONS = 'actions';
  const SRC_SILENCE = 'actions_silence';
  const SRC_PENDING = 'document_extractions';
  const SRC_FLEET = 'vehicles';
  const SRC_FIXES = 'document_field_corrections';
  const SRC_CARTERA = 'payments';

  // --- Las lecturas, todas primero y todas declaradas ---------------------
  const [dueRows, metRowsRaw, openRows, actionRows, silenceRows] = await Promise.all([
    // UNA PROMESA ENTRE COLEGAS NO ES UN PAPEL QUE VENCE. La sección de
    // vencimientos cuenta compromisos con terceros, y meter «Ana quedó de
    // mandar el informe» ahí infla el número que alguien lee como «papeles a
    // punto de caducar». Las promesas tienen su propia sección, por nombre.
    listCommitments(db, {
      reviewState: 'confirmed',
      excludeKinds: ['internal'],
      dueBefore: aheadEnd,
      today,
      limit: ROW_CAP,
    }),
    // Aquí SÍ entran las internas: cumplir una promesa cuenta como cumplir.
    listCommitments(db, {
      states: ['met'],
      reviewState: 'confirmed',
      metAfter: weekStartInstant,
      today,
      limit: 300,
    }),
    // Los estados se derivan de la fecha contra hoy, no se leen de la columna
    // `state` (que es una caché que el vigilante refresca de madrugada). Sin
    // este filtro entrarían los cumplidos y los descartados, y «quién debe qué»
    // le pondría encima a alguien lo que ya cerró.
    listCommitments(db, {
      reviewState: 'confirmed',
      states: ['in_force', 'due_soon', 'overdue'],
      today,
      limit: ROW_CAP,
    }),
    listActions(db, { limit: 300 }),
    listActions(db, { outcome: 'no_reply', limit: 100 }),
  ]);

  // `metAfter` acota por abajo y ordena por `met_at` descendente; el borde de
  // arriba se pone aquí, porque lo que se cerró esta mañana pertenece al parte
  // del lunes que viene y no a éste.
  const metRows = metRowsRaw.filter((r) => {
    const day = bogotaDayOf(r.met_at);
    return day !== null && day >= weekStart && day <= weekEnd;
  });

  const pendingRead = await db
    .from('document_extractions')
    .select('id, doc_type, counterparty_name, doc_number, created_at')
    .eq('review_state', 'pending')
    .order('created_at', { ascending: true })
    .limit(200);
  if (pendingRead.error) {
    throw new Error(`No se pudo leer la bandeja de revisión: ${pendingRead.error.message}`);
  }
  const pending = (pendingRead.data ?? []) as unknown as PendingExtractionRow[];

  const fleetRead = await db
    .from('vehicles')
    .select('id, plate, soat_expires_at, rtm_expires_at, last_runt_sync')
    .eq('archived', false)
    .order('plate', { ascending: true })
    .limit(200);
  if (fleetRead.error) throw new Error(`No se pudo leer la flota: ${fleetRead.error.message}`);
  const fleet = (fleetRead.data ?? []) as unknown as Array<{
    id: string;
    plate: string;
    soat_expires_at: string | null;
    rtm_expires_at: string | null;
    last_runt_sync: string | null;
  }>;

  const fixesRead = await db
    .from('document_field_corrections')
    .select('doc_type, field_key, outcome, corrected_at')
    .gte('corrected_at', weekStartInstant)
    .limit(500);
  if (fixesRead.error) {
    throw new Error(`No se pudieron leer las correcciones: ${fixesRead.error.message}`);
  }
  const fixes = ((fixesRead.data ?? []) as unknown as CorrectionRow[]).filter(
    (f) => (bogotaDayOf(f.corrected_at) ?? '') <= weekEnd,
  );

  // La cartera es opcional de verdad: una empresa que todavía no registra pagos
  // no tiene por qué recibir una sección vacía, y si el módulo no está en esta
  // base el parte entero no puede caerse por ello. El fallo se CUENTA en las
  // notas en vez de tragarse.
  let cartera: ReceivablesResult | null = null;
  let carteraError: string | null = null;
  try {
    cartera = await receivables(db, { today });
  } catch (err) {
    carteraError = err instanceof Error ? err.message : 'error desconocido';
  }

  // --- Las fuentes --------------------------------------------------------
  const sources: ReportSource[] = [
    source({
      id: SRC_DUE,
      system: 'Cortex · commitments',
      detail: `Compromisos confirmados con terceros (sin promesas internas) que vencen hasta el ${longDate(aheadEnd)}, incluidos los que ya se pasaron y siguen abiertos.`,
      readAt,
      rowCount: dueRows.length,
      caveat:
        dueRows.length >= ROW_CAP
          ? `La lectura se cortó en ${ROW_CAP} filas; hay más compromisos de los que este parte alcanzó a contar.`
          : null,
    }),
    source({
      id: SRC_MET,
      system: 'Cortex · commitments',
      detail: `Compromisos marcados como cumplidos entre el ${longDate(weekStart)} y el ${longDate(weekEnd)}, contando el día colombiano en que se marcaron. Incluye las promesas internas.`,
      readAt,
      rowCount: metRows.length,
      caveat:
        'Se cuenta el día en que alguien marcó el cumplimiento, no el día en que la cosa se hizo. Lo que se hizo el viernes y se marcó el lunes sale en el parte siguiente.',
    }),
    source({
      id: SRC_OPEN,
      system: 'Cortex · commitments',
      detail:
        'Todos los compromisos confirmados que siguen abiertos, promesas internas incluidas, agrupados por la persona que responde por cada uno.',
      readAt,
      rowCount: openRows.length,
      caveat:
        'Promesas y papeles no se suman en ninguna cifra: un SOAT lo paga la empresa y una promesa la hizo una persona, y un total que los mezcle no significa nada.',
    }),
    source({
      id: SRC_ACTIONS,
      system: 'Cortex · actions',
      detail: `Acciones que Cortex propuso, con lo que se decidió sobre cada una. Las 300 más recientes; se cuentan las creadas entre el ${longDate(weekStart)} y el ${longDate(weekEnd)}.`,
      readAt,
      rowCount: actionRows.length,
      caveat: null,
    }),
    source({
      id: SRC_SILENCE,
      system: 'Cortex · actions',
      detail:
        'Acciones ya ejecutadas cuyo desenlace quedó en «sin respuesta»: salieron, pasó la ventana de seguimiento y nadie contestó. De cualquier semana, no sólo de ésta.',
      readAt,
      rowCount: silenceRows.length,
      caveat: null,
    }),
    source({
      id: SRC_PENDING,
      system: 'Cortex · document_extractions',
      detail:
        'Documentos leídos cuya extracción sigue en review_state = pending: nadie los ha confirmado, así que no entran en ninguna otra cifra de este parte ni de ningún otro.',
      readAt,
      rowCount: pending.length,
      caveat: null,
    }),
    source({
      id: SRC_FLEET,
      system: 'Cortex · vehicles (datos de RUNT)',
      detail:
        'Placas activas con la vigencia de SOAT y tecnomecánica tal como las devolvió el RUNT la última vez que se consultó cada placa.',
      readAt,
      rowCount: fleet.length,
      caveat:
        'Una vigencia de RUNT es un hecho del día en que se consultó, no una verdad permanente. La fecha de consulta está en la tabla.',
    }),
    source({
      id: SRC_FIXES,
      system: 'Cortex · document_field_corrections',
      detail: `Campos que una persona corrigió o descartó al revisar una extracción, entre el ${longDate(weekStart)} y el ${longDate(weekEnd)}.`,
      readAt,
      rowCount: fixes.length,
      caveat: null,
    }),
  ];

  if (cartera) {
    sources.push(
      source({
        id: SRC_CARTERA,
        system: 'Cortex · payments',
        detail:
          'Cartera calculada sólo sobre facturas que una persona confirmó. Los pagos en disputa no restan de nada y las monedas no se suman entre sí.',
        readAt,
        rowCount: cartera.confirmedInvoices,
        caveat: cartera.sentence,
      }),
    );
  }

  // --- Los cortes ---------------------------------------------------------
  const openDue = dueRows.filter((r) => {
    const s = deriveState(r, today);
    return s === 'overdue' || s === 'due_soon' || s === 'in_force';
  });
  const overdue = openDue.filter((r) => deriveState(r, today) === 'overdue');
  const nextWeek = openDue.filter((r) => r.due_on >= aheadStart && r.due_on <= aheadEnd);
  const atRisk = [...overdue, ...nextWeek].reduce((sum, r) => sum + (r.amount_cop ?? 0), 0);

  const onTime = metRows.filter((r) => (bogotaDayOf(r.met_at) ?? '') <= r.due_on).length;

  const inWeek = (iso: string | null): boolean => {
    const day = bogotaDayOf(iso);
    return day !== null && day >= weekStart && day <= weekEnd;
  };
  const proposedThisWeek = actionRows.filter((a) => inWeek(a.created_at));
  const approvedThisWeek = actionRows.filter((a) => a.state === 'approved' && inWeek(a.decided_at));
  const dismissedThisWeek = actionRows.filter(
    (a) => a.state === 'dismissed' && inWeek(a.decided_at),
  );
  const sentThisWeek = actionRows.filter(
    (a) => inWeek(a.executed_at) && a.execution_status === 'ok',
  );
  const answeredThisWeek = sentThisWeek.filter(
    (a) => a.outcome === 'replied' || a.outcome === 'resolved',
  );
  const stillOpen = actionRows.filter(
    (a) => a.state === 'proposed' && Date.parse(a.expires_at) > now.getTime(),
  );

  const people = input.groupByPerson({ open: openRows, closed: [], today });

  // --- Las cifras ---------------------------------------------------------
  const metrics: ReportSection = {
    type: 'metrics',
    heading: 'Cómo quedó la semana',
    items: [
      {
        label: 'Vence la semana que entra',
        figure: fig(
          count(nextWeek.length),
          nextWeek.length,
          SRC_DUE,
          `Conteo de compromisos confirmados con terceros, abiertos, cuya fecha cae entre el ${aheadStart} y el ${aheadEnd}.`,
        ),
        sub: `${aheadStart} → ${aheadEnd}`,
        tone: nextWeek.length > 0 ? 'amber' : 'ink',
      },
      {
        label: 'Vencido y sin cerrar',
        figure: fig(
          count(overdue.length),
          overdue.length,
          SRC_DUE,
          `Conteo de compromisos confirmados con terceros cuya fecha ya pasó al ${today} y que nadie ha marcado cumplidos ni descartados.`,
        ),
        sub: overdue.length > 0 ? 'arrastrado de antes' : 'nada arrastrado',
        tone: overdue.length > 0 ? 'rose' : 'emerald',
      },
      {
        label: 'Se cumplió',
        figure: fig(
          count(metRows.length),
          metRows.length,
          SRC_MET,
          `Conteo de compromisos marcados cumplidos entre el ${weekStart} y el ${weekEnd}, por el día colombiano de met_at. ${onTime} de ellos antes de su fecha.`,
        ),
        sub:
          metRows.length > 0
            ? `${count(onTime)} a tiempo, ${count(metRows.length - onTime)} tarde`
            : 'ninguno esta semana',
        tone: metRows.length > 0 ? 'emerald' : 'ink',
      },
      {
        label: 'Sin respuesta',
        figure: fig(
          count(silenceRows.length),
          silenceRows.length,
          SRC_SILENCE,
          'Conteo de acciones ejecutadas cuyo desenlace quedó en no_reply: salieron y nadie contestó dentro de la ventana de seguimiento.',
        ),
        sub: silenceRows.length > 0 ? 'salieron y nadie contestó' : 'nada en silencio',
        tone: silenceRows.length > 0 ? 'amber' : 'emerald',
      },
      {
        label: 'Sin revisar',
        figure: fig(
          count(pending.length),
          pending.length,
          SRC_PENDING,
          'Conteo de extracciones de documentos con review_state = pending. Están fuera de todas las demás cifras de este parte.',
        ),
        sub: pending.length > 0 ? 'nadie los ha confirmado' : 'bandeja vacía',
        tone: pending.length > 0 ? 'amber' : 'emerald',
      },
      {
        label: 'Plata en juego',
        figure: fig(
          atRisk > 0 ? cop(atRisk) : '—',
          atRisk,
          SRC_DUE,
          'Suma de amount_cop de lo vencido y de lo que vence la semana que entra. Lo que no tiene monto registrado suma cero, así que es un piso y no un total.',
          'COP',
        ),
        sub: 'vencido y por vencer, con monto',
        tone: atRisk > 0 ? 'rose' : 'ink',
      },
    ],
  };

  // --- 1. Lo que se vence y lo que se pasó --------------------------------
  const dueItems = [...overdue, ...nextWeek]
    .sort((a, b) => a.due_on.localeCompare(b.due_on))
    .slice(0, 60);
  const timelineFrom = minDate(
    dueItems.map((r) => r.due_on),
    aheadStart,
  );
  const dueMethod = `Compromisos confirmados con terceros que están vencidos al ${today} o que vencen entre el ${aheadStart} y el ${aheadEnd}. Las promesas internas (kind = 'internal') quedan fuera a propósito.`;

  const dueSection: ReportSection = {
    type: 'chart',
    heading: 'Lo que se vence, y lo que ya se pasó',
    chart: {
      type: 'timeline',
      from: timelineFrom,
      to: aheadEnd,
      today,
      items: dueItems.map((r) => ({
        label: r.title,
        date: r.due_on,
        detail: `${KIND_LABEL[r.kind] ?? r.kind} · ${whenPhrase(daysUntilDue(r.due_on, today))}`,
        tone: STATE_TONE[deriveState(r, today)] ?? 'primary',
      })),
    },
    altText: `Línea de tiempo con ${count(dueItems.length)} vencimientos. Hoy, ${shortDate(today)}, está marcado con una línea vertical: ${count(overdue.length)} quedan a la izquierda porque ya se pasaron y ${count(nextWeek.length)} caen en los siete días siguientes.`,
    caption:
      'Rojo: ya se venció y sigue abierto. Ámbar y verde: lo que viene. Sólo papeles con terceros; las promesas internas están más abajo, con nombre.',
    table: {
      columns: [
        { label: 'Compromiso', align: 'left', mono: false },
        { label: 'Con', align: 'left', mono: false },
        { label: 'Vence', align: 'left', mono: true },
        { label: 'Cuándo', align: 'right', mono: true },
        { label: 'Monto', align: 'right', mono: true },
        { label: 'Responsable', align: 'left', mono: false },
        { label: 'De dónde salió la fecha', align: 'left', mono: false },
      ],
      rows: dueItems.map((r) => {
        const state = deriveState(r, today);
        return [
          cell(r.title),
          cell(r.counterparty ?? '—'),
          cell(shortDate(r.due_on)),
          cell(whenPhrase(daysUntilDue(r.due_on, today)), STATE_TONE[state] ?? null),
          cell(r.amount_cop ? cop(r.amount_cop) : '—'),
          cell(r.owner_name ?? 'Sin responsable', r.owner_user_id ? null : 'amber'),
          cell(sourceLabelOf(r)),
        ];
      }),
      sourceId: SRC_DUE,
      method: dueMethod,
      caption: null,
    },
    sourceId: SRC_DUE,
    method: dueMethod,
  };

  // --- 2. Lo que se cumplió -----------------------------------------------
  const metMethod = `Compromisos cuyo met_at cae, en día colombiano, entre el ${weekStart} y el ${weekEnd}. «A tiempo» compara ese día contra due_on, no el instante contra la fecha: algo marcado a las 20:00 en Bogotá se cumplió ese día y no el siguiente.`;
  const metSection: ReportSection = {
    type: 'table',
    heading: 'Lo que se cumplió esta semana',
    table: {
      columns: [
        { label: 'Compromiso', align: 'left', mono: false },
        { label: 'Tipo', align: 'left', mono: false },
        { label: 'Quién', align: 'left', mono: false },
        { label: 'Vencía', align: 'left', mono: true },
        { label: 'Se marcó', align: 'left', mono: true },
        { label: '', align: 'left', mono: false },
      ],
      rows: metRows.slice(0, 60).map((r) => {
        const day = bogotaDayOf(r.met_at) ?? '';
        const punctual = day !== '' && day <= r.due_on;
        return [
          cell(r.title),
          cell(KIND_LABEL[r.kind] ?? r.kind),
          cell(r.owner_name ?? 'Sin responsable'),
          cell(shortDate(r.due_on)),
          cell(day ? shortDate(day) : '—'),
          cell(punctual ? 'A tiempo' : 'Tarde', punctual ? 'emerald' : 'amber'),
        ];
      }),
      sourceId: SRC_MET,
      method: metMethod,
      caption:
        metRows.length === 0
          ? 'Nadie marcó nada como cumplido esta semana. Puede ser que no hubiera nada que cerrar, o que se cerrara sin anotarlo — el sistema no distingue las dos cosas y no va a fingir que sí.'
          : null,
    },
  };

  // --- 3. Quién debe qué ---------------------------------------------------
  const peopleMethod =
    'Compromisos confirmados abiertos, agrupados por owner_user_id. Promesas internas y papeles se cuentan en columnas separadas y no se suman en ninguna parte: son cosas distintas y un total conjunto no significa nada.';
  const peopleSection: ReportSection = {
    type: 'table',
    heading: 'Quién debe qué',
    table: {
      columns: [
        { label: 'Persona', align: 'left', mono: false },
        { label: 'Papeles', align: 'right', mono: true },
        { label: 'Papeles vencidos', align: 'right', mono: true },
        { label: 'Promesas', align: 'right', mono: true },
        { label: 'Promesas vencidas', align: 'right', mono: true },
        { label: 'Lo que aprieta primero', align: 'left', mono: false },
      ],
      rows: people.pending.slice(0, 40).map((p) => {
        const first = p.items[0];
        return [
          cell(p.name, p.unassigned ? 'amber' : null),
          cell(count(p.papers.open)),
          cell(count(p.papers.overdue), p.papers.overdue > 0 ? 'rose' : null),
          cell(count(p.promises.open)),
          cell(count(p.promises.overdue), p.promises.overdue > 0 ? 'rose' : null),
          cell(
            first ? `${first.title} · ${whenPhrase(first.daysLeft)}` : '—',
            first && first.daysLeft < 0 ? 'rose' : null,
          ),
        ];
      }),
      sourceId: SRC_OPEN,
      method: peopleMethod,
      caption:
        'Lo que no tiene responsable va siempre al final: no es una persona a la que preguntarle, es una tarea de administración.',
    },
  };

  // --- 4. Lo que Cortex propuso -------------------------------------------
  const actionSlices = [
    { label: 'Aprobadas', tone: 'emerald' as Tone, n: approvedThisWeek.length },
    { label: 'Descartadas', tone: 'ink' as Tone, n: dismissedThisWeek.length },
    { label: 'Sin decidir', tone: 'amber' as Tone, n: stillOpen.length },
  ];
  const actionTotal = actionSlices.reduce((s, x) => s + x.n, 0);
  const actionsMethod = `Acciones de la tabla actions. «Propuestas» cuenta las creadas entre el ${weekStart} y el ${weekEnd}; «aprobadas» y «descartadas», las decididas en esa misma semana; «sin decidir» son propuestas todavía vivas al ${today}, sean de esta semana o de antes.`;

  const actionsSection: ReportSection = {
    type: 'chart',
    heading: 'Lo que propuse, y en qué quedó',
    chart: {
      type: 'composition',
      slices: actionSlices
        .filter((s) => s.n > 0)
        .map((s) => ({
          label: s.label,
          value: s.n,
          display: `${count(s.n)} · ${share(s.n, actionTotal)}`,
          tone: s.tone,
        })),
    },
    altText:
      actionTotal > 0
        ? `De ${count(actionTotal)} acciones: ${actionSlices
            .filter((s) => s.n > 0)
            .map((s) => `${s.label.toLowerCase()}, ${count(s.n)}`)
            .join('; ')}.`
        : 'No hubo ninguna acción propuesta ni pendiente de decidir en esta semana.',
    caption:
      'Nada de esto salió sin que una persona lo aprobara. «Sin decidir» es lo que sigue esperando una firma, y caduca solo a los siete días.',
    table: {
      columns: [
        { label: 'Qué', align: 'left', mono: false },
        { label: 'Cuántas', align: 'right', mono: true },
      ],
      rows: [
        [cell('Propuestas esta semana'), cell(count(proposedThisWeek.length))],
        [cell('Aprobadas'), cell(count(approvedThisWeek.length), 'emerald')],
        [cell('Descartadas'), cell(count(dismissedThisWeek.length))],
        [cell('Enviadas de verdad'), cell(count(sentThisWeek.length))],
        [cell('Contestadas'), cell(count(answeredThisWeek.length), 'emerald')],
        [
          cell('Todavía esperando una decisión'),
          cell(count(stillOpen.length), stillOpen.length > 0 ? 'amber' : null),
        ],
      ],
      sourceId: SRC_ACTIONS,
      method: actionsMethod,
      caption: null,
    },
    sourceId: SRC_ACTIONS,
    method: actionsMethod,
  };

  // --- 5. Los silencios ----------------------------------------------------
  const silenceMethod =
    'Acciones con outcome = no_reply: se ejecutaron, pasó la ventana de seguimiento de diez días y nadie contestó. La antigüedad se cuenta desde executed_at.';
  const silenceSection: ReportSection = {
    type: 'table',
    heading: 'Los silencios',
    table: {
      columns: [
        { label: 'Qué salió', align: 'left', mono: false },
        { label: 'A quién', align: 'left', mono: false },
        { label: 'Asunto', align: 'left', mono: false },
        { label: 'Salió', align: 'left', mono: true },
        { label: 'Lleva', align: 'right', mono: true },
      ],
      rows: silenceRows.slice(0, 40).map((a: ActionRow) => {
        const day = a.executed_at ? (bogotaDayOf(a.executed_at) ?? today) : today;
        const age = daysUntilDue(day, today);
        return [
          cell(ACTION_KIND_LABEL[a.kind] ?? a.kind),
          cell(a.recipient),
          cell(clip(a.subject, 60)),
          cell(shortDate(day)),
          cell(whenPhrase(age), age <= -10 ? 'rose' : 'amber'),
        ];
      }),
      sourceId: SRC_SILENCE,
      method: silenceMethod,
      caption:
        silenceRows.length === 0
          ? 'Nada salió y se quedó sin respuesta. Es el mejor resultado posible de esta sección.'
          : 'Un cobro que salió hace diez días y nadie contestó no es un fallo del sistema: es el hallazgo. Alguien tiene que llamar.',
    },
  };

  // --- 6. Lo que quedó sin revisar ----------------------------------------
  const pendingMethod = `Extracciones con review_state = pending al ${today}, ordenadas de la más vieja a la más nueva. La antigüedad se cuenta desde created_at.`;
  const pendingSection: ReportSection = {
    type: 'table',
    heading: 'Lo que quedó sin revisar',
    table: {
      columns: [
        { label: 'Tipo de documento', align: 'left', mono: false },
        { label: 'De quién', align: 'left', mono: false },
        { label: 'Número', align: 'left', mono: true },
        { label: 'Esperando desde', align: 'left', mono: true },
        { label: 'Lleva', align: 'right', mono: true },
      ],
      rows: pending.slice(0, 40).map((p) => {
        const day = (bogotaDayOf(p.created_at) ?? p.created_at).slice(0, 10);
        const age = daysUntilDue(day, today);
        return [
          cell(typeLabel(p.doc_type)),
          cell(p.counterparty_name ?? '—'),
          cell(p.doc_number ?? '—'),
          cell(shortDate(day)),
          cell(whenPhrase(age), age <= -7 ? 'rose' : 'amber'),
        ];
      }),
      sourceId: SRC_PENDING,
      method: pendingMethod,
      caption:
        pending.length === 0
          ? 'No hay nada esperando revisión.'
          : 'Nada de esto está en ninguna otra cifra de este parte, ni en la cartera. Un documento sin confirmar es una propuesta, no un dato.',
    },
  };

  // --- 7. La flota ---------------------------------------------------------
  const classify = (expiry: string | null): Tone => {
    if (!expiry) return 'ink';
    const left = daysUntilDue(expiry.slice(0, 10), today);
    if (left < 0) return 'rose';
    if (left <= 30) return 'amber';
    return 'emerald';
  };
  const fleetMethod =
    'Una fila por placa activa. Las vigencias son las que devolvió el RUNT el día de la última columna; una placa sin consultar tiene vigencias desconocidas, no correctas.';
  const fleetSection: ReportSection = {
    type: 'table',
    heading: 'La flota',
    table: {
      columns: [
        { label: 'Placa', align: 'left', mono: true },
        { label: 'SOAT', align: 'left', mono: true },
        { label: 'Tecnomecánica', align: 'left', mono: true },
        { label: 'RUNT consultado', align: 'left', mono: true },
      ],
      rows: fleet
        .slice(0, 60)
        .map((v) => [
          cell(v.plate),
          cell(
            v.soat_expires_at ? shortDate(v.soat_expires_at.slice(0, 10)) : 'sin consultar',
            classify(v.soat_expires_at),
          ),
          cell(
            v.rtm_expires_at ? shortDate(v.rtm_expires_at.slice(0, 10)) : 'sin consultar',
            classify(v.rtm_expires_at),
          ),
          cell(
            v.last_runt_sync ? v.last_runt_sync.slice(0, 10) : 'nunca',
            v.last_runt_sync ? null : 'amber',
          ),
        ]),
      sourceId: SRC_FLEET,
      method: fleetMethod,
      caption:
        fleet.length === 0
          ? 'No hay placas registradas.'
          : 'La última columna es la que hace verificables a las otras tres.',
    },
  };

  // --- 8. Dónde me equivoco leyendo ---------------------------------------
  const fixTally = new Map<
    string,
    { docType: string | null; field: string; n: number; thrown: number }
  >();
  for (const f of fixes) {
    const key = `${f.doc_type ?? '—'}#${f.field_key}`;
    const entry = fixTally.get(key) ?? {
      docType: f.doc_type,
      field: f.field_key,
      n: 0,
      thrown: 0,
    };
    entry.n += 1;
    if (f.outcome === 'rejected') entry.thrown += 1;
    fixTally.set(key, entry);
  }
  const fixRows = [...fixTally.values()].sort((a, b) => b.n - a.n).slice(0, 20);
  const fixMethod = `Filas de document_field_corrections con corrected_at entre el ${weekStart} y el ${weekEnd}, agrupadas por tipo de documento y campo. «Descartado» es cuando quien revisaba tiró la lectura entera en vez de corregirla.`;

  const fixSection: ReportSection = {
    type: 'table',
    heading: 'Dónde me equivoco leyendo',
    table: {
      columns: [
        { label: 'Tipo de documento', align: 'left', mono: false },
        { label: 'Campo', align: 'left', mono: false },
        { label: 'Veces corregido', align: 'right', mono: true },
        { label: 'Descartado', align: 'right', mono: true },
      ],
      rows: fixRows.map((f) => [
        cell(typeLabel(f.docType)),
        cell(fieldLabel(f.docType, f.field)),
        cell(count(f.n), 'rose'),
        cell(count(f.thrown)),
      ]),
      sourceId: SRC_FIXES,
      method: fixMethod,
      caption:
        fixes.length === 0
          ? 'Nadie tuvo que corregirme ninguna lectura esta semana. También puede ser que nadie haya revisado nada: mira la sección de arriba antes de leerlo como un elogio.'
          : 'Un campo que hay que corregir siempre es un fallo mío, no del mundo. Está aquí para que se vea, no para que se disculpe.',
    },
  };

  // --- 9. La cartera, con su confesión ------------------------------------
  const carteraSection: ReportSection | null =
    cartera && (cartera.byCurrency.length > 0 || cartera.pendingExcluded > 0)
      ? {
          type: 'table',
          heading: 'La cartera',
          table: {
            columns: [
              { label: 'Moneda', align: 'left', mono: true },
              { label: 'Por cobrar', align: 'right', mono: true },
              { label: 'Facturas abiertas', align: 'right', mono: true },
              { label: 'Edad media', align: 'right', mono: true },
              { label: 'Vencido', align: 'right', mono: true },
            ],
            rows: cartera.byCurrency.map((c) => [
              cell(c.currency),
              cell(`${Math.round(c.outstanding).toLocaleString('es-CO')}`),
              cell(count(c.openInvoices)),
              cell(c.ageDays == null ? '—' : plural(c.ageDays, 'día')),
              cell(
                `${Math.round(c.overdue).toLocaleString('es-CO')}`,
                c.overdue > 0 ? 'rose' : null,
              ),
            ]),
            sourceId: SRC_CARTERA,
            method: `Sólo facturas confirmadas, cada moneda por separado y sin sumarlas entre sí. ${cartera.sentence}`,
            caption: cartera.sentence,
          },
        }
      : null;

  const sections: ReportSection[] = [
    {
      type: 'prose',
      heading: null,
      paragraphs: [
        weeklyLede({
          overdue: overdue.length,
          nextWeek: nextWeek.length,
          met: metRows.length,
          silences: silenceRows.length,
          pending: pending.length,
          weekStart,
          weekEnd,
        }),
      ],
    },
    metrics,
    dueSection,
    metSection,
    peopleSection,
    actionsSection,
    silenceSection,
    pendingSection,
    fleetSection,
    fixSection,
    ...(carteraSection ? [carteraSection] : []),
  ];

  const notes = [
    'Este parte sale solo cada lunes temprano. Nadie lo pidió y nadie tuvo que acordarse.',
    'No hay ingresos, ni crecimiento, ni márgenes: Cortex no los sabe, y una cifra de negocio inventada aquí desacreditaría de paso a todas las que sí son ciertas.',
    'Las promesas internas no cuentan como vencimientos, y los papeles no cuentan como promesas. Están separados en todas las cifras del parte.',
    'Lo que está sin confirmar —extracciones, compromisos leídos de documentos— no entra en ninguna cifra. Se cuenta aparte, para que se vea el hueco.',
  ];
  if (carteraError) {
    notes.push(
      `La cartera no se pudo leer en esta corrida (${clip(carteraError, 120)}), así que este parte no dice nada sobre ella. No significa que no haya.`,
    );
  } else if (!carteraSection) {
    notes.push(
      'No hay cartera que reportar: ninguna factura confirmada tiene saldo pendiente y no hay facturas leídas esperando revisión.',
    );
  }

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'weekly',
    title: `${REPORT_KIND_LABEL.weekly} — semana ${weekSpan(weekStart, weekEnd)}`,
    subtitle: `Lo que pasó entre el ${longDate(weekStart)} y el ${longDate(weekEnd)}, y lo que viene hasta el ${longDate(aheadEnd)}.`,
    periodLabel: `semana ${weekSpan(weekStart, weekEnd)} · lo que viene hasta el ${longDate(aheadEnd)}`,
    generatedAt: readAt,
    timezone: 'America/Bogota',
    sources,
    sections,
    notes,
  });
}

/**
 * El primer párrafo, que es donde este informe se gana la interrupción.
 *
 * Lidera con lo que exige una decisión — lo vencido, los silencios — y no con lo
 * que salió bien. Un parte que empieza celebrando enseña a leerlo en diagonal.
 */
function weeklyLede(input: {
  overdue: number;
  nextWeek: number;
  met: number;
  silences: number;
  pending: number;
  weekStart: string;
  weekEnd: string;
}): string {
  const urgent: string[] = [];
  if (input.overdue > 0) urgent.push(`${plural(input.overdue, 'compromiso')} vencido sin cerrar`);
  if (input.silences > 0)
    urgent.push(`${plural(input.silences, 'cosa')} que salió y nadie contestó`);
  if (input.pending > 0) urgent.push(`${plural(input.pending, 'documento')} sin revisar`);

  if (urgent.length === 0 && input.met === 0 && input.nextWeek === 0) {
    return `De la semana ${weekSpan(input.weekStart, input.weekEnd)} no tengo nada que reportar: no se venció nada, no se cerró nada y no hay nada esperando. Si eso no cuadra con lo que pasó de verdad, es que la semana no se está anotando en ninguna parte — y eso sí es un hallazgo.`;
  }

  const head =
    urgent.length > 0
      ? `Lo que pide una decisión: ${urgent.join(', ')}.`
      : 'Nada pide una decisión urgente esta semana.';
  const tail = `La semana que entra vencen ${plural(input.nextWeek, 'compromiso')}; la que acabó se cerraron ${plural(input.met, 'compromiso')}.`;
  return `${head} ${tail} Cada cifra de abajo trae la fuente de la que salió y la cuenta que se hizo con ella.`;
}

// ---------------------------------------------------------------------------

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Build one report. The single entry point; the tools and the web screen both
 * come through here so a report generated from the chat and one generated from
 * the button are the same document.
 */
export async function buildReport(
  kind: GeneratedReportKind,
  input: BuildInput,
): Promise<ReportDocument> {
  const resolved = {
    db: input.db,
    today: input.today ?? bogotaToday(input.now),
    now: input.now ?? new Date(),
    params: input.params ?? {},
  };
  switch (kind) {
    case 'expiries':
      return buildExpiries(resolved);
    case 'fleet':
      return buildFleet(resolved);
    case 'client_activity':
      return buildClientActivity(resolved);
  }
}

export { DAY_MS };
