import { gcalFetch } from '../gcal/client';
import { gmailFetch } from '../gmail/client';
import { graphFetch } from '../msgraph/client';
import type { ToolContext } from '../types';
import type { AnySafeActionPolicy, SafeActionPolicy, VerifyOutcome } from './types';

/**
 * QUÉ HERRAMIENTAS SON «SEGURAS DE REPETIR», Y CÓMO SE COMPRUEBA CADA UNA.
 *
 * Una lista explícita y no una regla («todo lo que escribe»), a propósito: la
 * guardia cambia el comportamiento — una acción idéntica dentro de la ventana
 * deja de ejecutarse — y eso tiene que ser una decisión tomada herramienta por
 * herramienta, con su ventana, no un efecto colateral de cómo la clasifica el
 * motor de riesgo. Está centralizada aquí (y no en cada `registerTool`) para que
 * quien revise «qué no se puede hacer dos veces» lo lea en un solo sitio, igual
 * que `security/mandatory-confirmation.ts`. Una herramienta puede declarar su
 * propia `safeAction` en `registerTool`, y esa gana.
 *
 * LAS VENTANAS. Un envío (correo, mensaje) repetido el mismo día con el mismo
 * texto, al mismo destino, es casi siempre un reintento: 24 h. Un evento o un
 * pago idéntico, igual. Una fila de tabla o de hoja idéntica puede ser legítima
 * (dos cafés iguales), así que la ventana es corta: cubre reintentos, no días.
 *
 * LAS VERIFICACIONES. Leen el estado real después de actuar, por la misma
 * conexión con la que se actuó. Nunca lanzan para decir «no»: devuelven
 * `not_verified`. Un fallo del servicio al consultar es `unverifiable`, no
 * `not_verified` — no saber no es lo mismo que saber que no.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|no such item|not ?found/i.test(msg);
}

/** 404 → no está; cualquier otro fallo → no se pudo mirar. */
async function lookup(
  check: () => Promise<VerifyOutcome>,
  missing: VerifyOutcome,
): Promise<VerifyOutcome> {
  try {
    return await check();
  } catch (err) {
    if (isNotFound(err)) return missing;
    return { status: 'unverifiable', detail: 'el servicio no respondió al comprobarlo.' };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Correo -----------------------------------------------------------------

async function gmailInSent(ctx: ToolContext, messageId: string): Promise<VerifyOutcome> {
  return lookup(
    async () => {
      const m = await gmailFetch<{ labelIds?: string[] }>(
        ctx,
        `/messages/${encodeURIComponent(messageId)}?format=minimal`,
      );
      return (m.labelIds ?? []).includes('SENT')
        ? { status: 'verified', detail: 'el correo está en Enviados.' }
        : {
            status: 'not_verified',
            detail: 'el mensaje existe pero Gmail no lo marca como enviado.',
          };
    },
    { status: 'not_verified', detail: 'Gmail no encuentra el mensaje enviado.' },
  );
}

type GmailSent = { messageId: string };

const gmailSendMessage: SafeActionPolicy<Record<string, unknown>, GmailSent> = {
  windowMs: DAY,
  noun: 'el correo',
  verify: ({ output, ctx }) => gmailInSent(ctx, output.messageId),
};

const gmailSendDraft: SafeActionPolicy<{ draftId: string }, GmailSent> = {
  windowMs: DAY,
  noun: 'el correo',
  verify: ({ output, ctx }) => gmailInSent(ctx, output.messageId),
};

/**
 * Outlook manda en diferido: Graph contesta 202 y el mensaje pasa por la
 * Bandeja de salida antes de llegar a Enviados, con OTRO id. Así que se busca
 * por conversación y asunto, dos veces con una pausa corta, y si aún no está
 * se dice «no se pudo verificar» — no «no se envió», que sería falso casi
 * siempre.
 */
const outlookSendDraft: SafeActionPolicy<
  { draftId: string },
  { threadId: string | null; subject: string | null }
> = {
  windowMs: DAY,
  noun: 'el correo',
  verify: async ({ output, ctx, startedAt }) => {
    if (!output.threadId) {
      return {
        status: 'unverifiable',
        detail: 'Outlook no devolvió la conversación para buscarlo.',
      };
    }
    const filter = encodeURIComponent(`conversationId eq '${output.threadId.replace(/'/g, "''")}'`);
    const path = `/me/mailFolders('sentitems')/messages?$filter=${filter}&$select=id,subject,sentDateTime&$top=10`;
    const since = startedAt.getTime() - 2 * 60_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await graphFetch<{
          value?: Array<{ subject?: string | null; sentDateTime?: string | null }>;
        }>(ctx, path);
        const hit = (r?.value ?? []).some(
          (m) =>
            (m.subject ?? null) === output.subject &&
            m.sentDateTime &&
            new Date(m.sentDateTime).getTime() >= since,
        );
        if (hit) return { status: 'verified', detail: 'el correo está en Enviados.' };
      } catch {
        return { status: 'unverifiable', detail: 'Outlook no respondió al comprobarlo.' };
      }
      if (attempt === 0) await sleep(1_500);
    }
    return {
      status: 'unverifiable',
      detail: 'Outlook todavía no lo muestra en Enviados (puede tardar unos segundos).',
    };
  },
};

// --- Calendario -------------------------------------------------------------

type CreatedEvent = { event: { id: string } };

const gcalCreateEvent: SafeActionPolicy<{ calendarId?: string }, CreatedEvent> = {
  windowMs: DAY,
  noun: 'el evento',
  verify: ({ input, output, ctx }) =>
    lookup(
      async () => {
        const cal = encodeURIComponent(input.calendarId ?? 'primary');
        const e = await gcalFetch<{ status?: string }>(
          ctx,
          `/calendars/${cal}/events/${encodeURIComponent(output.event.id)}`,
        );
        return e.status === 'cancelled'
          ? { status: 'not_verified', detail: 'el evento aparece cancelado en el calendario.' }
          : { status: 'verified', detail: 'el evento está en el calendario.' };
      },
      { status: 'not_verified', detail: 'el calendario no encuentra el evento.' },
    ),
};

const mscalCreateEvent: SafeActionPolicy<unknown, CreatedEvent> = {
  windowMs: DAY,
  noun: 'el evento',
  verify: ({ output, ctx }) =>
    lookup(
      async () => {
        const e = await graphFetch<{ id?: string; isCancelled?: boolean }>(
          ctx,
          `/me/events/${encodeURIComponent(output.event.id)}?$select=id,isCancelled`,
        );
        return e?.isCancelled
          ? { status: 'not_verified', detail: 'el evento aparece cancelado en el calendario.' }
          : { status: 'verified', detail: 'el evento está en el calendario.' };
      },
      { status: 'not_verified', detail: 'el calendario no encuentra el evento.' },
    ),
};

// --- Registros propios ------------------------------------------------------

/** La fila existe en la base, leída por la conexión de la empresa. */
async function rowExists(
  ctx: ToolContext,
  table: string,
  id: string,
  found: string,
  missing: string,
): Promise<VerifyOutcome> {
  try {
    const { data, error } = await ctx.db.from(table).select('id').eq('id', id).maybeSingle();
    if (error) return { status: 'unverifiable', detail: 'la base no respondió al comprobarlo.' };
    return data
      ? { status: 'verified', detail: found }
      : { status: 'not_verified', detail: missing };
  } catch {
    return { status: 'unverifiable', detail: 'la base no respondió al comprobarlo.' };
  }
}

const paymentsRecord: SafeActionPolicy<unknown, { paymentId: string | null }> = {
  windowMs: DAY,
  noun: 'el pago',
  verify: ({ output, ctx }) =>
    output.paymentId
      ? rowExists(
          ctx,
          'payments',
          output.paymentId,
          'el pago quedó registrado.',
          'no encuentro el pago registrado.',
        )
      : Promise.resolve({
          status: 'unverifiable',
          detail: 'el registro no devolvió un pago que buscar.',
        }),
};

/** Sólo la CREACIÓN se guarda: una actualización con `rowId` ya es idempotente. */
const trackersUpsert: SafeActionPolicy<{ rowId?: string }, { row: { id: string } }> = {
  windowMs: 30 * 60_000,
  noun: 'la fila',
  key: (input) => (input.rowId ? null : input),
  verify: ({ output, ctx }) =>
    rowExists(
      ctx,
      'tracker_rows',
      output.row.id,
      'la fila está en la tabla.',
      'no encuentro la fila en la tabla.',
    ),
};

// --- Sin verificación (todavía): sólo la guardia de repetición -------------

const chatPost: AnySafeActionPolicy = { windowMs: 6 * HOUR, noun: 'el mensaje' };
const externalRecord: AnySafeActionPolicy = { windowMs: DAY, noun: 'el registro' };
const sheetRow: AnySafeActionPolicy = { windowMs: 30 * 60_000, noun: 'la fila' };

export const SAFE_ACTION_CATALOG: Readonly<Record<string, AnySafeActionPolicy>> = {
  'gmail.send_message': gmailSendMessage as unknown as AnySafeActionPolicy,
  'gmail.send_draft': gmailSendDraft as unknown as AnySafeActionPolicy,
  'outlook.send_draft': outlookSendDraft as unknown as AnySafeActionPolicy,
  'gcal.create_event': gcalCreateEvent as unknown as AnySafeActionPolicy,
  'mscal.create_event': mscalCreateEvent as unknown as AnySafeActionPolicy,
  'payments.record': paymentsRecord as unknown as AnySafeActionPolicy,
  'trackers.upsert': trackersUpsert as unknown as AnySafeActionPolicy,
  'slack.post_message': chatPost,
  'chat.send_message': chatPost,
  'chat.send_dm': chatPost,
  'linear.create_issue': externalRecord,
  'linear.create_comment': chatPost,
  'github.create_issue': externalRecord,
  'github.create_issue_comment': chatPost,
  'gsheets.append_row': sheetRow,
};
