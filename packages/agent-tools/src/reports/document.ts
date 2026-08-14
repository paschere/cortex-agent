import { z } from 'zod';

/**
 * THE REPORT DOCUMENT — the intermediate format, and the reason this module is
 * not "ask the model for some HTML".
 *
 * ===========================================================================
 * WHY THE MODEL NEVER WRITES MARKUP
 * ===========================================================================
 * The obvious way to build an HTML report is to hand the model the numbers and
 * let it write the page. It is also the worst available option, for three
 * separate reasons and each one alone is disqualifying:
 *
 *  1. IT CANNOT BE VERIFIED. A model that writes `<td>1.240.000</td>` has, at
 *     that instant, become the source of the figure. Nothing downstream can
 *     tell a number that was read from `commitments.amount_cop` from a number
 *     that was rounded, restated or invented on the way through the prose. This
 *     product exists to make every figure traceable; a free-text renderer
 *     deletes the trace in the last step.
 *
 *  2. IT BREAKS DIFFERENTLY EVERY TIME. Two runs of the same request produce
 *     two layouts. A report the accountant learned to read in July is a
 *     different shape in August, and "the number moved" is indistinguishable
 *     from "the value changed".
 *
 *  3. IT IS AN INJECTION SURFACE. The content of a report is customer data —
 *     a counterparty called `<img src=x onerror=…>`, a document title with a
 *     `</style>` in it. If any of that reaches a string that is later parsed as
 *     markup, the report becomes a script-delivery mechanism that one workspace
 *     can aim at another through a shared link.
 *
 * So the pipeline is split in two, and the split is the whole design:
 *
 *     rows  ──(build.ts, our code)──▶  ReportDocument  ──(render.ts)──▶  HTML
 *              deterministic, typed       validated       deterministic,
 *              queries only               by zod          escapes everything
 *
 * The model's entire influence is choosing the KIND of report and its
 * parameters (period, client, limits). It never supplies a section, a series,
 * a figure or a sentence of markup. The single free-text field it may set is
 * `note`, which lands in `ReportDocument.notes` as TEXT and is escaped like
 * every other string on the way to the page.
 *
 * ===========================================================================
 * WHY EVERY FIGURE CARRIES ITS SOURCE — IN THE TYPE, NOT BY CONVENTION
 * ===========================================================================
 * `figureSchema` requires `sourceId` and `method`. There is no optional path.
 * A figure that does not say where it came from cannot be constructed, cannot
 * be parsed, and therefore cannot be stored or rendered — `validateDocument`
 * additionally refuses a `sourceId` that does not resolve to a declared source,
 * so the reference cannot dangle either.
 *
 * `method` is the part people underestimate. Naming the table is not
 * traceability: "commitments" does not tell an accountant whether the figure
 * counted the unconfirmed extractions or excluded them. `method` says the
 * sentence out loud — "suma de amount_cop de los compromisos vencidos y por
 * vencer, sin incluir los que están pendientes de confirmar" — which is what
 * somebody actually needs in order to reproduce the number by hand.
 *
 * ===========================================================================
 * WHY THE DOCUMENT IS WHAT GETS SAVED
 * ===========================================================================
 * A saved report has to show, in September, exactly what it showed in July.
 * Storing a QUERY and re-running it fails that outright. Storing the rendered
 * HTML passes it but freezes the presentation too, so a fixed typo or an
 * accessibility improvement can never reach an old report, and the stored blob
 * is opaque to anything but a browser.
 *
 * The document is the photograph: every number already resolved, every label
 * already written, every source already stamped with the moment it was read.
 * Rendering is a pure function of it. See `store.ts` for the content hash that
 * makes the freeze checkable rather than merely intended.
 */

/**
 * Bumped only when a stored document would render wrong under the new reader.
 * Stored on every row, so an old document is always read by a reader that
 * understands it instead of being silently misinterpreted.
 */
export const REPORT_DOCUMENT_VERSION = 1;

/**
 * The three reports `build.ts` knows how to compute from scratch.
 *
 * Split out from `REPORT_KINDS` when the chat gained the ability to save a
 * chart. The distinction is not cosmetic: these three are the only kinds that
 * can be produced from a KIND plus PARAMETERS, which is what the picker on
 * /reports offers and what `reports.generate` lets the model ask for. A saved
 * chat chart has no parameters to re-run — it was already resolved when it was
 * drawn — so offering it in either place would be offering a button that cannot
 * work. Keeping the two lists apart is what makes that impossible to get wrong:
 * `buildReport` takes this narrower type and the compiler refuses the rest.
 */
export const GENERATED_REPORT_KINDS = ['expiries', 'fleet', 'client_activity'] as const;
export type GeneratedReportKind = (typeof GENERATED_REPORT_KINDS)[number];

/**
 * Every kind a stored report may have. Wider than the list above by exactly two,
 * and neither of them is a recipe:
 *
 *   chart    arrives from the chat. It was drawn from numbers a tool had
 *            already returned, so there is no query to re-run.
 *   weekly   arrives from the Monday cron. It is not "a report about the last
 *            seven days" that anybody may ask for at any moment — it is THE
 *            parte of one specific week, and migration 0100 gives it a
 *            `period_start` plus a unique index so exactly one of them can
 *            exist per workspace and week. Offering it in the picker would
 *            offer a button that either loses to that index or wins it and
 *            leaves Monday's email unsent.
 */
export const REPORT_KINDS = [...GENERATED_REPORT_KINDS, 'chart', 'weekly'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Spanish names, because this is what the report calls itself on screen. */
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  expiries: 'Vencimientos',
  fleet: 'Estado de la flota',
  client_activity: 'Actividad por cliente',
  chart: 'Gráfico del chat',
  weekly: 'Parte semanal',
};

export const REPORT_KIND_BLURB: Record<ReportKind, string> = {
  expiries:
    'Qué se vence, cuándo, cuánto cuesta si se pasa, y de dónde salió cada fecha. Sólo compromisos confirmados: lo que todavía nadie revisó se cuenta aparte y no entra en las cifras.',
  fleet:
    'SOAT, tecnomecánica y multas de cada placa, con la fecha en que se consultó cada registro. Un dato de RUNT o SIMIT es un hecho de un momento, no una verdad permanente.',
  client_activity:
    'Qué tiene comprometido cada contraparte, cuánto pesa en plata y qué se le vence primero.',
  chart:
    'Un gráfico que salió de una conversación y alguien decidió conservar. Se guarda igual que los demás: la fotografía, con la fuente y el método de cada cifra.',
  weekly:
    'Lo que pasó la semana pasada y lo que viene la que entra: qué se venció, qué se cumplió, quién debe qué, qué propuso Cortex y en qué quedó, y a qué nadie contestó. Sale solo cada lunes temprano y no se puede pedir: es el parte de una semana concreta, no una consulta.',
};

/**
 * The colour vocabulary, fixed by docs/design-system.md and not negotiable per
 * report: emerald is in force, amber is lapsing, rose is lapsed. `primary` is
 * the product asserting something, `sky` is informational, `ink` is neutral.
 * A report that invents its own colour meaning is a report people misread.
 */
export const TONES = ['emerald', 'amber', 'rose', 'primary', 'sky', 'ink'] as const;
export type Tone = (typeof TONES)[number];
export const toneSchema = z.enum(TONES);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * One system the report read from. Numbered on the page as a footnote, which
 * is what makes provenance structural rather than decorative: every figure
 * shows a marker, and the marker resolves to a line at the foot of the report
 * naming the table, the filter, the moment and how many rows came back.
 */
export const reportSourceSchema = z.object({
  /** Referenced by figures, charts and tables. Stable within one document. */
  id: z.string().min(1),
  /** The system of record, as a person would name it: "Cortex · commitments". */
  system: z.string().min(1),
  /** The exact slice read: filters, window, exclusions. */
  detail: z.string().min(1),
  /** ISO instant the read happened. A figure is a fact about a moment. */
  readAt: z.string().min(1),
  /** How many rows the read returned. A zero here explains an empty chart. */
  rowCount: z.number().int().nonnegative(),
  /** Anything that makes the rows less trustworthy than they look. */
  caveat: z.string().nullable().default(null),
});
export type ReportSource = z.infer<typeof reportSourceSchema>;

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * A number the report asserts. `display` is already formatted for Colombia —
 * formatting at render time would mean the saved report could change its own
 * figures when a locale rule changed, which is precisely the drift the snapshot
 * exists to prevent.
 */
export const figureSchema = z.object({
  display: z.string(),
  /** The unformatted value, kept so a chart or an export can use the number. */
  raw: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  /** Must resolve to a `ReportSource.id`. Enforced by `validateDocument`. */
  sourceId: z.string().min(1),
  /** The arithmetic, in one sentence, so a person can redo it by hand. */
  method: z.string().min(1),
});
export type Figure = z.infer<typeof figureSchema>;

export const metricSchema = z.object({
  label: z.string(),
  figure: figureSchema,
  sub: z.string().nullable().default(null),
  tone: toneSchema.nullable().default(null),
});
export type Metric = z.infer<typeof metricSchema>;

// ---------------------------------------------------------------------------
// Tables — the accessible twin of every chart
// ---------------------------------------------------------------------------

export const tableColumnSchema = z.object({
  label: z.string(),
  align: z.enum(['left', 'right']).default('left'),
  /** Figures, dates, plates and ids get the monospaced treatment. */
  mono: z.boolean().default(false),
});

export const tableCellSchema = z.object({
  display: z.string(),
  tone: toneSchema.nullable().default(null),
});

export const tableSchema = z.object({
  columns: z.array(tableColumnSchema).min(1),
  rows: z.array(z.array(tableCellSchema)),
  sourceId: z.string().min(1),
  method: z.string().min(1),
  /** Shown when the table stands alone; a chart's twin table gets none. */
  caption: z.string().nullable().default(null),
});
export type ReportTable = z.infer<typeof tableSchema>;

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/**
 * Four chart shapes, chosen for the four questions this business actually asks,
 * and no more. Ten mediocre chart types is how a reporting module becomes
 * unmaintainable; these four are drawn properly, in server-side SVG, with no
 * client JavaScript and no external anything.
 *
 *   timeseries   "¿esto va subiendo o bajando?" — a value per month.
 *   bars         "¿quién pesa más?" — horizontal, because client names are long
 *                and a vertical axis of rotated labels is unreadable.
 *   composition  "¿de qué está hecho?" — one stacked bar plus a legend that
 *                carries the numbers. A donut hides small slices behind an
 *                angle nobody can estimate; a stacked bar with values does not.
 *   timeline     "¿qué se me viene encima?" — the one this company opens the
 *                report for. Every deadline placed on a real day axis with
 *                today marked, so "faltan tres semanas" is a distance you can
 *                see rather than a number you have to subtract.
 */
export const timeSeriesChartSchema = z.object({
  type: z.literal('timeseries'),
  points: z.array(z.object({ label: z.string(), value: z.number() })),
  valueUnit: z.string().nullable().default(null),
  tone: toneSchema.default('primary'),
});

export const barsChartSchema = z.object({
  type: z.literal('bars'),
  bars: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      display: z.string(),
      tone: toneSchema.default('primary'),
    }),
  ),
});

export const compositionChartSchema = z.object({
  type: z.literal('composition'),
  slices: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      display: z.string(),
      tone: toneSchema.default('primary'),
    }),
  ),
});

export const timelineChartSchema = z.object({
  type: z.literal('timeline'),
  /** All three are `YYYY-MM-DD`, read in Colombian time. */
  from: z.string(),
  to: z.string(),
  today: z.string(),
  items: z.array(
    z.object({
      label: z.string(),
      date: z.string(),
      detail: z.string().nullable().default(null),
      tone: toneSchema.default('primary'),
    }),
  ),
});

export const chartBodySchema = z.discriminatedUnion('type', [
  timeSeriesChartSchema,
  barsChartSchema,
  compositionChartSchema,
  timelineChartSchema,
]);
export type ChartBody = z.infer<typeof chartBodySchema>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const proseSectionSchema = z.object({
  type: z.literal('prose'),
  heading: z.string().nullable().default(null),
  paragraphs: z.array(z.string()),
});

export const metricsSectionSchema = z.object({
  type: z.literal('metrics'),
  heading: z.string().nullable().default(null),
  items: z.array(metricSchema),
});

/**
 * A chart section ALWAYS carries its table. Not "may": the schema requires it.
 *
 * A chart is a picture of numbers, and a picture is unavailable to a screen
 * reader, unusable to someone who needs to check a value, and impossible to
 * paste into an email. `altText` gives the shape in a sentence; `table` gives
 * the numbers themselves, in a real `<table>`, one keystroke away. Making the
 * field optional would mean the accessible path depends on whoever wrote the
 * section remembering — which is how it stops existing.
 */
export const chartSectionSchema = z.object({
  type: z.literal('chart'),
  heading: z.string(),
  chart: chartBodySchema,
  /** One sentence describing what the chart shows, for `<desc>` and for prose. */
  altText: z.string().min(1),
  caption: z.string().nullable().default(null),
  table: tableSchema,
  sourceId: z.string().min(1),
  method: z.string().min(1),
});

export const tableSectionSchema = z.object({
  type: z.literal('table'),
  heading: z.string(),
  table: tableSchema,
});

export const sectionSchema = z.discriminatedUnion('type', [
  proseSectionSchema,
  metricsSectionSchema,
  chartSectionSchema,
  tableSectionSchema,
]);
export type ReportSection = z.infer<typeof sectionSchema>;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const reportDocumentSchema = z.object({
  version: z.number().int().positive(),
  kind: z.enum(REPORT_KINDS),
  title: z.string().min(1),
  subtitle: z.string().nullable().default(null),
  /** "agosto de 2026", "próximos 90 días" — what window this covers. */
  periodLabel: z.string(),
  /** The instant the whole report was computed. Printed on the page. */
  generatedAt: z.string().min(1),
  /** Every date and cut-off in this document was read in this zone. */
  timezone: z.string().default('America/Bogota'),
  sources: z.array(reportSourceSchema).min(1),
  sections: z.array(sectionSchema),
  /** Caveats: what was excluded, what is stale, what is missing. */
  notes: z.array(z.string()).default([]),
});
export type ReportDocument = z.infer<typeof reportDocumentSchema>;

export class UnsourcedFigureError extends Error {
  constructor(where: string, sourceId: string, known: string[]) {
    super(
      `Report figure at ${where} cites source "${sourceId}", which the document does not declare (it declares: ${known.join(', ') || 'nothing'}). Every number in a report has to resolve to a system, a filter and a moment — a citation that points nowhere is worse than no citation, because it looks like one.`,
    );
    this.name = 'UnsourcedFigureError';
  }
}

/**
 * Parse and then check the one thing a schema cannot: that every citation
 * resolves.
 *
 * Zod can require a `sourceId` to be present; only this can require it to mean
 * something. Called on the way in (before a report is stored) and on the way
 * out (before a stored report is rendered), so neither a bug in a builder nor a
 * hand-edited row can put an unresolvable number on a page.
 */
export function validateDocument(raw: unknown): ReportDocument {
  const doc = reportDocumentSchema.parse(raw);
  const known = new Set(doc.sources.map((s) => s.id));
  const knownList = [...known];

  const check = (sourceId: string, where: string) => {
    if (!known.has(sourceId)) throw new UnsourcedFigureError(where, sourceId, knownList);
  };

  doc.sections.forEach((section, i) => {
    switch (section.type) {
      case 'metrics':
        section.items.forEach((m, j) =>
          check(m.figure.sourceId, `sections[${i}].items[${j}] (${m.label})`),
        );
        break;
      case 'chart':
        check(section.sourceId, `sections[${i}] (${section.heading})`);
        check(section.table.sourceId, `sections[${i}].table (${section.heading})`);
        break;
      case 'table':
        check(section.table.sourceId, `sections[${i}] (${section.heading})`);
        break;
      default:
        break;
    }
  });

  return doc;
}

/** Every figure in the document, flattened — for tests and for the tool output. */
export function figuresOf(doc: ReportDocument): Array<{ label: string; figure: Figure }> {
  const out: Array<{ label: string; figure: Figure }> = [];
  for (const section of doc.sections) {
    if (section.type === 'metrics') {
      for (const m of section.items) out.push({ label: m.label, figure: m.figure });
    }
  }
  return out;
}

export function sourceById(doc: ReportDocument, id: string): ReportSource | undefined {
  return doc.sources.find((s) => s.id === id);
}

/** Footnote index of a source, 1-based. 0 when it is not declared. */
export function sourceIndex(doc: ReportDocument, id: string): number {
  return doc.sources.findIndex((s) => s.id === id) + 1;
}
