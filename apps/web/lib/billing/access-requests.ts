import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../auth';
import { sendEmail } from '../email';
import { appBaseUrl } from '../email-templates/layout';
import { normalizeSignupCode } from '../signup-code';
import {
  ACCESS_CODE_DAYS,
  type AccessRequestInput,
  type AccessRequestStatus,
} from './access-request-shape';

/**
 * Las solicitudes de acceso: GLOBALES, por el `pool`.
 *
 * `access_requests` (0187) no es de ninguna empresa — quien la llena todavía no
 * tiene una—, así que no pasa por el cliente con alcance ni está en el registro
 * de inquilinos. La misma postura que `company_groups`: SQL directo, y la
 * autorización la pone quien llama (`requirePlatformOperator`, en
 * lib/billing/operators.ts) en cada acción.
 *
 * El código personal se guarda como sha256 y sale en claro UNA vez: en el
 * correo de aprobación (o en pantalla para el operador si no hay correo
 * configurado, para que lo mande por WhatsApp).
 */

export interface AccessRequestRow {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  message: string | null;
  status: AccessRequestStatus;
  reviewedAt: string | null;
  reviewerEmail: string | null;
  reviewNote: string | null;
  codeExpiresAt: string | null;
  signedUpAt: string | null;
  createdAt: string;
}

export function hashAccessCode(code: string): string {
  return createHash('sha256').update(normalizeSignupCode(code), 'utf8').digest('hex');
}

/** CORTEX-XXXX-XXXX, sin letras que se confundan al dictarlo. */
export function generateAccessCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `CORTEX-${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Guarda una solicitud. Idempotente por correo: una segunda solicitud pendiente
 * del mismo correo no apila filas (índice parcial de la 0187) y se responde
 * igual, para no revelar si ese correo ya había pedido.
 */
export async function createAccessRequest(input: AccessRequestInput): Promise<void> {
  await pool.query(
    `insert into public.access_requests (name, company, email, phone, message)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing`,
    [input.name, input.company, input.email, input.phone, input.message],
  );
}

export async function listAccessRequests(limit = 200): Promise<AccessRequestRow[]> {
  const { rows } = await pool.query<AccessRequestRow>(
    `select r.id, r.name, r.company, r.email, r.phone, r.message, r.status,
            r.reviewed_at::text as "reviewedAt", u.email as "reviewerEmail",
            r.review_note as "reviewNote",
            r.invite_code_expires_at::text as "codeExpiresAt",
            r.signed_up_at::text as "signedUpAt", r.created_at::text as "createdAt"
       from public.access_requests r
       left join public.ba_user u on u.id = r.reviewed_by
      order by (r.status = 'pending') desc, r.created_at desc
      limit $1`,
    [limit],
  );
  return rows;
}

export type ApproveResult =
  | { ok: true; emailed: true }
  | { ok: true; emailed: false; code: string }
  | { ok: false; message: string };

/**
 * Aprueba (o reenvía con un código NUEVO) y manda el correo. El código anterior
 * deja de servir en el mismo UPDATE: sólo hay una huella por solicitud.
 */
export async function approveAccessRequest(
  id: string,
  reviewerAccountId: string,
): Promise<ApproveResult> {
  const code = generateAccessCode();
  const { rows } = await pool.query<{ name: string; email: string; company: string }>(
    `update public.access_requests
        set status = 'approved',
            invite_code_hash = $2,
            invite_code_expires_at = now() + make_interval(days => $3),
            reviewed_by = $4,
            reviewed_at = now(),
            updated_at = now()
      where id = $1 and status in ('pending', 'approved')
      returning name, email, company`,
    [id, hashAccessCode(code), ACCESS_CODE_DAYS, reviewerAccountId],
  );
  const request = rows[0];
  if (!request) return { ok: false, message: 'Esa solicitud ya no se puede aprobar.' };

  const signup = `${appBaseUrl() || ''}/signup`;
  const first = request.name.split(' ')[0] || request.name;
  const sent = await sendEmail({
    to: request.email,
    subject: 'Tu acceso a Cortex está listo',
    text:
      `Hola ${first},\n\n` +
      `Aprobamos el acceso de ${request.company} a Cortex. Tu código de invitación es:\n\n` +
      `    ${code}\n\n` +
      `Créalo aquí: ${signup}\n\n` +
      `El código sirve una vez y vence en ${ACCESS_CODE_DAYS} días. Si no pediste esto, ignora este correo.\n`,
  });
  return sent.sent ? { ok: true, emailed: true } : { ok: true, emailed: false, code };
}

export async function rejectAccessRequest(
  id: string,
  reviewerAccountId: string,
  note: string | null,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update public.access_requests
        set status = 'rejected', reviewed_by = $2, reviewed_at = now(),
            review_note = $3, invite_code_hash = null, invite_code_expires_at = null,
            updated_at = now()
      where id = $1 and status in ('pending', 'approved')`,
    [id, reviewerAccountId, note?.slice(0, 500) || null],
  );
  return (rowCount ?? 0) > 0;
}

/** ¿Este código es de una solicitud aprobada y vigente? */
export async function accessCodeIsValid(code: string | null | undefined): Promise<boolean> {
  const normalized = normalizeSignupCode(code);
  if (!normalized) return false;
  const { rows } = await pool.query<{ one: number }>(
    `select 1 as one from public.access_requests
      where invite_code_hash = $1 and status = 'approved' and invite_code_expires_at > now()
      limit 1`,
    [hashAccessCode(normalized)],
  );
  return rows.length > 0;
}

/** Un solo uso: al crearse la cuenta, el código deja de servir. */
export async function markAccessCodeUsed(code: string, userId: string): Promise<void> {
  await pool.query(
    `update public.access_requests
        set status = 'signed_up', signed_up_at = now(), signed_up_user_id = $2,
            updated_at = now()
      where invite_code_hash = $1 and status = 'approved'`,
    [hashAccessCode(code), userId],
  );
}
