import { z } from 'zod';
import { addDays, bogotaToday, isoDate } from '../commitments/shape';
import { registerTool } from '../index';
import { listVisibleSpaces } from '../kb/spaces';
import { EXPIRATION_KINDS, EXPIRATION_KIND_LABEL, SUBJECT_KINDS, subjectKey } from './kinds';
import { confirmExpiration, discardExpiration, trackExpiration } from './ops';
import { type Expiration, adaptExpiration, evidenceSentence, expirationSchema } from './shape';
import { getExpiration, hydrate, listExpirations } from './store';

/**
 * Las tres herramientas de «documentos que vencen».
 *
 *   documents.expiring            Lectura: «¿qué vence este mes?», «¿cuándo vence
 *                                 el SOAT de WGY482?». Cada fecha con su cita.
 *   documents.track_expiration    Registrar a mano (con confirmación). La fuente
 *                                 es quien lo dice, no un parámetro.
 *   documents.confirm_expiration  Confirmar (o corregir, o descartar) lo que se
 *                                 leyó de un documento. Con confirmación.
 */

async function visibleSpaces(
  db: Parameters<typeof listVisibleSpaces>[0],
  userId: string,
): Promise<Set<string>> {
  try {
    return new Set((await listVisibleSpaces(db, userId)).map((s) => s.id));
  } catch {
    // Sin saber qué ve, no se le enseña ninguna cita: el lado prudente.
    return new Set();
  }
}

async function resolveUser(
  db: Parameters<typeof listVisibleSpaces>[0],
  email: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// documents.expiring
// ---------------------------------------------------------------------------

export const documentsExpiring = registerTool({
  id: 'documents.expiring',
  description:
    'Company papers that expire and must be renewed — SOAT and tecnomecánica per plate, insurance policies (pólizas), licenses, operating permits, habilitaciones, certificates and client contracts — read from the documents in Brain Knowledge or registered by hand. Answers «¿qué vence este mes?», «¿qué documentos están vencidos?», «¿cuándo vence la póliza de responsabilidad civil?», «¿el SOAT de WGY482 está al día?». Every date comes with the exact sentence of the document it was read from; cite it. Also reports how many readings still wait for a person to confirm them.',
  inputSchema: z.object({
    withinDays: z
      .number()
      .int()
      .min(0)
      .max(730)
      .default(30)
      .describe('How far ahead to look, in days. «Este mes» = days left in the month.'),
    includeOverdue: z.boolean().default(true).describe('Include what already lapsed'),
    kind: z
      .enum(EXPIRATION_KINDS)
      .optional()
      .describe('Narrow to one kind, e.g. "soat" or "poliza"'),
    subject: z
      .string()
      .max(200)
      .optional()
      .describe('A plate, client, person or company name to narrow to'),
    includePendingReview: z
      .boolean()
      .default(true)
      .describe('Also list readings not yet confirmed (they are NOT being watched)'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    today: z.string(),
    expirations: z.array(expirationSchema),
    pendingReview: z.array(expirationSchema),
    overdue: z.number(),
    dueSoon: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const withinDays = input.withinDays ?? 30;
    const limit = input.limit ?? 50;
    const horizon = addDays(today, withinDays);
    const key = input.subject ? subjectKey(input.subject) : '';
    const spaces = await visibleSpaces(ctx.db, ctx.userId);

    const matches = (e: Expiration) =>
      !key ||
      subjectKey(e.subject).includes(key) ||
      subjectKey(e.clientName).includes(key) ||
      subjectKey(e.issuer).includes(key) ||
      subjectKey(e.title).includes(key);

    const [confirmedRows, pendingRows] = await Promise.all([
      listExpirations(ctx.db, {
        needsReview: false,
        kind: input.kind,
        expiresBefore: horizon,
        limit: 500,
      }),
      input.includePendingReview === false
        ? Promise.resolve([])
        : listExpirations(ctx.db, { needsReview: true, kind: input.kind, limit: 200 }),
    ]);
    const [confirmed, pending] = await Promise.all([
      hydrate(ctx.db, confirmedRows),
      hydrate(ctx.db, pendingRows),
    ]);

    const expirations = confirmed
      .map((r) => adaptExpiration(r, today, spaces))
      .filter((e) => (input.includeOverdue === false ? (e.daysLeft ?? 0) >= 0 : true))
      .filter(matches)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
      .slice(0, limit);
    const pendingReview = pending
      .map((r) => adaptExpiration(r, today, spaces))
      .filter(matches)
      .slice(0, 20);

    const overdue = expirations.filter((e) => e.status === 'vencido').length;
    const dueSoon = expirations.filter((e) => e.status === 'por_vencer').length;
    return {
      today,
      expirations,
      pendingReview,
      overdue,
      dueSoon,
      guidance: report(expirations, pendingReview, withinDays),
    };
  },
});

function line(e: Expiration): string {
  const parts = [
    `${e.title} — ${e.expiresOn ? `vence ${e.expiresOn} (${e.when})` : 'sin fecha leída'}`,
    e.number ? `No. ${e.number}` : '',
    e.issuer ? `de ${e.issuer}` : '',
    e.owner ? `responde ${e.owner}` : 'sin responsable',
  ].filter(Boolean);
  return `- ${parts.join('; ')}. ${evidenceSentence(e)}`;
}

function report(all: Expiration[], pending: Expiration[], withinDays: number): string {
  const lines: string[] = [];
  const overdue = all.filter((e) => e.status === 'vencido');
  const soon = all.filter((e) => e.status === 'por_vencer');
  const later = all.filter((e) => e.status === 'vigente');
  if (all.length === 0) {
    lines.push(
      `No hay documentos confirmados que venzan en los próximos ${withinDays} días ni vencidos.`,
    );
  }
  if (overdue.length) {
    lines.push(`VENCIDOS (${overdue.length}):`, ...overdue.slice(0, 15).map(line));
  }
  if (soon.length) {
    lines.push(
      `POR VENCER, YA EN SU VENTANA DE RENOVACIÓN (${soon.length}):`,
      ...soon.slice(0, 15).map(line),
    );
  }
  if (later.length) {
    lines.push(`VIGENTES DENTRO DE LA VENTANA (${later.length}):`, ...later.slice(0, 10).map(line));
  }
  if (pending.length) {
    lines.push(
      `SIN CONFIRMAR (${pending.length}) — leídos de documentos, todavía NO se vigilan; se confirman en /documentos-vencen?tab=revisar o con documents.confirm_expiration:`,
      ...pending.slice(0, 8).map(line),
    );
  }
  lines.push(
    'Al decir una fecha, di de dónde salió (la cita viene en cada una). La renovación de la matrícula mercantil está en el calendario tributario (/impuestos), no aquí.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// documents.track_expiration
// ---------------------------------------------------------------------------

export const documentsTrackExpiration = registerTool({
  id: 'documents.track_expiration',
  description:
    'Register by hand a company paper that expires — a SOAT or tecnomecánica of a plate, a póliza, a license, a permit, a habilitación, a certificate or a contract — so Cortex warns its owner ahead of time (30 days for SOAT, 45 for pólizas, 60 for contracts and licenses by default) and tracks the renewal. The date is filed as stated BY THIS PERSON. Do not use it for something read from a document (that goes through documents.confirm_expiration). Requires confirmation.',
  inputSchema: z.object({
    kind: z.enum(EXPIRATION_KINDS),
    expiresOn: isoDate.describe('Expiry date, YYYY-MM-DD'),
    subject: z
      .string()
      .max(200)
      .optional()
      .describe('Plate for SOAT/tecnomecánica, client for a contract, person for a license'),
    subjectKind: z.enum(SUBJECT_KINDS).optional(),
    label: z
      .string()
      .max(120)
      .optional()
      .describe('Short name, e.g. «Póliza de responsabilidad civil»'),
    issuer: z.string().max(200).optional().describe('Insurer, authority or counterparty'),
    number: z.string().max(120).optional(),
    issuedOn: isoDate.optional(),
    ownerEmail: z.string().email().optional().describe('Who renews it. Defaults to the requester.'),
    renewalLeadDays: z.number().int().min(0).max(365).optional(),
  }),
  outputSchema: z.object({ expiration: expirationSchema, guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const ownerUserId = input.ownerEmail ? await resolveUser(ctx.db, input.ownerEmail) : ctx.userId;
    const result = await trackExpiration(
      ctx.db,
      {
        userId: ctx.userId,
        kind: input.kind,
        expiresOn: input.expiresOn,
        subject: input.subject ?? null,
        subjectKind: input.subjectKind,
        label: input.label ?? null,
        issuer: input.issuer ?? null,
        number: input.number ?? null,
        issuedOn: input.issuedOn ?? null,
        ownerUserId: ownerUserId ?? ctx.userId,
        renewalLeadDays: input.renewalLeadDays ?? null,
        today,
      },
      { userId: ctx.userId, organizationId: ctx.organizationId, today },
    );
    const [row] = await hydrate(ctx.db, [result.row]);
    const expiration = adaptExpiration(row ?? result.row, today);
    return {
      expiration,
      guidance: `Queda registrado: ${expiration.title}, vence ${expiration.expiresOn} (${expiration.when}). El primer aviso sale ${expiration.renewalLeadDays} días antes${expiration.owner ? ` y va para ${expiration.owner}` : ''}.${
        result.renewed.length
          ? ` Cerré ${result.renewed.length === 1 ? 'el papel anterior' : `${result.renewed.length} papeles anteriores`} del mismo tipo: quedan como renovados.`
          : ''
      }${input.ownerEmail && !ownerUserId ? ` «${input.ownerEmail}» no es de nadie en este espacio, así que queda a tu nombre.` : ''}`,
    };
  },
});

// ---------------------------------------------------------------------------
// documents.confirm_expiration
// ---------------------------------------------------------------------------

export const documentsConfirmExpiration = registerTool({
  id: 'documents.confirm_expiration',
  description:
    'Confirm the expiry date Cortex read from a document (pass expiresOn only to CORRECT it), so it starts being watched and the earlier paper of the same kind and subject is closed as renewed — or discard the reading with discardReason when it is not an expiring paper. Use the ids from documents.expiring (pendingReview). Requires confirmation.',
  inputSchema: z.object({
    id: z.string().uuid(),
    expiresOn: isoDate.optional().describe('Only to correct the date that was read'),
    ownerEmail: z.string().email().optional(),
    renewalLeadDays: z.number().int().min(0).max(365).optional(),
    discardReason: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe('Set ONLY to discard: why this is not an expiring paper'),
  }),
  outputSchema: z.object({ expiration: expirationSchema, guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const sync = { userId: ctx.userId, organizationId: ctx.organizationId, today };
    const current = await getExpiration(ctx.db, input.id);
    if (!current)
      throw new Error('Ese vencimiento ya no existe. Pide la lista con documents.expiring.');

    if (input.discardReason) {
      const result = await discardExpiration(
        ctx.db,
        { id: input.id, reason: input.discardReason },
        sync,
      );
      const [row] = await hydrate(ctx.db, [result.row]);
      const expiration = adaptExpiration(row ?? result.row, today);
      return { expiration, guidance: `Descartado: ${expiration.title}. No se vigila.` };
    }

    const ownerUserId = input.ownerEmail ? await resolveUser(ctx.db, input.ownerEmail) : undefined;
    const result = await confirmExpiration(
      ctx.db,
      {
        id: input.id,
        userId: ctx.userId,
        expiresOn: input.expiresOn ?? null,
        ownerUserId: ownerUserId ?? undefined,
        renewalLeadDays: input.renewalLeadDays ?? null,
        today,
      },
      sync,
    );
    const [row] = await hydrate(ctx.db, [result.row]);
    const expiration = adaptExpiration(
      row ?? result.row,
      today,
      await visibleSpaces(ctx.db, ctx.userId),
    );
    const corrected = input.expiresOn && input.expiresOn !== current.expires_on;
    return {
      expiration,
      guidance: `Confirmado: ${expiration.title}, vence ${expiration.expiresOn} (${expiration.when})${
        corrected
          ? ` — corregido a mano; el documento decía ${current.expires_on ?? 'otra cosa'}`
          : ''
      }. Aviso ${expiration.renewalLeadDays} días antes${expiration.owner ? ` a ${expiration.owner}` : ''}.${
        result.renewed.length
          ? ` ${result.renewed.map((r) => `«${r.title}» (${EXPIRATION_KIND_LABEL[r.kind]}, vencía ${r.expires_on})`).join(', ')} queda como renovado.`
          : ''
      }`,
    };
  },
});
