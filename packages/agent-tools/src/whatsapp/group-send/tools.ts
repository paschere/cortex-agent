import { z } from 'zod';
import { registerTool } from '../../registry';
import { GROUP_SEND_PER_GROUP_PER_HOUR, GROUP_SEND_PER_ORG_PER_DAY } from './rules';
import { listGroupMessages, listSendGroups, queueGroupMessage } from './store';

/**
 * CORTEX Y LOS GRUPOS DE WHATSAPP QUE LA EMPRESA HABILITÓ (migración 0213).
 *
 *   whatsapp.group_send      mandar UN mensaje a un grupo habilitado. Pide
 *                            confirmación en el chat; desde una automatización
 *                            sólo corre si la regla lo declara (`allow`).
 *   whatsapp.group_messages  leer lo reciente de un grupo habilitado (y las
 *                            respuestas a lo que Cortex preguntó). Sólo lectura.
 *
 * Nunca a un contacto individual, sólo a grupos con «Permitir mensajes de
 * Cortex», con topes por grupo/hora y por empresa/día y un apagado general.
 * RIESGO: el número no usa la API oficial; WhatsApp puede bloquear números que
 * escriben de forma automática. Poco volumen, texto de persona.
 */

export const whatsappGroupSend = registerTool({
  id: 'whatsapp.group_send',
  description: `Send ONE short WhatsApp message to a group the company explicitly enabled for Cortex messages («Permitir mensajes de Cortex»). Never to an individual contact. Write like a person (a greeting and one clear question; no lists, no hashtags, at most two links). Hard caps: ${GROUP_SEND_PER_GROUP_PER_HOUR} messages per group per hour, ${GROUP_SEND_PER_ORG_PER_DAY} per company per day, and the same text is not repeated to the same group within minutes. The message leaves within about a minute; to catch the reply read the group later with whatsapp.group_messages (the replies cite your message). If no group is enabled it says so. Requires confirmation in chat.`,
  inputSchema: z.object({
    group: z.string().trim().min(1).max(200).describe('Group name (or part of it), as enabled'),
    text: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('The message, exactly as the group will read it'),
  }),
  outputSchema: z.object({
    queued: z.boolean(),
    groupName: z.string(),
    messageId: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const q = await queueGroupMessage(ctx.db, {
      group: input.group,
      text: input.text,
      userId: ctx.userId,
      via: ctx.surface === 'schedule' ? 'automation' : 'chat',
    });
    return {
      queued: true,
      groupName: q.groupName,
      messageId: q.id,
      guidance: `En cola: sale a «${q.groupName}» en menos de un minuto, con «escribiendo…». Para ver quién responde, lee el grupo con whatsapp.group_messages más tarde.`,
    };
  },
});

export const whatsappGroupMessages = registerTool({
  id: 'whatsapp.group_messages',
  description:
    'Read the recent messages of a WhatsApp group that is enabled for Cortex messages (who wrote, when, the text, and which message each one replies to — "quotes"). Includes what Cortex itself sent. Optionally filter by text (e.g. a waybill number) and by hours back. Without `group` it lists the enabled groups. Read-only. Use it to catch the reply to a question sent with whatsapp.group_send: look for messages that quote it or mention the value you asked about.',
  inputSchema: z.object({
    group: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Group name; omit to list enabled groups'),
    contains: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe('Only messages whose text (or the quoted text) contains this'),
    sinceHours: z.number().int().min(1).max(168).default(24),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  outputSchema: z.object({
    groups: z.array(z.object({ jid: z.string(), name: z.string() })).optional(),
    groupName: z.string().optional(),
    messages: z.array(
      z.object({
        id: z.string(),
        at: z.string(),
        from: z.string(),
        fromCortex: z.boolean(),
        text: z.string(),
        quotesId: z.string().nullable(),
        quotes: z.string().nullable(),
      }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (!input.group) {
      const groups = await listSendGroups(ctx.db);
      return {
        groups: groups.map((g) => ({ jid: g.jid, name: g.subject ?? g.jid })),
        messages: [],
        markdown: groups.length
          ? `Grupos habilitados para Cortex: ${groups.map((g) => g.subject ?? g.jid).join(', ')}.`
          : 'Ningún grupo permite mensajes de Cortex todavía.',
      };
    }
    const { groupName, messages } = await listGroupMessages(ctx.db, {
      group: input.group,
      sinceHours: input.sinceHours ?? 24,
      contains: input.contains,
      limit: input.limit ?? 40,
    });
    const markdown = messages.length
      ? messages
          .map(
            (m) =>
              `- ${m.at.slice(0, 16).replace('T', ' ')} **${m.from}**${m.quotes ? ` (responde a «${m.quotes.slice(0, 80)}»)` : ''}: ${m.text.replace(/\n+/g, ' ').slice(0, 300)}`,
          )
          .join('\n')
      : 'No hay mensajes recientes con ese filtro.';
    return { groupName, messages, markdown };
  },
});
