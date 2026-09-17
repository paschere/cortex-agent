import type { JobEvent, JobStep } from '@/lib/jobs';

export interface GmailSweepMailbox {
  userId: string;
  organizationId: string;
}

export interface GmailSweepPage {
  mailboxes: GmailSweepMailbox[];
  nextAfterUserId?: string;
}

/**
 * Construye una página durable del reparto. `userId` es la clave primaria de
 * gmail_sync_state, así que sirve como cursor global aun cuando los espacios
 * cambien mientras avanza el barrido. Una fila pausada entre páginas deja de
 * aparecer; una fila nueva anterior al cursor espera al siguiente cron.
 */
export async function buildGmailSweepPage(options: {
  afterUserId?: string;
  pageSize: number;
  load: (afterUserId: string | undefined, limit: number) => Promise<GmailSweepMailbox[]>;
}): Promise<GmailSweepPage> {
  const mailboxes = await options.load(options.afterUserId, options.pageSize);
  const last = mailboxes.at(-1);
  return {
    mailboxes,
    nextAfterUserId: mailboxes.length === options.pageSize && last ? last.userId : undefined,
  };
}

export function gmailSweepEvents(page: GmailSweepPage): JobEvent[] {
  const events: JobEvent[] = page.mailboxes.map((mailbox) => ({
    name: 'gmail/sweep.user',
    data: { userId: mailbox.userId, organizationId: mailbox.organizationId },
  }));
  if (page.nextAfterUserId) {
    events.push({
      name: 'gmail/sweep',
      data: { afterUserId: page.nextAfterUserId },
    });
  }
  return events;
}

export async function dispatchGmailSweepPage(step: JobStep, page: GmailSweepPage): Promise<void> {
  const events = gmailSweepEvents(page);
  if (events.length === 0) return;
  if (step.sendEventStrict) {
    await step.sendEventStrict('dispatch-mailbox-page', events);
    return;
  }
  await step.sendEvent('dispatch-mailbox-page', events);
}
