import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../../commitments/shape';
import { computeView, todayIn } from '../../views/compute';
import { viewExportSheets } from '../../views/export';
import { type ViewSpec } from '../../views/spec';
import { loadViewSources } from '../../views/store';
import { getTrackerBySlug } from '../../trackers/store';
import { listScreens, screenView } from '../store';
import { type TemplateContext, TransientActionError, renderTemplate, renderText } from './engine';
import {
  type Cell,
  type ColumnKind,
  type ReportResult,
  type ReportTable,
  reportQueryProblems,
  runReportQuery,
} from './report';
import { renderReportEmail } from './report-email';
import { buildReportXlsx, renderReportPdf, reportFilename } from './report-files';
import {
  REPORT_DEFAULT_PER_DAY,
  REPORT_FORMAT_LABEL,
  REPORT_MAX_ATTACHMENT_BYTES,
  REPORT_MAX_RECIPIENTS,
  type ReportFormat,
  type ReportSource,
} from './report-spec';
import type { AutomationAction } from './spec';

/**
 * ARMAR Y MANDAR UN REPORTE (la parte con base de datos y correo de la acción
 * `report`). Lo puro vive en report.ts, report-email.ts y report-files.ts.
 *
 * Qué garantiza:
 *   - Una corrida = un envío por destinatario. Los reintentos de la cola
 *     saltan la acción ya hecha (run.ts); sólo se reintenta si NO salió ni uno.
 *   - Un reporte de horario sale una vez por franja (la corrida es única por
 *     franja); los demás disparadores tienen un tope diario por regla
 *     (`maxPerDay`, 3 por defecto) para que una condición que se cumple mil
 *     veces no llene un buzón.
 *   - Lo que se manda queda escrito en el resultado de la corrida: rango,
 *     filas, a quién, adjuntos y lo que no salió.
 *
 * LÍMITE CONOCIDO: el reporte lee la tabla o pantalla COMPLETA, como las demás
 * acciones de una regla (que actúan con la autoridad de quien la creó); los
 * destinatarios por rol reciben las mismas cifras que cualquiera. Quien pone
 * un rol de alcance limitado como destinatario decide qué cifras le llegan.
 */

type ReportAction = Extract<AutomationAction, { type: 'report' }>;

export interface ReportEmailDeps {
  sendEmail(input: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: Array<{ filename: string; contentBase64: string; contentType: string }>;
  }): Promise<{ sent: boolean; reason?: string }>;
}

export interface ReportRunInput {
  db: SupabaseClient;
  deps: ReportEmailDeps;
  app: { id: string; name: string };
  automation: { id: string; trigger: { type: string } };
  runId: string;
  action: ReportAction;
  ctx: TemplateContext;
  now: Date;
  /** Correos de los usuarios de la app con un rol. */
  roleEmails: (role: string) => Promise<string[]>;
}

/** Medianoche de hoy en Bogotá, como instante. */
export function bogotaMidnight(now: Date): Date {
  return new Date(`${todayIn(now)}T00:00:00-05:00`);
}

export const REPORT_SENT_PREFIX = 'Reporte enviado';

async function sentToday(
  db: SupabaseClient,
  automationId: string,
  excludeRunId: string,
  now: Date,
): Promise<number> {
  const { data, error } = await db
    .from('custom_app_automation_runs')
    .select('id, result')
    .eq('automation_id', automationId)
    .gte('created_at', bogotaMidnight(now).toISOString())
    .neq('id', excludeRunId)
    .limit(200);
  if (error) throw error;
  let n = 0;
  for (const r of (data ?? []) as Array<{ result: unknown }>) {
    const list = Array.isArray(r.result) ? (r.result as Array<{ type?: string; ok?: boolean; detail?: string }>) : [];
    if (list.some((x) => x.type === 'report' && x.ok && String(x.detail ?? '').startsWith(REPORT_SENT_PREFIX))) n += 1;
  }
  return n;
}

function inferKind(values: Cell[]): ColumnKind {
  const present = values.filter((v) => v !== null && v !== '');
  return present.length && present.every((v) => typeof v === 'number') ? 'number' : 'text';
}

/** Las hojas de «Exportar» de una pantalla, como tablas de reporte. */
export function sheetsToTables(
  sheets: Array<{ name: string; header: string[]; rows: Cell[][] }>,
): ReportTable[] {
  return sheets.map((s) => ({
    title: s.name,
    columns: s.header.map((label, i) => ({ label, kind: inferKind(s.rows.map((r) => r[i] ?? null)) })),
    rows: s.rows,
  }));
}

export interface BuiltReport {
  title: string;
  rangeLabel: string | null;
  result: ReportResult;
}

/** Lee lo que el reporte necesita y lo arma. Lanza con un mensaje en español si la fuente no sirve. */
export async function buildReport(
  db: SupabaseClient,
  appId: string,
  source: ReportSource,
  title: string,
  now: Date,
): Promise<BuiltReport> {
  if (source.kind === 'query') {
    const tracker = await getTrackerBySlug(db, source.tracker);
    if (!tracker) throw new Error(`La tabla «${source.tracker}» ya no existe.`);
    const problems = reportQueryProblems(source, tracker);
    if (problems.length) throw new Error(problems.join(' '));
    // Sólo se necesita leer las filas de UNA tabla; `loadViewSources` lo hace
    // con las mismas reglas de lectura que las vistas (tope, marca de duplicados).
    const spec = { version: 1, blocks: [{ tracker: source.tracker }], alerts: [] } as unknown as ViewSpec;
    const sources = await loadViewSources(db, spec, { audience: 'team' });
    const src = sources.get(source.tracker);
    if (!src || src.blocked) throw new Error(src?.blocked ?? `No se pudo leer «${source.tracker}».`);
    const result = runReportQuery(source, src, now);
    return { title, rangeLabel: result.range?.label ?? null, result };
  }
  const screens = await listScreens(db, appId);
  const screen = screens.find((s) => s.slug === source.screen);
  if (!screen) throw new Error(`La pantalla «${source.screen}» ya no existe en la app.`);
  const view = await screenView(db, screen);
  const spec: ViewSpec = {
    ...view.spec,
    blocks: view.spec.blocks.map((b) => (b.type === 'table' ? { ...b, limit: 200 } : b)),
  };
  const sources = await loadViewSources(db, spec, { audience: 'team' });
  const computed = computeView(spec, sources, now, { audience: 'team' });
  const tables = sheetsToTables(viewExportSheets(computed));
  const rowCount = tables.reduce((n, t) => n + t.rows.length, 0);
  return {
    title,
    rangeLabel: null,
    result: { tables, rowCount, truncated: false, range: null, notes: [] },
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function runReportAction(a: ReportRunInput): Promise<string> {
  const { action, ctx, now } = a;
  const title = renderText(action.title, ctx).trim() || action.title;

  // 1. Destinatarios.
  const targets = new Set(action.to.map((e) => e.toLowerCase()));
  for (const role of action.roles) for (const e of await a.roleEmails(role)) targets.add(e.toLowerCase());
  const recipients = [...targets].slice(0, REPORT_MAX_RECIPIENTS);
  if (!recipients.length) return 'No había a quién mandarle el reporte.';

  // 2. Tope diario (los horarios salen una vez por franja y no lo necesitan).
  if (a.automation.trigger.type !== 'schedule') {
    const cap = action.maxPerDay ?? REPORT_DEFAULT_PER_DAY;
    const used = await sentToday(a.db, a.automation.id, a.runId, now);
    if (used >= cap)
      return `Omitido: esta regla ya mandó ${used} reporte${used === 1 ? '' : 's'} hoy (tope de ${cap} por día; se cambia con «maxPerDay»).`;
  }

  // 3. Armarlo.
  const built = await buildReport(a.db, a.app.id, action.source, title, now);
  const { result } = built;
  if (action.skipIfEmpty && result.rowCount === 0)
    return `Sin movimiento (${built.rangeLabel ?? 'sin rango'}): no se mandó nada.`;

  // 4. Adjuntos.
  const day = bogotaToday(now);
  const attachments: Array<{ filename: string; contentBase64: string; contentType: string }> = [];
  const dropped: string[] = [];
  for (const format of action.formats as ReportFormat[]) {
    const bytes =
      format === 'xlsx'
        ? await buildReportXlsx(title, result.tables, now)
        : renderReportPdf({
            title,
            subtitle: built.rangeLabel,
            tables: result.tables,
            appName: a.app.name,
            notes: result.notes,
            generatedLabel: `Generado el ${day}`,
          });
    if (bytes.length > REPORT_MAX_ATTACHMENT_BYTES) {
      dropped.push(`${REPORT_FORMAT_LABEL[format]} (pesa más de ${Math.round(REPORT_MAX_ATTACHMENT_BYTES / 1048576)} MB)`);
      continue;
    }
    attachments.push({
      filename: reportFilename(title, day, format),
      contentBase64: toBase64(bytes),
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    });
  }

  // 5. El correo.
  const notes = [...result.notes, ...dropped.map((d) => `No se adjuntó ${d}.`)];
  const mail = renderReportEmail({
    title,
    rangeLabel: built.rangeLabel,
    intro: action.intro ? renderText(action.intro, ctx) : null,
    tables: result.tables,
    appName: a.app.name,
    notes,
    attachments: attachments.map((x) => x.filename),
    rowCount: result.rowCount,
  });
  const subject = action.subject ? renderText(action.subject, ctx) : `${title}${built.rangeLabel ? ` · ${built.rangeLabel}` : ''}`;
  const delivered: string[] = [];
  const failed: string[] = [];
  let lastReason = '';
  for (const to of recipients) {
    const out = await a.deps.sendEmail({ to, subject: subject.slice(0, 200), text: mail.text, html: mail.html, attachments });
    if (out.sent) delivered.push(to);
    else {
      failed.push(to);
      lastReason = out.reason ?? 'no se envió';
    }
  }
  if (!delivered.length) {
    if (/429|5\d\d|timeout/i.test(lastReason)) throw new TransientActionError(lastReason);
    throw new Error(`Ningún correo salió (${lastReason}).`);
  }
  return [
    `${REPORT_SENT_PREFIX} «${title}»${built.rangeLabel ? ` (${built.rangeLabel})` : ''}: ${result.rowCount} fila${result.rowCount === 1 ? '' : 's'}`,
    `a ${delivered.length} de ${recipients.length} (${delivered.join(', ')})`,
    attachments.length ? `adjuntos: ${attachments.map((x) => x.filename).join(', ')}` : 'sin adjuntos',
    ...(failed.length ? [`no salió a ${failed.join(', ')} (${lastReason})`] : []),
    ...(dropped.length ? [`sin adjuntar: ${dropped.join(', ')}`] : []),
  ].join(' · ');
}
