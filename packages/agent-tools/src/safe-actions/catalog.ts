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

/**
 * El libro de plata (0172). Anotar ya es idempotente por la referencia que la
 * herramienta deriva de la fuente, así que la guardia sólo evita repetir la
 * llamada (y su tarjeta) y la verificación comprueba que la fila está.
 */
const ledgerRecord: SafeActionPolicy<unknown, { movementId: string }> = {
  windowMs: DAY,
  noun: 'el movimiento',
  verify: ({ output, ctx }) =>
    rowExists(
      ctx,
      'ledger_movements',
      output.movementId,
      'el movimiento está en el libro de plata.',
      'no encuentro el movimiento en el libro de plata.',
    ),
};

const ledgerBatch: AnySafeActionPolicy = { windowMs: 30 * 60_000, noun: 'los movimientos' };

/**
 * Un escenario de caja con el mismo nombre y los mismos ajustes, guardado dos
 * veces el mismo día, es un reintento: la guardia lo para y la verificación
 * mira que la fila quedó.
 */
const ledgerSaveScenario: SafeActionPolicy<unknown, { scenarioId: string }> = {
  windowMs: DAY,
  noun: 'el escenario',
  verify: ({ output, ctx }) =>
    rowExists(
      ctx,
      'ledger_scenarios',
      output.scenarioId,
      'el escenario quedó guardado.',
      'no encuentro el escenario guardado.',
    ),
};

/** Declarar dos veces el mismo arriendo duplicaría la salida en la proyección. */
const ledgerDeclareRecurring: SafeActionPolicy<unknown, { recurringId: string }> = {
  windowMs: DAY,
  noun: 'el movimiento que se repite',
  verify: ({ output, ctx }) =>
    rowExists(
      ctx,
      'ledger_recurring',
      output.recurringId,
      'el movimiento que se repite quedó anotado.',
      'no encuentro el movimiento que se repite.',
    ),
};

/**
 * Confirmar o ignorar lo detectado ya es idempotente (deja el mismo estado), así
 * que basta la guardia corta para no repetir la llamada ni su tarjeta.
 */
const ledgerDecideRecurring: AnySafeActionPolicy = {
  windowMs: 30 * 60_000,
  noun: 'la decisión',
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

/**
 * El resumen del día de una vista (views.refresh_summary): una vez por vista y
 * por DÍA DE BOGOTÁ, que es la clave y no el input entero. Dos corridas de la
 * rutina a la vez no escriben dos versiones. `force` (la persona pidió
 * reescribirlo) va sin guardia. La herramienta además mira el historial de la
 * vista, que cubre lo que esta guardia no ve (cada corrida de una rutina tiene
 * su propio alcance).
 */
const viewSummary: SafeActionPolicy<{ view: string; blockId?: string; force?: boolean }, unknown> =
  {
    windowMs: 20 * HOUR,
    noun: 'el resumen del día',
    key: (input) =>
      input.force
        ? null
        : {
            view: input.view,
            blockId: input.blockId ?? 'resumen_hoy',
            day: new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Bogota',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date()),
          },
  };

/**
 * La revisión semanal (views.weekly_review): una vez por vista y por SEMANA ISO
 * de Bogotá (la clave es el lunes de la semana). Dos corridas de la rutina del
 * lunes a la vez no escriben dos versiones; `force` va sin guardia. Igual que
 * el resumen del día, la herramienta además mira el historial de la vista.
 */
const weeklyReview: SafeActionPolicy<{ view?: string; force?: boolean }, unknown> = {
  windowMs: 7 * DAY,
  noun: 'la revisión semanal',
  key: (input) => {
    if (input.force) return null;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const noon = new Date(`${today}T12:00:00Z`);
    noon.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() + 6) % 7));
    return { view: input.view ?? 'pulso_empresa', week: noon.toISOString().slice(0, 10) };
  },
};

/**
 * Pasar trabajo a otra persona (work.assign): la misma reasignación —mismos
 * ítems, misma persona— dentro de una hora es un reintento, y repetirla
 * mandaría dos avisos a la campana de quien lo recibe.
 */
const workAssign: SafeActionPolicy<{ itemIds?: string[]; person?: string }, unknown> = {
  windowMs: HOUR,
  noun: 'el cambio de responsable',
  key: (input) => ({
    itemIds: [...(input.itemIds ?? [])].sort(),
    person: (input.person ?? '').trim().toLowerCase(),
  }),
};

// --- Sin verificación (todavía): sólo la guardia de repetición -------------

const chatPost: AnySafeActionPolicy = { windowMs: 6 * HOUR, noun: 'el mensaje' };
const externalRecord: AnySafeActionPolicy = { windowMs: DAY, noun: 'el registro' };
const sheetRow: AnySafeActionPolicy = { windowMs: 30 * 60_000, noun: 'la fila' };

// --- El piloto automático (0176): lo rutinario, sin repetir en la ventana ----

const autopilotRemind: SafeActionPolicy<
  { person?: string; title?: string; key?: string },
  unknown
> = {
  windowMs: 12 * HOUR,
  noun: 'el recordatorio',
  key: (input) => ({
    person: (input.person ?? '').trim().toLowerCase(),
    what: input.key ?? (input.title ?? '').trim(),
  }),
};
const retrySync: AnySafeActionPolicy = { windowMs: 30 * 60_000, noun: 'el reintento' };

/**
 * Ventas (0182). Crear la misma cotización dos veces en media hora es un
 * doble clic; mandar el mismo correo o emitir la misma factura en un día, un
 * error caro — la factura se protege además con la llave de idempotencia del
 * programa contable (ver sales/emit.ts).
 */
const salesQuoteCreate: AnySafeActionPolicy = {
  windowMs: 30 * 60_000,
  noun: 'la cotización',
  key: (input: unknown) => input,
};
const salesQuoteSend: AnySafeActionPolicy = {
  windowMs: 24 * 60 * 60_000,
  noun: 'el correo con la cotización',
  key: (input: unknown) => input,
};
const salesInvoiceEmit: AnySafeActionPolicy = {
  windowMs: 24 * 60 * 60_000,
  noun: 'la factura',
  key: (input: unknown) => {
    const i = (input ?? {}) as { document?: unknown; provider?: unknown };
    return { document: i.document ?? null, provider: i.provider ?? null };
  },
};

export const SAFE_ACTION_CATALOG: Readonly<Record<string, AnySafeActionPolicy>> = {
  'sales.quote_create': salesQuoteCreate,
  'sales.quote_send': salesQuoteSend,
  'sales.invoice_emit': salesInvoiceEmit,
  'gmail.send_message': gmailSendMessage as unknown as AnySafeActionPolicy,
  'gmail.send_draft': gmailSendDraft as unknown as AnySafeActionPolicy,
  'outlook.send_draft': outlookSendDraft as unknown as AnySafeActionPolicy,
  'gcal.create_event': gcalCreateEvent as unknown as AnySafeActionPolicy,
  'mscal.create_event': mscalCreateEvent as unknown as AnySafeActionPolicy,
  'payments.record': paymentsRecord as unknown as AnySafeActionPolicy,
  'trackers.upsert': trackersUpsert as unknown as AnySafeActionPolicy,
  'ledger.record': ledgerRecord as unknown as AnySafeActionPolicy,
  'ledger.record_batch': ledgerBatch,
  'ledger.save_scenario': ledgerSaveScenario as unknown as AnySafeActionPolicy,
  'ledger.declare_recurring': ledgerDeclareRecurring as unknown as AnySafeActionPolicy,
  'ledger.decide_recurring': ledgerDecideRecurring,
  'slack.post_message': chatPost,
  'chat.send_message': chatPost,
  'chat.send_dm': chatPost,
  'linear.create_issue': externalRecord,
  'linear.create_comment': chatPost,
  'github.create_issue': externalRecord,
  'github.create_issue_comment': chatPost,
  'gsheets.append_row': sheetRow,
  'views.refresh_summary': viewSummary as unknown as AnySafeActionPolicy,
  'views.weekly_review': weeklyReview as unknown as AnySafeActionPolicy,
  'work.assign': workAssign as unknown as AnySafeActionPolicy,
  'autopilot.remind': autopilotRemind as unknown as AnySafeActionPolicy,
  'trackers.retry_sync': retrySync,
};
