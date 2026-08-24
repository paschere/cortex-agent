import { z } from 'zod';
import { registerTool } from '../index';
import { ensurePersonalSpace, resolveSpaceByName } from '../kb/spaces';
import { getSyncState, setPaused, startTraining } from './sync-state';
import { BACKFILL_WINDOWS, type BackfillWindow, fetchProfile } from './threads';

/**
 * CONECTAR UN BUZÓN Y APRENDER DE ÉL — la herramienta que enciende todo.
 *
 * Lo que hace es pequeño y a propósito: deja escrito QUÉ buzón, CUÁNTO
 * histórico, A DÓNDE va y DESDE QUÉ PUNTO seguir — y encola la primera tanda.
 * Bajarse un año de correo puede tardar horas y no cabe en el turno de nadie;
 * quien lo hace es el trabajo en segundo plano, tanda a tanda, y esta
 * herramienta contesta enseguida diciendo qué va a pasar.
 *
 * NO ES UN INTERRUPTOR ESCONDIDO. Encenderlo lee todo el correo de esta persona
 * y lo guarda en su cerebro, así que la descripción lo dice con esas palabras:
 * un modelo que la llame «por si acaso» tiene que haber leído que eso es lo que
 * hace, y la persona tiene que poder apagarlo con la misma frase con la que lo
 * encendió.
 */

const WINDOW_LABEL: Record<BackfillWindow, string> = {
  '1m': 'el último mes',
  '90d': 'los últimos 90 días',
  '6m': 'los últimos 6 meses',
  '12m': 'el último año',
};

export const gmailTrainBrain = registerTool({
  id: 'gmail.train_brain',
  description:
    "Teach Cortex from the caller's OWN Gmail mailbox: read their mail history and fold it into their private Brain Knowledge space, then keep learning from new mail every day. " +
    'This reads the whole mailbox for the chosen window — internal mail included — and stores it where ONLY that person can search it. It is their mailbox and their private space; there is no parameter for pointing this at anybody else. ' +
    'The history download runs in the background and can take hours for a busy mailbox; this call returns immediately with what it is going to do. Call gmail.training_status to see how it is going, and use `stop: true` to turn the daily learning off.',
  inputSchema: z.object({
    window: z
      .enum(['1m', '90d', '6m', '12m'])
      .default('12m')
      .describe(
        'How far back to read: one month, 90 days, six months, or one year. One year is the maximum and the default.',
      ),
    spaceName: z
      .string()
      .optional()
      .describe(
        'Where to file it, by name. Omitted means the private space only this person can read, which is the only correct destination for a whole mailbox.',
      ),
    stop: z
      .boolean()
      .default(false)
      .describe('Turn off the daily learning. Nothing already archived is deleted.'),
  }),
  outputSchema: z.object({
    state: z.enum(['started', 'restarted', 'stopped', 'not_connected']),
    note: z.string(),
    mailbox: z.string().nullable(),
    spaceName: z.string().nullable(),
    window: z.string().nullable(),
    windowDays: z.number().nullable(),
    queued: z.boolean(),
  }),
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  ],
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    if (input.stop) {
      const existing = await getSyncState(ctx.db, ctx.userId);
      if (!existing) {
        return {
          state: 'not_connected' as const,
          note: 'No hay ningún buzón aprendiendo, así que no había nada que apagar.',
          mailbox: null,
          spaceName: null,
          window: null,
          windowDays: null,
          queued: false,
        };
      }
      await setPaused(ctx.db, ctx.userId, true, 'Apagado por su dueño.');
      return {
        state: 'stopped' as const,
        note: 'Listo: dejo de leer ese buzón. Lo que ya está en tu cerebro se queda — apagar no borra. Dime cuando quieras volver a encenderlo.',
        mailbox: existing.emailAddress,
        spaceName: null,
        window: null,
        windowDays: null,
        queued: false,
      };
    }

    const space = input.spaceName
      ? await resolveSpaceByName(ctx.db, ctx.userId, input.spaceName)
      : await ensurePersonalSpace(ctx.db, ctx.userId);
    if (!space) {
      return {
        state: 'not_connected' as const,
        note: `No encuentro un espacio llamado "${input.spaceName}" en el que puedas escribir. Déjalo en blanco y lo guardo en tu espacio privado, que es donde debe ir un buzón entero.`,
        mailbox: null,
        spaceName: null,
        window: null,
        windowDays: null,
        queued: false,
      };
    }

    // El puntero se toma AHORA, antes de bajar nada: ver `startTraining`.
    const profile = await fetchProfile(ctx);
    const previous = await getSyncState(ctx.db, ctx.userId);
    const window = (input.window ?? '12m') as BackfillWindow;

    await startTraining(ctx.db, {
      userId: ctx.userId,
      emailAddress: profile.emailAddress,
      spaceId: space.id,
      window,
      historyId: profile.historyId,
    });

    const queued =
      (await ctx.enqueueJob?.('gmail/backfill.user', {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
      })) ?? false;

    return {
      state: previous ? ('restarted' as const) : ('started' as const),
      note: `Empiezo a aprender de ${profile.emailAddress}: me traigo ${WINDOW_LABEL[window]} a "${space.name}", que sólo lees tú, y desde mañana leo lo nuevo cada día. La carga va en segundo plano y puede tardar un rato en un buzón cargado; pregúntame cómo va cuando quieras.${queued ? '' : ' (La cola no aceptó el trabajo ahora mismo; el barrido de la mañana lo recoge igual.)'}`,
      mailbox: profile.emailAddress,
      spaceName: space.name,
      window,
      windowDays: BACKFILL_WINDOWS[window],
      queued,
    };
  },
});

export const gmailTrainingStatus = registerTool({
  id: 'gmail.training_status',
  description:
    "How the caller's own mailbox learning is going: which mailbox, how much of the history has been read, whether the daily sweep is on, and the last error if there was one.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    connected: z.boolean(),
    mailbox: z.string().nullable(),
    paused: z.boolean(),
    window: z.string().nullable(),
    threadsArchived: z.number(),
    historyDone: z.boolean(),
    lastSyncedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    note: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const state = await getSyncState(ctx.db, ctx.userId);
    if (!state) {
      return {
        connected: false,
        mailbox: null,
        paused: false,
        window: null,
        threadsArchived: 0,
        historyDone: false,
        lastSyncedAt: null,
        lastError: null,
        note: 'Todavía no estoy aprendiendo de ningún buzón tuyo. Dime que conecte tu Gmail y me traigo tu historial.',
      };
    }

    const done = Boolean(state.backfillDoneAt);
    const note = state.paused
      ? `Está apagado. ${state.lastError ?? 'Lo apagaste tú.'}`
      : done
        ? `Ya me traje ${WINDOW_LABEL[state.backfillWindow]} de ${state.emailAddress ?? 'tu buzón'} — ${state.backfillThreads} conversaciones — y cada día leo lo nuevo.`
        : `Voy bajando ${WINDOW_LABEL[state.backfillWindow]} de ${state.emailAddress ?? 'tu buzón'}: ${state.backfillThreads} conversaciones hasta ahora. Sigue en marcha.`;

    return {
      connected: true,
      mailbox: state.emailAddress,
      paused: state.paused,
      window: state.backfillWindow,
      threadsArchived: state.backfillThreads,
      historyDone: done,
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      note,
    };
  },
});
