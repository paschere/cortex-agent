/**
 * Cortex's email design system.
 *
 * Every automated email the product sends (routine results, approval requests,
 * anything added later) is assembled from these pieces so they all look like
 * one product rather than one-off strings:
 *
 *   theme.ts       palette, fonts, escaping, link safety
 *   markdown.ts    agent markdown → email-safe HTML (tables above all)
 *   components.ts  pills, stat rows, callouts, buttons, key/value, code
 *   layout.ts      renderEmail() — the full document shell + preheader
 *   *-result.ts    the concrete emails
 *
 * Pure string builders: no `server-only`, no DB, no I/O — trivially testable
 * and safe to render anywhere on the server.
 *
 * NOTE: `packages/agent-tools/src/inbox/render.ts` mirrors these styles rather
 * than importing them — see the comment at the top of that file for why.
 */

export { renderEmail, appBaseUrl, MAX_EMAIL_HTML_CHARS } from './layout';
export type { RenderEmailOptions, RenderedEmail } from './layout';
export { markdownToEmailHtml, inlineMarkdownToHtml, clampMarkdown, preformatted } from './markdown';
export {
  button,
  calloutBox,
  codeBlock,
  divider,
  fineprint,
  keyValueTable,
  lede,
  statRow,
  statusPill,
} from './components';
export type { KeyValueRow, StatItem } from './components';
export { palette, tones, escapeHtml, safeHref, FONT_STACK, MONO_STACK } from './theme';
export type { Tone } from './theme';
export { renderRoutineResultEmail } from './routine-result';
export type { RoutineResultEmailInput } from './routine-result';
export { renderApprovalRequestEmail } from './approval-request';
export type { ApprovalRequestEmailInput } from './approval-request';
export { renderDevTaskEmail } from './dev-task-result';
export type { DevTaskEmailCheck, DevTaskEmailInput } from './dev-task-result';
export { renderCommitmentNoticeEmail } from './commitment-notice';
export type { CommitmentNoticeEmailInput, CommitmentNoticeKind } from './commitment-notice';
export { renderWeeklyReportEmail, weeklySubject } from './weekly-report';
export type { WeeklyReportEmailInput } from './weekly-report';
export { renderFlowResultEmail } from './flow-result';
export type { FlowOutputKind, FlowResultEmailInput } from './flow-result';
