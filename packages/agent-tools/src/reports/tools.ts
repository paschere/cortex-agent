import { z } from 'zod';
import { registerTool } from '../index';
import { buildReport } from './build';
import {
  REPORT_KINDS,
  REPORT_KIND_BLURB,
  REPORT_KIND_LABEL,
  type ReportDocument,
  sourceById,
} from './document';
import { longDate, stamp } from './format';
import {
  type ReportRow,
  type StoredReport,
  getReport,
  listReports,
  reportUrl,
  revokeShare,
  saveReport,
  shareExpiresIn,
  shareIsLive,
  shareReport,
  shareUrl,
} from './store';

/**
 * The `reports.*` family: how Cortex builds an informe from the chat.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO HERE. It picks the kind of report
 * and its parameters. That is the entire surface. It does not supply sections,
 * series, figures, prose or markup — those come from `build.ts`, from queries,
 * deterministically. See the header of `document.ts` for why that split is the
 * design rather than an implementation detail.
 *
 * Every tool answers in Spanish, because the thing it is talking about is in
 * Spanish and a model that reads an English summary of a Spanish report will
 * translate the titles back, badly, on the way to the user.
 */

const kindEnum = z.enum(REPORT_KINDS);

const kindHelp = REPORT_KINDS.map((k) => `"${k}" (${REPORT_KIND_LABEL[k]}): ${REPORT_KIND_BLURB[k]}`)
  .join(' ');

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/**
 * The figures, each with the source that backs it, as markdown.
 *
 * This is what the tool hands back to the model, and its shape is the point: a
 * number is never printed without the sentence that says how it was worked out
 * and which system it came from. A model reading this cannot quote a figure
 * without having its citation in the same line of context.
 */
function figuresMarkdown(doc: ReportDocument): string[] {
  const lines: string[] = [];
  for (const section of doc.sections) {
    if (section.type !== 'metrics') continue;
    for (const m of section.items) {
      const src = sourceById(doc, m.figure.sourceId);
      lines.push(
        `- **${m.label}: ${m.figure.display}** — ${m.figure.method} _(${src?.system ?? 'fuente no declarada'}, leído ${stamp(src?.readAt ?? doc.generatedAt, doc.timezone)}, ${src?.rowCount ?? 0} filas)_`,
      );
    }
  }
  return lines;
}

function reportMarkdown(stored: StoredReport, opts: { justCreated?: boolean } = {}): string {
  const { row, document, intact } = stored;
  const lines: string[] = [];

  lines.push(
    opts.justCreated
      ? `**${document.title}** — informe generado y guardado.`
      : `**${document.title}**`,
  );
  lines.push('');
  lines.push(`Periodo: ${document.periodLabel}.`);
  lines.push(`Calculado: ${stamp(document.generatedAt, document.timezone)} (${document.timezone}).`);
  lines.push('');
  lines.push('**Cifras, con su procedencia:**');
  lines.push(...figuresMarkdown(document));

  if (document.notes.length > 0) {
    lines.push('');
    lines.push('**Qué no incluye:**');
    for (const n of document.notes) lines.push(`- ${n}`);
  }

  lines.push('');
  lines.push(`Se ve completo, con los gráficos, en ${reportUrl(row.id)}`);

  if (shareIsLive(row) && row.share_token) {
    lines.push(
      `Enlace para compartir (vence ${shareExpiresIn(row.share_expires_at)}): ${shareUrl(row.share_token)}`,
    );
  } else {
    lines.push('Todavía no tiene enlace público. Usa `reports.share` si hay que mandarlo afuera.');
  }

  if (!intact) {
    lines.push('');
    lines.push(
      '> ⚠️ El contenido guardado no coincide con su huella. Alguien o algo tocó la fila después de generarla: no cites estas cifras sin volver a generar el informe.',
    );
  }

  lines.push('');
  lines.push(
    '_Este informe es una fotografía: muestra los datos tal como estaban al momento de calcularlo y no cambia cuando cambian los datos._',
  );
  return lines.join('\n');
}

const reportSummarySchema = z.object({
  id: z.string(),
  kind: kindEnum,
  title: z.string(),
  periodLabel: z.string(),
  generatedAt: z.string(),
  url: z.string(),
  shareUrl: z.string().nullable(),
  shareExpiresAt: z.string().nullable(),
  shareViews: z.number(),
});

function summarize(row: ReportRow) {
  const live = shareIsLive(row);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    periodLabel: row.period_label,
    generatedAt: row.generated_at,
    url: reportUrl(row.id),
    shareUrl: live && row.share_token ? shareUrl(row.share_token) : null,
    shareExpiresAt: live ? row.share_expires_at : null,
    shareViews: row.share_views ?? 0,
  };
}

// ---------------------------------------------------------------------------
// reports.generate
// ---------------------------------------------------------------------------

export const reportsGenerate = registerTool({
  id: 'reports.generate',
  description:
    'Arma un informe con texto y gráficos, lo guarda, y devuelve el enlace para verlo dentro de Cortex. Úsalo cuando alguien pida "hazme el informe de vencimientos de este mes", "cómo está la flota" o "qué tiene cada cliente pendiente". ' +
    `Tres informes, y sólo tres: ${kindHelp} ` +
    'El informe queda guardado tal como se calculó: es una fotografía, no una consulta que se vuelve a correr. Cada cifra que devuelve trae la fuente y el método con que se sacó — cítalos cuando hables de los números, nunca los des como afirmación tuya. ' +
    'No inventes cifras ni redactes conclusiones que el informe no traiga: si el número no está en la respuesta de esta herramienta, no existe. Si lo que piden no es ninguno de los tres informes, dilo en vez de forzar el más parecido.',
  inputSchema: z.object({
    kind: kindEnum.describe(kindHelp),
    horizonDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        'Sólo para "expiries" y "fleet": cuántos días hacia adelante mirar. 60 por defecto en vencimientos, 90 en flota. "Este mes" ≈ 30.',
      ),
    months: z
      .number()
      .int()
      .min(1)
      .max(24)
      .optional()
      .describe('Sólo para "client_activity": cuántos meses de historia graficar. 6 por defecto.'),
    client: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Sólo para "client_activity": limita el informe a las contrapartes cuyo nombre contenga este texto. Omítelo para ver toda la empresa.',
      ),
  }),
  outputSchema: z.object({
    report: reportSummarySchema,
    figures: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        method: z.string(),
        source: z.string(),
        readAt: z.string(),
      }),
    ),
    notes: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const document = await buildReport(input.kind, {
      db: ctx.db,
      params: {
        horizonDays: input.horizonDays,
        months: input.months,
        client: input.client ?? null,
      },
    });

    const row = await saveReport(ctx, {
      kind: input.kind,
      document,
      params: {
        horizonDays: input.horizonDays ?? null,
        months: input.months ?? null,
        client: input.client ?? null,
      },
    });

    const stored = { row, document, intact: true };

    const figures = document.sections
      .filter((s): s is Extract<typeof s, { type: 'metrics' }> => s.type === 'metrics')
      .flatMap((s) =>
        s.items.map((m) => {
          const src = sourceById(document, m.figure.sourceId);
          return {
            label: m.label,
            value: m.figure.display,
            method: m.figure.method,
            source: src?.system ?? 'fuente no declarada',
            readAt: src?.readAt ?? document.generatedAt,
          };
        }),
      );

    return {
      report: summarize(row),
      figures,
      notes: document.notes,
      markdown: reportMarkdown(stored, { justCreated: true }),
    };
  },
});

// ---------------------------------------------------------------------------
// reports.list
// ---------------------------------------------------------------------------

export const reportsList = registerTool({
  id: 'reports.list',
  description:
    'Lista los informes que ya se generaron y quedaron guardados, del más reciente al más viejo. Úsalo cuando pregunten "¿qué informes tenemos?", "pásame el de julio" o antes de generar uno nuevo, para no repetir uno que ya existe. ' +
    'Cada entrada dice de qué es, qué periodo cubre, cuándo se calculó y si tiene enlace público vivo. Sólo lectura. Para ver las cifras de uno, usa `reports.open` con su id.',
  inputSchema: z.object({
    kind: kindEnum.optional().describe('Filtra por tipo de informe. Omítelo para verlos todos.'),
    mine: z.boolean().default(false).describe('Sólo los que generó la persona que está preguntando.'),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  outputSchema: z.object({
    reports: z.array(reportSummarySchema),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const rows = await listReports(ctx.db, {
      kind: input.kind,
      generatedBy: input.mine ? ctx.userId : undefined,
      limit: input.limit,
    });
    const reports = rows.map(summarize);

    const markdown =
      reports.length === 0
        ? [
            input.kind
              ? `Todavía no hay ningún informe de ${REPORT_KIND_LABEL[input.kind].toLowerCase()} guardado.`
              : 'Todavía no hay informes guardados.',
            '',
            'Puedes generar el primero con `reports.generate`.',
          ].join('\n')
        : [
            `**${reports.length} ${reports.length === 1 ? 'informe guardado' : 'informes guardados'}**, del más reciente al más viejo.`,
            '',
            ...rows.map((r) => {
              const s = summarize(r);
              const share = s.shareUrl
                ? ` · enlace público activo (${s.shareViews} ${s.shareViews === 1 ? 'apertura' : 'aperturas'})`
                : '';
              return `- [${r.title}](${s.url}) — ${r.period_label}, calculado el ${longDate(r.generated_at.slice(0, 10))}${share}.`;
            }),
            '',
            '_Cada uno muestra los datos como estaban el día que se calculó._',
          ].join('\n');

    return { reports, markdown };
  },
});

// ---------------------------------------------------------------------------
// reports.open
// ---------------------------------------------------------------------------

export const reportsOpen = registerTool({
  id: 'reports.open',
  description:
    'Lee un informe ya guardado y devuelve sus cifras con la fuente y el método de cada una. Úsalo cuando pregunten por lo que decía un informe ("¿cuánto dijo el de julio que teníamos en riesgo?") — así respondes con la cifra que ese informe traía, no con la de hoy. ' +
    'No vuelve a consultar la base: devuelve la fotografía guardada. Si la huella del contenido no coincide, la respuesta lo advierte y esas cifras no se deben citar.',
  inputSchema: z.object({
    reportId: z.string().describe('El id que devolvió reports.generate o reports.list.'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    report: reportSummarySchema.nullable(),
    intact: z.boolean(),
    figures: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        method: z.string(),
        source: z.string(),
        readAt: z.string(),
      }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const stored = await getReport(ctx.db, input.reportId);
    if (!stored) {
      return {
        found: false,
        report: null,
        intact: true,
        figures: [],
        markdown:
          'No hay ningún informe con ese id en este espacio de trabajo. Mira `reports.list` para ver cuáles existen.',
      };
    }

    const { document } = stored;
    const figures = document.sections
      .filter((s): s is Extract<typeof s, { type: 'metrics' }> => s.type === 'metrics')
      .flatMap((s) =>
        s.items.map((m) => {
          const src = sourceById(document, m.figure.sourceId);
          return {
            label: m.label,
            value: m.figure.display,
            method: m.figure.method,
            source: src?.system ?? 'fuente no declarada',
            readAt: src?.readAt ?? document.generatedAt,
          };
        }),
      );

    return {
      found: true,
      report: summarize(stored.row),
      intact: stored.intact,
      figures,
      markdown: reportMarkdown(stored),
    };
  },
});

// ---------------------------------------------------------------------------
// reports.share
// ---------------------------------------------------------------------------

export const reportsShare = registerTool({
  id: 'reports.share',
  description:
    'Crea (o revoca) un enlace para que alguien de afuera pueda abrir un informe guardado sin entrar a Cortex. El enlace muestra la misma fotografía que quedó guardada y vence solo. ' +
    'Pedirlo otra vez sobre un informe que ya tenía enlace REEMPLAZA el anterior: el viejo deja de funcionar en el acto, que es lo que se quiere cuando un enlace se fue a quien no era. ' +
    'Avísale a la persona que quien tenga el enlace puede abrirlo — no pide contraseña — antes de mandarlo a un cliente. Para revocarlo sin crear otro, pasa revoke = true.',
  inputSchema: z.object({
    reportId: z.string(),
    days: z
      .number()
      .int()
      .min(1)
      .max(180)
      .default(30)
      .describe('Cuántos días vive el enlace. 30 por defecto.'),
    revoke: z
      .boolean()
      .default(false)
      .describe('Apaga el enlace actual y no crea uno nuevo. El informe sigue guardado.'),
  }),
  outputSchema: z.object({
    shared: z.boolean(),
    url: z.string().nullable(),
    expiresAt: z.string().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const stored = await getReport(ctx.db, input.reportId);
    if (!stored) {
      return {
        shared: false,
        url: null,
        expiresAt: null,
        markdown: 'No hay ningún informe con ese id en este espacio de trabajo.',
      };
    }

    if (input.revoke) {
      await revokeShare(ctx, input.reportId);
      return {
        shared: false,
        url: null,
        expiresAt: null,
        markdown: `Enlace revocado. **${stored.row.title}** ya no se puede abrir desde afuera; adentro sigue igual, en ${reportUrl(stored.row.id)}`,
      };
    }

    const result = await shareReport(ctx, input.reportId, { days: input.days });
    return {
      shared: true,
      url: result.url,
      expiresAt: result.expiresAt,
      markdown: [
        `Enlace listo para **${stored.row.title}**:`,
        '',
        result.url,
        '',
        `Vence el ${longDate(result.expiresAt.slice(0, 10))}. Quien tenga el enlace puede abrirlo, sin contraseña, así que mándalo sólo a quien deba verlo. Muestra la misma fotografía guardada: no cambia aunque cambien los datos.`,
        stored.row.share_token
          ? '\nEl enlace anterior de este informe quedó anulado.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
