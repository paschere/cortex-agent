import 'server-only';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type MailMessage,
  createIntegrationsClient,
  fetchProfile,
  fetchThreadMessages,
  listThreadPage,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { loadIntakePrefs, startIntakeTask } from './create';
import {
  EMAIL_PER_SWEEP,
  type EmailTriggerKind,
  type IntakeMail,
  buildEmailTaskPrompt,
  buildIntakeQueries,
  classifyEmailTrigger,
  emailTaskTitle,
  gmailExternalId,
  gmailThreadExternalId,
} from './shape';

/**
 * EL BARRIDO DE «TAREAS POR CORREO» PARA UNA PERSONA.
 *
 * Corre dentro del trabajo `gmail/sweep.user` (cada 10 min). Sólo si la persona
 * lo encendió en Ajustes. Busca lo que se mandó a sí misma, a su alias +cortex,
 * o lo que etiquetó «Cortex», y abre UNA tarea por mensaje (idempotente por id).
 * No envía nada: la tarea avisa al terminar y trae el enlace.
 */

export interface EmailIntakeOutcome {
  skipped?: string;
  created: number;
  duplicates: number;
  limited?: 'day' | 'active';
}

function toIntakeMail(m: MailMessage): IntakeMail {
  return {
    id: m.id,
    threadId: m.threadId,
    fromEmail: m.fromEmail,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    body: m.body,
    labelIds: m.labelIds,
    ms: m.ms,
    attachments: (m.attachments ?? []).map((a) => ({
      filename: a.filename,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
    })),
  };
}

export async function runEmailIntake(
  organizationId: string,
  userId: string,
): Promise<EmailIntakeOutcome> {
  const db = getOrgScopedClient(organizationId);
  const prefs = await loadIntakePrefs(db, userId);
  if (!prefs.emailEnabled || !prefs.emailEnabledAt) {
    return { skipped: 'no lo encendió', created: 0, duplicates: 0 };
  }
  const enabledAtMs = new Date(prefs.emailEnabledAt).getTime();
  const ctx = { integrations: createIntegrationsClient(db, userId, logger), signal: undefined };

  let mailbox: string;
  try {
    mailbox = (await fetchProfile(ctx)).emailAddress;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'email intake: sin acceso al buzón');
    return { skipped: 'sin acceso al buzón', created: 0, duplicates: 0 };
  }
  if (!mailbox) return { skipped: 'sin buzón', created: 0, duplicates: 0 };

  const queries = buildIntakeQueries(mailbox);
  const [labeled, direct] = await Promise.all([
    listThreadPage(ctx, { query: queries.label, pageSize: 10 }),
    listThreadPage(ctx, { query: queries.direct, pageSize: 10 }),
  ]);

  const candidates: Array<{ mail: IntakeMail; kind: EmailTriggerKind }> = [];
  const seen = new Set<string>();
  const labeledIds = new Set(labeled.threadIds);
  for (const threadId of [...labeled.threadIds, ...direct.threadIds]) {
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    let messages: MailMessage[];
    try {
      messages = await fetchThreadMessages(ctx, threadId);
    } catch {
      continue;
    }
    if (labeledIds.has(threadId)) {
      const last = messages.at(-1);
      const kind =
        last &&
        classifyEmailTrigger(toIntakeMail(last), { mailbox, labeledThread: true, enabledAtMs });
      if (last && kind) candidates.push({ mail: toIntakeMail(last), kind });
      continue;
    }
    for (const m of messages) {
      const mail = toIntakeMail(m);
      const kind = classifyEmailTrigger(mail, { mailbox, labeledThread: false, enabledAtMs });
      if (kind) candidates.push({ mail, kind });
    }
  }

  candidates.sort((a, b) => a.mail.ms - b.mail.ms);
  const out: EmailIntakeOutcome = { created: 0, duplicates: 0 };
  for (const { mail, kind } of candidates) {
    if (out.created >= EMAIL_PER_SWEEP) break;
    const result = await startIntakeTask(db, {
      organizationId,
      userId,
      source: 'email',
      externalId:
        kind === 'label' ? gmailThreadExternalId(mail.threadId) : gmailExternalId(mail.id),
      title: emailTaskTitle(mail.subject, mail.body),
      prompt: buildEmailTaskPrompt(mail, kind),
    });
    if (result.status === 'created') out.created += 1;
    else if (result.status === 'duplicate') out.duplicates += 1;
    else if (result.status === 'limited') {
      out.limited = result.reason;
      break;
    }
  }
  return out;
}
