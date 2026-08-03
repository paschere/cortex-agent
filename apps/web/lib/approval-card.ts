import { confirmationReason } from '@/lib/confirmation-notes';
import type { ChatCardV2 } from '@/lib/google-chat';
import { confirmationSummary, toolDisplayName } from '@/lib/tool-labels';

/**
 * The approval CARD Cortex posts in Google Chat.
 *
 * The old approval DM was a wall of text ending in "open /approvals". Approvals
 * expire in 15 minutes, and leaving Chat to find a tab, sign in and click is
 * exactly how that window closes with nothing decided. So the decision happens
 * where the person already is: two buttons, in the message.
 *
 * ── What the buttons carry ────────────────────────────────────────────────
 * A short opaque id and the word approve/decline. NOTHING else — no tool id, no
 * payload, no signed blob. That is the same lesson as `mcp_pending_actions`
 * itself (migration 0033): the first version of the MCP confirmation embedded
 * the whole validated input in a token, and it got truncated in transit. The
 * payload stays on the server; the button is a pointer to it.
 *
 * The id is not a capability either — clicking it proves nothing. Google Chat
 * tells the webhook WHO clicked, and the claim in lib/approvals/claim.ts
 * refuses anyone who is not the approval's owner.
 *
 * ── Card text is HTML, not markdown ───────────────────────────────────────
 * Chat cards render a small HTML subset (`<b>`, `<i>`, `<font>`, `<br>`, `<a>`)
 * and do NOT render markdown, backticks or fenced blocks. They also have no
 * monospace face, so the exact payload goes in a COLLAPSED section instead of a
 * code block — closed by default so the card stays a card, one tap from the
 * full JSON. Everything interpolated is escaped; a payload containing `<b>`
 * must not be able to restyle the card, let alone smuggle a link into it.
 */

/** The function name the buttons invoke; echoed back as `common.invokedFunction`. */
export const APPROVAL_ACTION = 'cortex_approval_decision';

/** Parameter keys on the button. Read back in the CARD_CLICKED handler. */
export const APPROVAL_ID_PARAM = 'approvalId';
export const APPROVAL_DECISION_PARAM = 'decision';

/** How much of the payload is worth putting on a phone screen. */
const MAX_PAYLOAD_CHARS = 1200;

export type ApprovalOrigin = 'mcp' | 'schedule' | 'web' | 'chat';

const ORIGIN_LABEL: Record<ApprovalOrigin, string> = {
  schedule: 'a scheduled routine',
  mcp: 'your Claude conversation',
  chat: 'Google Chat',
  web: 'Zipdev OS',
};

/** Chat renders these literally, so they have to be neutralised. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A time a human recognises, in the timezone they actually live in. */
export function formatClock(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(at);
  } catch {
    // An unknown zone must not cost us the card.
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(at);
  }
}

function payloadText(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    json = String(input);
  }
  const clipped =
    json.length > MAX_PAYLOAD_CHARS
      ? `${json.slice(0, MAX_PAYLOAD_CHARS)}\n… (the rest is in Zipdev OS)`
      : json;
  return escapeHtml(clipped).replace(/\n/g, '<br>');
}

/** Plain-English "what will happen", never a tool id. */
function summaryOf(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return confirmationSummary(toolId, record);
  } catch {
    return toolDisplayName(toolId);
  }
}

function decisionButton(opts: {
  text: string;
  approvalId: string;
  decision: 'approve' | 'decline';
  color?: { red: number; green: number; blue: number; alpha: number };
}): Record<string, unknown> {
  return {
    text: opts.text,
    ...(opts.color ? { color: opts.color } : {}),
    onClick: {
      action: {
        function: APPROVAL_ACTION,
        parameters: [
          { key: APPROVAL_ID_PARAM, value: opts.approvalId },
          { key: APPROVAL_DECISION_PARAM, value: opts.decision },
        ],
      },
    },
  };
}

export interface ApprovalCardOptions {
  approvalId: string;
  toolId: string;
  input: unknown;
  expiresAt: Date;
  origin: ApprovalOrigin;
  /** The person's own timezone, so "expires at 14:47" means 14:47 to them. */
  timeZone: string;
  /** Absolute base URL of Zipdev OS, for the escape hatch link. Optional. */
  appBaseUrl?: string;
}

export function buildApprovalCard(opts: ApprovalCardOptions): ChatCardV2 {
  const label = toolDisplayName(opts.toolId);
  const sections: Array<Record<string, unknown>> = [
    {
      widgets: [
        {
          decoratedText: {
            startIcon: { knownIcon: 'DESCRIPTION' },
            topLabel: 'What I want to do',
            text: escapeHtml(summaryOf(opts.toolId, opts.input)),
            wrapText: true,
          },
        },
        {
          decoratedText: {
            topLabel: `Why it needs you — asked from ${ORIGIN_LABEL[opts.origin]}`,
            text: escapeHtml(confirmationReason(opts.toolId)),
            wrapText: true,
          },
        },
      ],
    },
    {
      header: 'Exactly what will run',
      collapsible: true,
      // Nothing shows until it is opened: the payload is reassurance, not the
      // headline, and on a phone it would otherwise bury the buttons.
      uncollapsibleWidgetsCount: 0,
      widgets: [{ textParagraph: { text: payloadText(opts.input) } }],
    },
    {
      widgets: [
        {
          decoratedText: {
            startIcon: { knownIcon: 'CLOCK' },
            text: `Expires at ${formatClock(opts.expiresAt, opts.timeZone)} — nothing runs unless you approve`,
            wrapText: true,
          },
        },
        {
          buttonList: {
            buttons: [
              decisionButton({
                text: 'Approve',
                approvalId: opts.approvalId,
                decision: 'approve',
                color: { red: 0.06, green: 0.62, blue: 0.35, alpha: 1 },
              }),
              decisionButton({
                text: 'Decline',
                approvalId: opts.approvalId,
                decision: 'decline',
              }),
            ],
          },
        },
      ],
    },
  ];

  if (opts.appBaseUrl) {
    sections.push({
      widgets: [
        {
          buttonList: {
            buttons: [
              {
                text: 'Open in Zipdev OS',
                onClick: { openLink: { url: `${opts.appBaseUrl.replace(/\/+$/, '')}/approvals` } },
              },
            ],
          },
        },
      ],
    });
  }

  return {
    // Stable per approval, so a redraw replaces the card instead of stacking.
    cardId: `approval-${opts.approvalId}`,
    card: {
      header: { title: 'Approval needed', subtitle: label },
      sections,
    },
  };
}

export interface ResolvedCardOptions {
  approvalId: string;
  toolId: string;
  /** Card header: "Approved", "Declined", "Expired", "Already handled". */
  title: string;
  /** One line, first person, no ids: "Approved by you · 14:32". */
  headline: string;
  /** Optional second line — what happened next, or what to do now. */
  detail?: string;
}

/**
 * What the card BECOMES once it has been answered (or refused). The buttons are
 * gone: a decided approval that still offers a button is an invitation to click
 * it again and wonder why nothing happens.
 */
export function buildResolvedCard(opts: ResolvedCardOptions): ChatCardV2 {
  const widgets: Array<Record<string, unknown>> = [
    { decoratedText: { text: escapeHtml(opts.headline), wrapText: true } },
  ];
  if (opts.detail) {
    widgets.push({ textParagraph: { text: escapeHtml(opts.detail).replace(/\n/g, '<br>') } });
  }
  return {
    cardId: `approval-${opts.approvalId}`,
    card: {
      header: { title: opts.title, subtitle: toolDisplayName(opts.toolId) },
      sections: [{ widgets }],
    },
  };
}

/**
 * The one-line message body that sits above the card.
 *
 * Chat uses it for the push notification and the conversation list preview, so
 * it has to make sense with no card rendered at all.
 */
export function approvalNotificationText(toolId: string): string {
  return `⏸️ Waiting on you — ${toolDisplayName(toolId)}. Approve or decline below; nothing has run.`;
}
