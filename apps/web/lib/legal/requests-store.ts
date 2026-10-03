import 'server-only';
import { pool } from '@/lib/auth';
import { type LegalRequestKind, legalDueDate } from './deadlines';
import { type LegalRight, kindForRight } from './rights';

export { LEGAL_RIGHTS, LEGAL_RIGHT_LABEL, type LegalRight, kindForRight } from './rights';

/**
 * CONSULTAS Y RECLAMOS DEL TITULAR (Ley 1581 arts. 14 y 15).
 *
 * Una solicitud nace con su plazo legal ya calculado en días hábiles
 * colombianos (lib/legal/deadlines.ts) y queda a la vista de la persona en
 * Ajustes › Privacidad y datos, con el estado y la fecha límite. Atenderla es
 * trabajo del responsable (hoy: el equipo de Cortex, por el correo LEGAL_CORREO);
 * esta tabla es el registro que prueba que llegó y cuándo vence.
 *
 * Como `legal_consents`, es de la persona y va por el pool de auth, siempre con
 * el id de cuenta de la sesión.
 */

export interface LegalRequestRow {
  id: string;
  kind: LegalRequestKind;
  right_invoked: LegalRight;
  message: string;
  status: string;
  received_at: string;
  due_on: string;
  extended_due_on: string | null;
  response: string | null;
  responded_at: string | null;
}

export async function createLegalRequest(input: {
  accountId: string;
  organizationId: string | null;
  email: string;
  name: string | null;
  right: LegalRight;
  message: string;
  now?: Date;
  status?: 'recibida' | 'respondida';
  response?: string | null;
}): Promise<LegalRequestRow> {
  const now = input.now ?? new Date();
  const kind = kindForRight(input.right);
  const due = legalDueDate(kind, now);
  const answered = input.status === 'respondida';
  const { rows } = await pool.query<LegalRequestRow>(
    `insert into public.legal_requests
       (user_id, organization_id, requester_email, requester_name, kind, right_invoked,
        message, status, received_at, due_on, response, responded_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id, kind, right_invoked, message, status, received_at, due_on::text as due_on,
               extended_due_on::text as extended_due_on, response, responded_at`,
    [
      input.accountId,
      input.organizationId,
      input.email,
      input.name,
      kind,
      input.right,
      input.message,
      input.status ?? 'recibida',
      now.toISOString(),
      due,
      input.response ?? null,
      answered ? now.toISOString() : null,
    ],
  );
  return rows[0] as LegalRequestRow;
}

export async function listLegalRequests(accountId: string): Promise<LegalRequestRow[]> {
  const { rows } = await pool.query<LegalRequestRow>(
    `select id, kind, right_invoked, message, status, received_at, due_on::text as due_on,
            extended_due_on::text as extended_due_on, response, responded_at
       from public.legal_requests
      where user_id = $1
      order by received_at desc
      limit 50`,
    [accountId],
  );
  return rows;
}
