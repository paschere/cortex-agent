import { z } from 'zod';
import { registerTool } from '../../registry';
import {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_LABEL,
  VERIFICATION_LABEL,
  displayPhone,
} from './shape';
import {
  getConversation,
  listConversationMessages,
  listCustomerConversations,
  queueHumanReply,
} from './store';

/**
 * LA ATENCIÓN POR WHATSAPP EN EL CHAT (0185).
 *
 *   whatsapp.customer_conversations  leer: qué clientes escribieron, en qué
 *                                    va cada conversación, y una entera con
 *                                    lo que contestó el bot y de dónde salió.
 *   whatsapp.reply                   contestar COMO PERSONA dentro de una
 *                                    conversación abierta en la que el cliente
 *                                    escribió en las últimas 24 h. Pide
 *                                    confirmación: sale a alguien de fuera.
 *
 * Ninguna de las dos abre una conversación ni le escribe a un número que no
 * escribió primero. No hay herramienta para eso, y no la va a haber.
 */

const conversationOut = z.object({
  id: z.string(),
  who: z.string(),
  phone: z.string(),
  client: z.string().nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  verification: z.string(),
  assignee: z.string().nullable(),
  lastMessageAt: z.string(),
  lastMessage: z.string().nullable(),
});

export const whatsappCustomerConversations = registerTool({
  id: 'whatsapp.customer_conversations',
  description:
    'Read the WhatsApp customer-service conversations: clients who wrote to the company number, what the bot answered (with the invoices or order rows each answer came from), which ones were handed to a person and who has them. Pass `conversationId` to read one whole conversation. Read-only. Use it for «¿quién escribió por WhatsApp?», «¿qué le contestó el bot a Nexa?», «¿qué conversaciones están esperando a una persona?».',
  inputSchema: z.object({
    status: z
      .enum(['activas', ...CONVERSATION_STATUSES])
      .optional()
      .describe('activas = abiertas + escaladas (default); or one status'),
    conversationId: z.string().uuid().optional().describe('Read this conversation in full'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    conversations: z.array(conversationOut),
    messages: z
      .array(
        z.object({
          at: z.string(),
          from: z.string(),
          text: z.string(),
          sources: z.array(z.string()),
        }),
      )
      .optional(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (input.conversationId) {
      const conv = await getConversation(ctx.db, input.conversationId);
      if (!conv) {
        return { conversations: [], markdown: 'No encuentro esa conversación en esta empresa.' };
      }
      const [list, msgs] = await Promise.all([
        listCustomerConversations(ctx.db, { status: conv.status, limit: 200 }),
        listConversationMessages(ctx.db, conv.id),
      ]);
      const item = list.find((c) => c.id === conv.id);
      const who = item?.client_name ?? conv.push_name ?? displayPhone(conv.phone);
      const messages = msgs.map((m) => ({
        at: m.created_at,
        from: m.direction === 'in' ? 'cliente' : m.answered_by === 'persona' ? 'persona' : 'bot',
        text: m.body,
        sources: m.sources.map((s) => s.label),
      }));
      const markdown = [
        `**${who}** · ${displayPhone(conv.phone)} · ${CONVERSATION_STATUS_LABEL[conv.status]} · ${VERIFICATION_LABEL[conv.verification]}`,
        ...messages.map(
          (m) =>
            `- _${m.from}_: ${m.text.replace(/\n+/g, ' ').slice(0, 300)}${
              m.sources.length ? ` (fuente: ${m.sources.slice(0, 3).join(', ')})` : ''
            }`,
        ),
      ].join('\n');
      return {
        conversations: item ? [shape(item)] : [],
        messages,
        markdown,
      };
    }

    const rows = await listCustomerConversations(ctx.db, {
      status: input.status ?? 'activas',
      limit: input.limit ?? 20,
    });
    const conversations = rows.map(shape);
    const markdown =
      conversations.length === 0
        ? 'No hay conversaciones de atención por WhatsApp con ese filtro.'
        : conversations
            .map(
              (c) =>
                `- **${c.who}** (${CONVERSATION_STATUS_LABEL[c.status]}${c.assignee ? `, con ${c.assignee}` : ''}) — ${c.lastMessage?.replace(/\n+/g, ' ').slice(0, 120) ?? ''}`,
            )
            .join('\n');
    return { conversations, markdown };
  },
});

function shape(c: Awaited<ReturnType<typeof listCustomerConversations>>[number]) {
  return {
    id: c.id,
    who: c.client_name ?? c.push_name ?? displayPhone(c.phone),
    phone: displayPhone(c.phone),
    client: c.client_name,
    status: c.status,
    verification: VERIFICATION_LABEL[c.verification] ?? c.verification,
    assignee: c.assignee_name,
    lastMessageAt: c.last_message_at,
    lastMessage: c.last_body,
  };
}

export const whatsappReply = registerTool({
  id: 'whatsapp.reply',
  description:
    'Reply AS A PERSON to a client inside an open WhatsApp customer-service conversation (get the id from whatsapp.customer_conversations). Only works when the client wrote in the last 24 hours, the conversation is not closed and the client did not opt out — the company number never writes first. The text goes out exactly as written, signed by nobody; keep it short. The conversation passes to a person (the bot stops answering it). Requires confirmation.',
  inputSchema: z.object({
    conversationId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(3000)
      .describe('The reply, exactly as the client will read it'),
  }),
  outputSchema: z.object({
    queued: z.boolean(),
    messageId: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const { messageId, conversation } = await queueHumanReply(ctx.db, {
      conversationId: input.conversationId,
      text: input.text,
      userId: ctx.userId,
    });
    return {
      queued: true,
      messageId,
      guidance: `Listo: la respuesta sale por WhatsApp a ${displayPhone(conversation.phone)} en menos de un minuto, en la misma conversación. Desde ahora la atiende una persona; el bot no vuelve a contestar hasta que se cierre.`,
    };
  },
});
