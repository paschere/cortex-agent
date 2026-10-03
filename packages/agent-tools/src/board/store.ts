import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import { appBaseUrl } from '../reports/store';
import { computeNextRun } from '../schedule/recurrence';
import { VIEW_TOKEN_RE, hashViewPassword, mintViewToken, verifyViewPassword } from '../views/store';
import {
  type BoardContent,
  type BoardReport,
  type BoardSettings,
  type BoardVisibility,
  DEFAULT_BOARD_SETTINGS,
} from './shape';

/**
 * EL INFORME PARA SOCIOS EN LA BASE (0191): la configuración (con su rutina) y
 * cada informe con su enlace para compartir.
 *
 * Quién escribe: quien administra o es dueño — generar, compartir, mandar y
 * configurar. Lo revisa este archivo, no la pantalla. La rutina del día N es
 * una fila de `scheduled_jobs` que corre `board.generate` sin nadie mirando:
 * por eso se crea con `allow_unattended_writes` (encenderla ES la
 * autorización, y sólo arma el borrador); MANDARLO nunca corre solo.
 */

export const BOARD_TOOL_ID = 'board.generate';
const TZ = 'America/Bogota';

const REPORT_COLUMNS =
  'id, period, status, title, content, markdown, fallback, generated_at, generated_by, visibility, share_token, share_expires_at, share_views, sent_at, sent_to, updated_at';

interface ReportRow {
  id: string;
  period: string;
  status: BoardReport['status'];
  title: string;
  content: BoardContent;
  markdown: string;
  fallback: boolean;
  generated_at: string;
  generated_by: string | null;
  visibility: BoardVisibility;
  share_token: string | null;
  share_expires_at: string | null;
  share_views: number;
  sent_at: string | null;
  sent_to: string[] | null;
  updated_at: string;
}

function adapt(r: ReportRow): BoardReport {
  return {
    id: r.id,
    period: r.period,
    status: r.status,
    title: r.title,
    content: r.content,
    markdown: r.markdown,
    fallback: r.fallback,
    generatedAt: r.generated_at,
    generatedBy: r.generated_by,
    visibility: r.visibility,
    shareToken: r.share_token,
    shareExpiresAt: r.share_expires_at,
    shareViews: r.share_views ?? 0,
    sentAt: r.sent_at,
    sentTo: Array.isArray(r.sent_to) ? r.sent_to : [],
    updatedAt: r.updated_at,
  };
}

export async function requireBoardManager(db: SupabaseClient, userId: string | null) {
  if (!(await isCompanyManager(db, userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa arma, comparte o manda el informe para socios.',
    );
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export async function readBoardSettings(db: SupabaseClient): Promise<BoardSettings> {
  const { data, error } = await db
    .from('board_report_settings')
    .select('enabled, day_of_month, hour, recipients, job_id, updated_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_BOARD_SETTINGS };
  const r = data as {
    enabled: boolean;
    day_of_month: number;
    hour: number;
    recipients: unknown;
    job_id: string | null;
    updated_at: string;
  };
  return {
    enabled: r.enabled,
    dayOfMonth: r.day_of_month,
    hour: r.hour,
    recipients: Array.isArray(r.recipients)
      ? (r.recipients as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    jobId: r.job_id,
    updatedAt: r.updated_at,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function cleanRecipients(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e) || e.length > 200)
      throw new ValidationError(`«${raw.trim()}» no parece un correo.`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 25) throw new ValidationError('Máximo 25 correos.');
  return out;
}

/**
 * Guarda la configuración y prende, cambia o apaga la rutina mensual. La
 * rutina queda a nombre de quien la prendió (corre con su permiso).
 */
export async function saveBoardSettings(
  db: SupabaseClient,
  input: { enabled: boolean; dayOfMonth: number; hour?: number; recipients: string[] },
  who: { userId: string; agentId: string | null },
): Promise<BoardSettings> {
  await requireBoardManager(db, who.userId);
  const day = Math.round(input.dayOfMonth);
  if (day < 1 || day > 28)
    throw new ValidationError('El día va de 1 a 28 (para que exista todos los meses).');
  const hour = Math.round(input.hour ?? 7);
  if (hour < 0 || hour > 23) throw new ValidationError('La hora va de 0 a 23.');
  const recipients = cleanRecipients(input.recipients);
  const current = await readBoardSettings(db);
  let jobId = current.jobId;

  if (input.enabled) {
    if (!who.agentId)
      throw new ValidationError('Cortex todavía no está configurado en este espacio de trabajo.');
    const cron = `0 ${hour} ${day} * *`;
    const next = computeNextRun(cron, TZ).toISOString();
    const row = {
      name: 'Informe para socios (mensual)',
      kind: 'tool',
      tool_id: BOARD_TOOL_ID,
      tool_input: {},
      instruction: null,
      schedule_kind: 'cron',
      cron,
      timezone: TZ,
      run_at: null,
      allow_unattended_writes: true,
      notify_conversation: true,
      notify_email: false,
      next_run_at: next,
      status: 'active',
    };
    let updated = false;
    if (jobId) {
      const { data, error } = await db
        .from('scheduled_jobs')
        .update(row)
        .eq('id', jobId)
        .neq('status', 'cancelled')
        .select('id')
        .maybeSingle();
      if (error) throw error;
      updated = Boolean(data);
    }
    if (!updated) {
      const { data, error } = await db
        .from('scheduled_jobs')
        .insert({ ...row, user_id: who.userId, agent_id: who.agentId })
        .select('id')
        .single();
      if (error) throw error;
      jobId = (data as { id: string }).id;
    }
  } else if (jobId) {
    const { error } = await db
      .from('scheduled_jobs')
      .update({ status: 'cancelled' })
      .eq('id', jobId);
    if (error) throw error;
    jobId = null;
  }

  const { error } = await db.from('board_report_settings').upsert(
    {
      enabled: input.enabled,
      day_of_month: day,
      hour,
      recipients,
      job_id: jobId,
      updated_by: who.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) throw error;
  return readBoardSettings(db);
}

// ---------------------------------------------------------------------------
// Informes
// ---------------------------------------------------------------------------

export async function listBoardReports(db: SupabaseClient, limit = 36): Promise<BoardReport[]> {
  const { data, error } = await db
    .from('board_reports')
    .select(REPORT_COLUMNS)
    .order('period', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ReportRow[]).map(adapt);
}

export async function getBoardReport(db: SupabaseClient, id: string): Promise<BoardReport | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await db
    .from('board_reports')
    .select(REPORT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as ReportRow) : null;
}

export async function getBoardReportByPeriod(
  db: SupabaseClient,
  period: string,
): Promise<BoardReport | null> {
  const { data, error } = await db
    .from('board_reports')
    .select(REPORT_COLUMNS)
    .eq('period', period)
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as ReportRow) : null;
}

/** Guarda el informe del mes (uno por mes): regenerar lo reemplaza y lo deja en borrador. */
export async function saveBoardReport(
  db: SupabaseClient,
  input: {
    period: string;
    title: string;
    content: BoardContent;
    markdown: string;
    fallback: boolean;
  },
  opts: { userId: string | null },
): Promise<BoardReport> {
  const { data, error } = await db
    .from('board_reports')
    .upsert(
      {
        period: input.period,
        title: input.title.slice(0, 200),
        content: input.content,
        markdown: input.markdown,
        fallback: input.fallback,
        status: 'borrador',
        generated_by: opts.userId,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,period' },
    )
    .select(REPORT_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as ReportRow);
}

export function boardPublicUrl(token: string): string {
  return `${appBaseUrl()}/informe/${token}`;
}

/**
 * La puerta del enlace: privado (sin enlace), enlace, o enlace con contraseña.
 * Pasar a privado borra el token (el enlace viejo muere); `rotate` acuña uno
 * nuevo para cuando un enlace se filtró.
 */
export async function setBoardAccess(
  db: SupabaseClient,
  id: string,
  input: {
    visibility: BoardVisibility;
    password?: string | null;
    days?: number | null;
    rotate?: boolean;
  },
  opts: { userId: string },
): Promise<BoardReport> {
  await requireBoardManager(db, opts.userId);
  const current = await getBoardReport(db, id);
  if (!current) throw new NotFoundError('Ese informe ya no existe.');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.visibility === 'privado') {
    Object.assign(patch, {
      visibility: 'privado',
      share_token: null,
      share_expires_at: null,
      password_hash: null,
      failed_unlocks: 0,
      locked_until: null,
    });
  } else {
    const token = !current.shareToken || input.rotate ? mintViewToken() : current.shareToken;
    patch.visibility = input.visibility;
    patch.share_token = token;
    if (token !== current.shareToken) patch.share_views = 0;
    if (input.days !== undefined)
      patch.share_expires_at =
        input.days === null
          ? null
          : new Date(
              Date.now() + Math.min(Math.max(Math.round(input.days), 1), 365) * 86_400_000,
            ).toISOString();
    if (input.visibility === 'contrasena') {
      if (input.password) {
        patch.password_hash = await hashViewPassword(input.password);
        patch.failed_unlocks = 0;
        patch.locked_until = null;
      } else if (current.visibility !== 'contrasena')
        throw new ValidationError(
          'Para proteger el informe con contraseña, escribe una contraseña.',
        );
    } else patch.password_hash = null;
  }
  const { data, error } = await db
    .from('board_reports')
    .update(patch)
    .eq('id', id)
    .select(REPORT_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as ReportRow);
}

/** Un enlace para mandar: el que hay, o uno nuevo sin contraseña. */
export async function ensureBoardLink(
  db: SupabaseClient,
  report: BoardReport,
  opts: { userId: string },
): Promise<{ report: BoardReport; url: string }> {
  if (report.shareToken && report.visibility !== 'privado')
    return { report, url: boardPublicUrl(report.shareToken) };
  const next = await setBoardAccess(db, report.id, { visibility: 'enlace' }, opts);
  return { report: next, url: boardPublicUrl(next.shareToken as string) };
}

export async function markBoardSent(
  db: SupabaseClient,
  id: string,
  to: string[],
  opts: { userId: string },
): Promise<void> {
  const { error } = await db
    .from('board_reports')
    .update({
      status: 'enviado',
      sent_at: new Date().toISOString(),
      sent_to: to,
      sent_by: opts.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// La puerta de afuera
// ---------------------------------------------------------------------------

export interface PublicBoardRow extends BoardReport {
  organizationId: string;
}

/**
 * Busca por token con el cliente de servicio SIN alcance (lo llama sólo
 * apps/web/lib/board/public.ts). Devuelve la fila sólo si la puerta está
 * abierta: no privado y no vencido. Todo lo demás es null, sin distinguir.
 */
export async function findBoardByToken(
  serviceDb: SupabaseClient,
  token: string,
): Promise<PublicBoardRow | null> {
  if (!VIEW_TOKEN_RE.test(token)) return null;
  const { data, error } = await serviceDb
    .from('board_reports')
    .select(`organization_id, ${REPORT_COLUMNS}`)
    .eq('share_token', token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as ReportRow & { organization_id: string };
  const report = adapt(row);
  if (report.visibility === 'privado' || !report.shareToken) return null;
  if (report.shareExpiresAt && Date.parse(report.shareExpiresAt) <= Date.now()) return null;
  return { ...report, organizationId: row.organization_id };
}

export async function countBoardOpen(db: SupabaseClient, report: BoardReport): Promise<void> {
  await db
    .from('board_reports')
    .update({ share_views: report.shareViews + 1 })
    .eq('id', report.id);
}

export type BoardUnlockOutcome = { ok: true } | { ok: false; reason: 'wrong' | 'locked' };

/** Gasta el intento en la base ANTES de comparar (ver la 0191). */
export async function unlockBoardReport(
  db: SupabaseClient,
  report: Pick<BoardReport, 'id'>,
  password: string,
): Promise<BoardUnlockOutcome> {
  const { data, error } = await db.rpc('board_report_reserve_unlock', { p_report_id: report.id });
  if (error) throw error;
  const reserved = data as { locked?: boolean; hash?: string } | null;
  if (!reserved) return { ok: false, reason: 'wrong' };
  if (reserved.locked || !reserved.hash) return { ok: false, reason: 'locked' };
  if (!(await verifyViewPassword(password.slice(0, 200), reserved.hash)))
    return { ok: false, reason: 'wrong' };
  await db.rpc('board_report_clear_unlocks', { p_report_id: report.id });
  return { ok: true };
}

/** El hash vigente (para firmar la cookie de desbloqueo); nunca sale de aquí afuera. */
export async function boardPasswordHash(db: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await db
    .from('board_reports')
    .select('password_hash')
    .eq('id', id)
    .maybeSingle();
  if (error) return null;
  return (data as { password_hash?: string | null } | null)?.password_hash ?? null;
}
