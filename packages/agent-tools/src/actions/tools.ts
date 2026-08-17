import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { getCommitment } from '../commitments/store';
import { registerTool } from '../index';
import { draftCollectionNotice } from './draft';
import {
  ACTION_KINDS,
  type ActionKind,
  KIND_AUDIENCE,
  ORIGIN_KINDS,
  actionSchema,
  adaptAction,
} from './shape';
import { listActions, proposeAction } from './store';

/** The one thing an action ever does. See gmail/send-message.ts for why. */
const ACTION_TOOL_ID = 'gmail.send_message';

/**
 * Turning an answer into an offer.
 *
 * WHY THIS TOOL IS NOT CONFIRMATION-GATED. It sends nothing, posts nothing and
 * changes nothing outside Cortex — it writes a draft into a queue where a human
 * has to approve it before anything happens. Gating it would mean approving
 * twice to send once, and a person who has been asked to approve the same email
 * twice learns to click through the first one.
 *
 * The gate is where it belongs: on `gmail.send_message`, which is
 * `requiresConfirmation` and reached only through a claim carrying the
 * fingerprint of the text that was approved.
 */
export const actionsPropose = registerTool({
  id: 'actions.propose',
  description:
    'Offer an action the user can approve: a ready-to-send email with its recipient, subject and body already written. Use this INSTEAD of describing what could be done — when you find a lapsed receivable, a deadline nobody has answered for, or a client email still unanswered, propose the message rather than suggesting one be written. It sends NOTHING: it puts the draft in front of the user to approve, edit or discard. For kind=collect_payment derived from a commitment, you may omit subject and body and Cortex will write them from the commitment row itself (exact amount, exact date, exact days late) — prefer that over composing figures yourself.',
  inputSchema: z.object({
    kind: z
      .enum(ACTION_KINDS)
      .describe(
        'collect_payment: chase a lapsed receivable with a client. remind_owner: hand a deadline back to the colleague who answers for it. reply_to_client: answer a client email that is still unanswered.',
      ),
    to: z.array(z.string().email()).min(1).max(10).describe('Who receives it'),
    cc: z.array(z.string().email()).max(10).optional(),
    subject: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Omit only for collect_payment derived from a commitment'),
    body: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        'The message exactly as it should go out, in Spanish (Colombia) — usted for a client, tú for a colleague. Omit only for collect_payment derived from a commitment.',
      ),
    rationale: z
      .string()
      .min(3)
      .max(600)
      .describe('One sentence naming the fact this came out of, shown under the draft'),
    originKind: z
      .enum(ORIGIN_KINDS)
      .describe(
        'commitment: derived from a watched deadline. email_thread: from a Gmail thread. manual: the user asked outright.',
      ),
    originId: z
      .string()
      .max(200)
      .optional()
      .describe('The commitment id or the Gmail thread id this came from'),
    threadId: z
      .string()
      .optional()
      .describe('Gmail thread to reply inside, so the answer lands in the same conversation'),
    clientId: z.string().uuid().optional().describe('The client record, when there is one'),
  }),
  outputSchema: z.object({
    action: actionSchema,
    /** True when an identical open proposal already existed. */
    alreadyOpen: z.boolean(),
    note: z.string().describe('What to tell the user, in one line'),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const kind = input.kind as ActionKind;
    let subject = input.subject;
    let body = input.body;
    let rationale = input.rationale;

    // The high-fidelity path: every figure read off the commitment row rather
    // than recalled by the model. See actions/draft.ts.
    if ((!subject || !body) && input.originKind === 'commitment' && input.originId) {
      const row = await getCommitment(ctx.db, input.originId);
      if (!row) {
        throw new ValidationError(
          `No encuentro el compromiso ${input.originId}, así que no puedo redactar el cobro con sus datos.`,
        );
      }
      if (kind !== 'collect_payment') {
        throw new ValidationError(
          'Solo puedo redactar por mi cuenta un cobro de cartera. Para los demás tipos, escribe el asunto y el cuerpo.',
        );
      }
      const drafted = draftCollectionNotice(row, bogotaToday());
      subject ??= drafted.subject;
      body ??= drafted.body;
      rationale = input.rationale || drafted.rationale;
    }

    if (!subject || !body) {
      throw new ValidationError(
        'Falta el asunto o el cuerpo del mensaje. Solo puedo escribirlos yo cuando el cobro viene de un compromiso registrado.',
      );
    }

    const result = await proposeAction(ctx.db, {
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? null,
      kind,
      toolId: ACTION_TOOL_ID,
      payload: {
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject,
        body,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
      originKind: input.originKind,
      originId: input.originId ?? null,
      rationale,
      clientId: input.clientId ?? null,
    });

    const action = adaptAction(result.action);
    const audience = KIND_AUDIENCE[kind];
    return {
      action,
      alreadyOpen: result.outcome === 'already_open',
      note:
        result.outcome === 'already_open'
          ? 'Ya había una acción igual esperando aprobación; te muestro esa en vez de crear otra.'
          : audience === 'client'
            ? 'Está redactada y no se ha enviado nada. Revísala y apruébala si va así.'
            : 'Está redactada y no se ha enviado nada. Apruébala si va así.',
    };
  },
});

export const actionsList = registerTool({
  id: 'actions.list',
  description:
    'List the actions waiting on this user right now — drafts Cortex has proposed and nobody has approved or discarded yet. Use it to answer "what is waiting on me" without guessing.',
  inputSchema: z.object({
    kind: z.enum(ACTION_KINDS).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    actions: z.array(actionSchema),
    summary: z.string(),
  }),
  handler: async (input, ctx) => {
    const rows = await listActions(ctx.db, {
      states: ['proposed'],
      userId: ctx.userId,
      kind: input.kind,
      // Stale proposals are not "waiting on you" — quoting a figure that was
      // true last week is worse than saying nothing.
      approvableAt: new Date(),
      limit: input.limit,
    });
    const actions = rows.map(adaptAction);
    return {
      actions,
      summary:
        actions.length === 0
          ? 'No hay ninguna acción esperando tu aprobación.'
          : `Hay ${actions.length} ${actions.length === 1 ? 'acción esperando' : 'acciones esperando'} tu aprobación.`,
    };
  },
});
