import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import {
  REPORT_DOCUMENT_VERSION,
  type ReportDocument,
  chartBodySchema,
  tableCellSchema,
  tableColumnSchema,
  validateDocument,
} from './document';
import { renderReportHtml } from './render';
import { type ReportRow, reportUrl, saveReport } from './store';

/**
 * A CHART DRAWN INSIDE THE CONVERSATION, AND HOW IT BECOMES AN INFORME.
 *
 * ===========================================================================
 * THE SAME SPLIT AS EVERY OTHER REPORT, HELD IN A HARDER PLACE
 * ===========================================================================
 * `document.ts` argues at length why the model never writes markup: a model
 * that emits `<td>1.240.000</td>` has become the source of that figure, and the
 * trace is gone in the last step. Everything in that argument applies here and
 * nothing about it is relaxed — `renderChart` is still our code, `escapeHtml`
 * is still the only way a string reaches the page, and `validateDocument` still
 * refuses a citation that points nowhere.
 *
 * What IS different, and it should be stated plainly rather than glossed: for
 * the three built reports the model supplies only a KIND and some PARAMETERS,
 * and `build.ts` queries the numbers. Here the numbers arrive in the tool call.
 * The tool exists precisely to plot something a previous tool already returned
 * in this turn, and there is no query this module could run that would
 * reproduce it — "graph what you just computed" is the request.
 *
 * So the guarantee this tool can offer is weaker than `reports.generate`'s, and
 * pretending otherwise would be the dishonest move. It is:
 *
 *   - Every figure DECLARES its origin. `source.system` and `method` are
 *     required by the schema, they are rendered into the source ledger under
 *     the chart, and each value carries a citation marker that resolves to it.
 *     A chart that cannot say where its numbers came from cannot be built.
 *   - The picture is OUR code. Four shapes, server-side SVG, no model markup.
 *   - The numbers are VISIBLE AS TEXT. The twin table is required by
 *     `chartSectionSchema`, so anyone can check a bar against a figure without
 *     leaving the message.
 *   - The moment is OURS. `readAt` is stamped here, not supplied — a model
 *     cannot claim a number is fresher than the instant it was drawn.
 *   - The row count is DERIVED from the table the model handed us, not asserted
 *     separately, so the two cannot disagree.
 *
 * What it cannot do is prove the number equals the row. That is what the tool
 * description spends its length on, and it is why `method` is mandatory: the
 * accountant's recourse is the sentence saying how it was worked out plus the
 * system it names, exactly as with a figure quoted in prose.
 *
 * ===========================================================================
 * WHY THE DOCUMENT IS STORED BEFORE ANYBODY ASKS TO KEEP IT
 * ===========================================================================
 * The brief for this was "a chart in the chat should be able to become an
 * informe without recomputing anything". The obvious implementation — hold the
 * chart in the message and rebuild a document when somebody presses save — is
 * the one that quietly recomputes: the tool result in the transcript is a
 * summary, the numbers would have to be re-derived from it or re-queried, and
 * the saved report would be a report about a slightly later moment wearing the
 * conversation's title. That is precisely the failure `store.ts` refuses.
 *
 * So the resolved `ReportDocument` is written HERE, at draw time, with the
 * instant already stamped on it. Saving is then a copy from one table to
 * another: `saveChartAsReport` reads the row and hands the very same document
 * to `saveReport`. No query runs, no figure moves, and the informe from
 * November shows what the chat showed in August because it is the same bytes.
 *
 * The cost is a row per chart the model draws, including the ones nobody keeps.
 * They are small, they are scoped to the conversation, and they carry a
 * `purge_at` so they do not accumulate for ever — see migration 0088.
 */

/** The table this module owns. Registered as `tenant()` in tenancy/tables.ts. */
export const CHAT_CHARTS_TABLE = 'chat_charts';

export const CHAT_CHART_COLUMNS =
  'id, conversation_id, title, document, saved_report_id, created_by, created_at, purge_at';

/** How long an unsaved chart stays readable. Long enough to reopen a
 *  conversation next week; short enough that drafts do not pile up for ever. */
export const CHAT_CHART_KEEP_DAYS = 30;

export interface ChatChartRow {
  id: string;
  conversation_id: string | null;
  title: string;
  document: unknown;
  saved_report_id: string | null;
  created_by: string | null;
  created_at: string;
  purge_at: string;
}

// ---------------------------------------------------------------------------
// The input the model may supply
// ---------------------------------------------------------------------------

/**
 * The twin table, minus the two fields the model does not get to write.
 * `sourceId` and `method` are attached below from the declared source, so the
 * citation on the table and the citation on the chart cannot drift apart.
 */
const chartTableSchema = z.object({
  columns: z.array(tableColumnSchema).min(1).max(8),
  rows: z.array(z.array(tableCellSchema).max(8)).max(200),
});

/**
 * Where the numbers came from. Three fields, and deliberately not five: the
 * instant and the row count are facts about this call, so they are taken here
 * rather than asked for. See the header.
 */
const chartSourceSchema = z.object({
  system: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'El sistema de donde salieron los datos, nombrado como lo nombraría una persona: "Cortex · commitments", "RUNT", "HubSpot", "Brain Knowledge". Si vino de otra herramienta que llamaste en este turno, di cuál.',
    ),
  detail: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'El corte exacto que se leyó: filtros, ventana, exclusiones. "Compromisos confirmados con vencimiento entre el 1 de agosto y el 31 de octubre de 2026, sin incluir los ya cumplidos."',
    ),
  caveat: z
    .string()
    .max(300)
    .nullable()
    .default(null)
    .describe('Algo que haga estos datos menos confiables de lo que parecen. Normalmente null.'),
});

const TONE_GUIDANCE =
  'Los colores SIGNIFICAN algo en este producto y no son decoración: "emerald" es vigente, "amber" es por vencer, "rose" es vencido o bloqueado. Úsalos SÓLO cuando la serie de verdad es un estado. Para categorías que no son estados — clientes, meses, tipos de documento — usa "primary", "sky" o "ink". Pintar tres clientes de verde, ámbar y rojo le dice al lector que uno está en problemas.';

const CHART_GUIDANCE = [
  'Cuatro formas, y la forma la decide la PREGUNTA que responden los datos, no el gusto:',
  '"timeseries" — ¿esto va subiendo o bajando? Un valor por periodo, en orden. Necesita al menos tres puntos para que la línea diga algo.',
  '"bars" — ¿quién pesa más? Compara entidades entre sí (clientes, placas, tipos). Horizontal, así que los nombres largos caben.',
  '"composition" — ¿de qué está hecho el total? Las partes de una sola cosa. No lo uses para comparar entidades: eso es "bars".',
  '"timeline" — ¿qué se me viene encima? Fechas sueltas puestas sobre un eje de días, con hoy marcado.',
].join(' ');

// ---------------------------------------------------------------------------
// Building the document
// ---------------------------------------------------------------------------

/**
 * `z.input` rather than `z.infer` on the three structured fields, on purpose.
 *
 * The schemas carry `.default()` on `tone`, `align`, `mono`, `caveat` and
 * `valueUnit`, so their parsed shape has those filled in while the shape a
 * caller writes does not. `chatChartDocument` hands the whole literal to
 * `validateDocument`, which parses it and applies exactly those defaults — so
 * accepting the looser shape here is not a hole, it is the same schema doing
 * the filling one step later, in the one place that also checks the citations.
 */
export interface ChatChartInput {
  heading: string;
  altText: string;
  caption?: string | null;
  periodLabel: string;
  source: z.input<typeof chartSourceSchema>;
  method: string;
  chart: z.input<typeof chartBodySchema>;
  table: z.input<typeof chartTableSchema>;
  notes?: string[];
}

/** The single source id every citation in a chat chart resolves to. */
const SOURCE_ID = 'chat';

/**
 * Assemble a one-section `ReportDocument` from what the model asked for.
 *
 * Exported for the tests, which build documents whose every string is an
 * attack and assert that nothing executable survives the renderer.
 */
export function chatChartDocument(input: ChatChartInput, now: Date = new Date()): ReportDocument {
  const readAt = now.toISOString();
  const table = {
    columns: input.table.columns,
    rows: input.table.rows,
    sourceId: SOURCE_ID,
    method: input.method,
    caption: null,
  };

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'chart',
    title: input.heading,
    subtitle: null,
    periodLabel: input.periodLabel,
    generatedAt: readAt,
    timezone: 'America/Bogota',
    sources: [
      {
        id: SOURCE_ID,
        system: input.source.system,
        detail: input.source.detail,
        readAt,
        // Derived, never asserted: the count IS the twin table's length, so a
        // chart cannot claim it summarised more rows than it shows.
        rowCount: input.table.rows.length,
        caveat: input.source.caveat ?? null,
      },
    ],
    sections: [
      {
        type: 'chart',
        heading: input.heading,
        chart: input.chart,
        altText: input.altText,
        caption: input.caption ?? null,
        table,
        sourceId: SOURCE_ID,
        method: input.method,
      },
    ],
    notes: input.notes ?? [],
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function insertChatChart(
  ctx: ToolContext,
  input: { document: ReportDocument; conversationId?: string | null },
): Promise<ChatChartRow> {
  const purgeAt = new Date(Date.now() + CHAT_CHART_KEEP_DAYS * 86_400_000).toISOString();
  const { data, error } = await ctx.db
    .from(CHAT_CHARTS_TABLE)
    .insert({
      // Minted here for the same reason `saveReport` mints its own: the id is
      // how the message finds the chart again, and the tool has to be able to
      // return it in the same breath as it draws.
      id: randomUUID(),
      conversation_id: input.conversationId ?? ctx.conversationId ?? null,
      title: input.document.title,
      document: input.document,
      created_by: ctx.userId,
      purge_at: purgeAt,
    })
    .select(CHAT_CHART_COLUMNS)
    .single();

  if (error) throw new Error(`No se pudo guardar el gráfico: ${error.message}`);
  return data as unknown as ChatChartRow;
}

/** One chart, with its document parsed and re-validated. Null when it is not
 *  this workspace's — the scoped handle turns another tenant's id into no row. */
export async function getChatChart(
  db: SupabaseClient,
  id: string,
): Promise<{ row: ChatChartRow; document: ReportDocument } | null> {
  const { data, error } = await db
    .from(CHAT_CHARTS_TABLE)
    .select(CHAT_CHART_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`No se pudo abrir el gráfico: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as ChatChartRow;
  return { row, document: validateDocument(row.document) };
}

/**
 * Turn a chart already drawn in the chat into a saved informe.
 *
 * THIS IS THE WHOLE POINT AND IT IS FOUR LINES: read the stored document, hand
 * it to `saveReport`, remember which report it became. No query runs. No figure
 * is recomputed. The `generatedAt` on the saved report is the instant the chart
 * was DRAWN, not the instant somebody pressed the button, because that is when
 * the data was true.
 *
 * Saving twice returns the report that already exists rather than making a
 * second one — the button is in a transcript people scroll back through, and a
 * double click should not produce two identical informes.
 */
export async function saveChartAsReport(
  ctx: ToolContext,
  chartId: string,
): Promise<{ row: ReportRow | null; reportId: string; alreadySaved: boolean }> {
  const stored = await getChatChart(ctx.db, chartId);
  if (!stored) throw new Error('Ese gráfico no existe en este espacio de trabajo.');

  if (stored.row.saved_report_id) {
    return { row: null, reportId: stored.row.saved_report_id, alreadySaved: true };
  }

  const row = await saveReport(ctx, {
    kind: 'chart',
    document: stored.document,
    params: { chartId },
    conversationId: stored.row.conversation_id,
  });

  await ctx.db.from(CHAT_CHARTS_TABLE).update({ saved_report_id: row.id }).eq('id', chartId);

  return { row, reportId: row.id, alreadySaved: false };
}

/**
 * The chart as markup, ready to inject.
 *
 * `compact` drops the document masthead — in a chat bubble the conversation
 * already gave the chart its heading — and keeps the source ledger, which is
 * the part that makes the numbers checkable. See `RenderOptions.compact`.
 */
export function renderChatChartHtml(document: ReportDocument, id: string): string {
  return renderReportHtml(document, {
    idPrefix: `cc${id.replace(/-/g, '').slice(0, 12)}`,
    compact: true,
  });
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const reportsChart = registerTool({
  id: 'reports.chart',
  description:
    'Dibuja un gráfico con cifras que YA calculaste o que otra herramienta ya devolvió en este turno, y lo muestra dentro de la conversación con un botón para conservarlo como informe. ' +
    'Úsalo cuando la respuesta se entiende mejor viéndola: una evolución mes a mes, una comparación entre clientes, de qué está compuesto un total, o qué vencimientos se vienen encima. ' +
    `${CHART_GUIDANCE} ` +
    'NO grafiques dos o tres números: eso se dice en una frase y un gráfico de tres barras ocupa más de lo que aclara. NO grafiques nada que no puedas citar. ' +
    'REGLA DURA SOBRE LAS CIFRAS: copia los valores tal como te los devolvió la herramienta que los produjo, sin redondear, sin reescalar y sin completar los que falten. ' +
    '`source.system` tiene que nombrar el sistema real de donde salieron y `method` tiene que decir en una frase cómo se sacó el número, de forma que alguien pueda rehacerlo a mano. ' +
    'Si no sabes de dónde salió una cifra, no la grafiques. ' +
    'La tabla no es opcional y no es un resumen: son los mismos datos del gráfico en texto, para quien use lector de pantalla y para quien necesite comprobar un valor. ' +
    `${TONE_GUIDANCE} ` +
    'El gráfico queda como fotografía: no se recalcula cuando cambian los datos.',
  inputSchema: z.object({
    heading: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'Título del gráfico, en español y en minúscula de oración. Di qué muestra, no "Gráfico".',
      ),
    periodLabel: z
      .string()
      .min(1)
      .max(80)
      .describe('Qué ventana cubre: "agosto de 2026", "próximos 90 días", "últimos 6 meses".'),
    altText: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'Una frase que describa la FORMA de lo que se ve, para quien no puede verlo: "Los vencimientos suben de 4 en julio a 19 en octubre, con el pico en septiembre." No repitas el título.',
      ),
    caption: z
      .string()
      .max(300)
      .nullable()
      .default(null)
      .describe('Una nota corta bajo el gráfico. Normalmente null.'),
    source: chartSourceSchema,
    method: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'Cómo se sacaron estas cifras, en una frase que alguien pueda seguir con la base delante: "suma de amount_cop de los compromisos confirmados, agrupada por mes de vencimiento".',
      ),
    chart: chartBodySchema.describe(CHART_GUIDANCE),
    table: chartTableSchema.describe(
      'Los mismos datos del gráfico, en columnas y filas. Marca `mono: true` en las columnas de cifras, fechas, placas e identificadores, y `align: "right"` en las numéricas.',
    ),
    notes: z
      .array(z.string().max(300))
      .max(5)
      .default([])
      .describe('Qué NO incluye el gráfico: exclusiones, datos que faltaban, supuestos.'),
  }),
  outputSchema: z.object({
    chartId: z.string(),
    heading: z.string(),
    altText: z.string(),
    source: z.string(),
    readAt: z.string(),
    rowCount: z.number(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const document = chatChartDocument({
      heading: input.heading,
      altText: input.altText,
      caption: input.caption,
      periodLabel: input.periodLabel,
      source: input.source,
      method: input.method,
      chart: input.chart,
      table: input.table,
      notes: input.notes,
    });

    const row = await insertChatChart(ctx, { document });
    const source = document.sources[0];

    return {
      chartId: row.id,
      heading: document.title,
      altText: input.altText,
      source: input.source.system,
      readAt: source?.readAt ?? document.generatedAt,
      rowCount: source?.rowCount ?? 0,
      // Deliberately NOT the SVG. The picture is for the person, and putting
      // twenty kilobytes of markup into the transcript would resend it to the
      // model on every subsequent turn for no benefit — it already knows what
      // it plotted. The client fetches the drawing by id; see
      // apps/web/app/api/chat/charts/[id]/route.ts.
      markdown:
        `El gráfico **${document.title}** ya está en la conversación, con su tabla y su fuente debajo. ` +
        'La persona puede conservarlo como informe desde ahí. No repitas las cifras que acabas de graficar: ya se ven. ' +
        'Di en una frase qué se concluye de la forma del gráfico, que es lo que el dibujo no dice solo.',
    };
  },
});

/** Retention sweep, called by the same cron that purges the other captures. */
export async function purgeChatCharts(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from(CHAT_CHARTS_TABLE)
    .delete()
    .lt('purge_at', new Date().toISOString())
    .is('saved_report_id', null)
    .select('id');
  if (error) return 0;
  return (data ?? []).length;
}

/** Where a saved chart ended up, for the message that says so. */
export function chartReportUrl(reportId: string): string {
  return reportUrl(reportId);
}
