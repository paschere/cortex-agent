import { button, calloutBox, codeBlock, fineprint, keyValueTable, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * "Zippy needs your approval" email.
 *
 * Urgent but calm: the reassurance comes first (nothing has run), then exactly
 * what would run, then one obvious action. The 15-minute expiry is stated in
 * words rather than implied by a countdown no email client can render.
 */

export interface ApprovalRequestEmailInput {
  /** Human label for the tool, e.g. "Gmail · Send draft". */
  toolLabel: string;
  /** Where the request came from, in plain words. */
  origin: string;
  /** Why this particular tool is gated. */
  reason: string;
  /** The exact arguments, pretty-printed and already truncated by the caller. */
  payload: string;
  firstName?: string | null;
  expiresInMinutes?: number;
}

export function renderApprovalRequestEmail(input: ApprovalRequestEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const approvalsUrl = base ? `${base}/approvals` : '';
  const minutes = input.expiresInMinutes ?? 15;
  const greeting = input.firstName ? `${input.firstName}, ` : '';
  const subject = `Approval needed: ${input.toolLabel}`;

  const body = [
    calloutBox({
      tone: 'warn',
      title: 'Nothing has happened yet',
      text: `${greeting}Zippy stopped before doing this. It only runs if you approve it.`,
    }),
    keyValueTable([
      { label: 'What', value: input.toolLabel },
      { label: 'Where it came from', value: input.origin },
      { label: 'Why it needs approval', value: input.reason },
    ]),
    codeBlock(input.payload, { label: 'Exactly what will run' }),
    approvalsUrl ? button({ href: approvalsUrl, label: 'Review and approve' }) : '',
    fineprint(
      `This request expires ${minutes} minutes after it was created. If it expires, nothing runs — Zippy will ask again the next time it needs to.`,
    ),
  ];

  const html = renderEmail({
    title: `Approval needed: ${input.toolLabel}`,
    preheader: `${input.origin} asked Zippy to run this. Nothing happens until you approve — the request expires in ${minutes} minutes.`,
    eyebrow: 'Waiting on you',
    pillHtml: statusPill({ label: 'Action required', tone: 'warn' }),
    bodyHtml: body.filter(Boolean).join(''),
    footerNote: 'You receive approval requests for actions Zippy runs on your behalf.',
  });

  const text = [
    `${greeting}Zippy needs your approval before it does this.`,
    '',
    `What: ${input.toolLabel}`,
    `Where it came from: ${input.origin}`,
    '',
    `Why it needs approval: ${input.reason}`,
    '',
    'Exactly what will run:',
    input.payload,
    '',
    approvalsUrl ? `Approve or decline: ${approvalsUrl}` : 'Approve or decline it in Zipdev OS.',
    '',
    `Nothing has happened yet — it only runs if you approve. The request expires in ${minutes} minutes.`,
  ].join('\n');

  return { subject, html, text };
}
