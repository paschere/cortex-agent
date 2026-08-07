import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { resolveClient } from './overview';
import { ENTITY_KIND_LABEL, LINK_ENTITY_KINDS, adaptLink, linkSchema } from './shape';
import { applyOrPropose } from './store';

/**
 * Attach one thing to one client, on a person's say-so.
 *
 * WHY THIS TOOL ONLY EVER WRITES `manual`. There is no `method` argument, and
 * there will not be one. A model that could pass `method: 'email_domain'` could
 * claim a domain match for a link it worked out from a name, and every
 * guarantee in this module would rest on the model being honest about its own
 * reasoning. A link that arrives through a chat turn is a link a PERSON asked
 * for, so it is filed as one, under their name — the same posture
 * `commitments.record` takes about where a date came from.
 *
 * The automatic paths do not come through here. They come through
 * `applyOrPropose` from inside the code that actually saw the evidence.
 *
 * Confirmation-gated, and the refusal that matters is the quiet one: if the
 * thing is already confirmed to a different client, nothing is written and the
 * model is told whose it is. Moving something between clients is a deliberate
 * act on the card, not a side effect of asking.
 */
export const clientsLink = registerTool({
  id: 'clients.link',
  description:
    "Attach something Cortex already stored — an email thread, a meeting, a document, a WhatsApp group, a vehicle — to a client, so it shows up on their card. Use it when the person tells you what something belongs to. It records that THEY said so; it never claims the link came from a domain or a NIT. If the thing is already attached to a different client, nothing is written and you are told which one — say so and ask, do not reattach. Requires confirmation.",
  inputSchema: z.object({
    client: z.string().min(2).describe('Client id, name or NIT'),
    kind: z
      .enum(LINK_ENTITY_KINDS)
      .describe(
        'What is being attached: document, meeting, whatsapp_group, email_thread, vehicle or contact',
      ),
    id: z
      .string()
      .uuid()
      .optional()
      .describe('The internal id, for anything that lives in Cortex (document, meeting, group…)'),
    ref: z
      .string()
      .max(400)
      .optional()
      .describe('The external id, for an email thread — the Gmail or Outlook thread id'),
    label: z
      .string()
      .max(300)
      .optional()
      .describe(
        'What it is called: the subject, the title, the plate. Stored alongside so the card can name it even when the original is unreachable.',
      ),
    occurredAt: z
      .string()
      .optional()
      .describe('When it happened, ISO — drives the order on the card'),
  }),
  outputSchema: z.object({
    link: linkSchema.nullable(),
    outcome: z.enum(['applied', 'proposed', 'already_linked', 'taken_by_another_client']),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (!input.id && !input.ref) {
      throw new ValidationError(
        'Falta identificar qué se está vinculando: el id interno, o el id del hilo si es un correo.',
      );
    }
    const clientId = await resolveClient(ctx.db, input.client);
    const kindLabel = ENTITY_KIND_LABEL[input.kind] ?? input.kind;

    const result = await applyOrPropose(ctx.db, {
      clientId,
      kind: input.kind,
      id: input.id ?? null,
      ref: input.ref ?? null,
      label: input.label ?? null,
      occurredAt: input.occurredAt ?? null,
      method: 'manual',
      evidence: null,
      witnessUserId: ctx.userId,
      createdBy: ctx.userId,
    });

    const guidance =
      result.outcome === 'taken_by_another_client'
        ? `No lo vinculé: ese ${kindLabel.toLowerCase()} ya está a nombre de ${result.heldBy?.name ?? 'otro cliente'}. Una misma cosa no puede ser de dos clientes — si está mal, hay que quitarlo de allá desde la ficha.`
        : result.outcome === 'already_linked'
          ? `Ese ${kindLabel.toLowerCase()} ya estaba vinculado a este cliente.`
          : `Listo: el ${kindLabel.toLowerCase()} queda vinculado a este cliente, a tu nombre.`;

    return {
      link: result.link ? adaptLink(result.link) : null,
      outcome: result.outcome,
      guidance,
    };
  },
});
