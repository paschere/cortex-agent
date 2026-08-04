import { button, calloutBox, codeBlock, fineprint, statRow, statusPill } from './components';
import { MAX_EMAIL_HTML_CHARS, type RenderedEmail, appBaseUrl, renderEmail } from './layout';
import { clampMarkdown, markdownToEmailHtml } from './markdown';

/**
 * "Your routine ran" email.
 *
 * The report itself is agent-written markdown — headings, bullets and, most
 * often, tables. It goes through `markdownToEmailHtml` so people read a report
 * instead of `## Weekly payroll check` and `| Period | Gross |`.
 */

/** Markdown budget for the report body before we point at the app instead. */
const MAX_REPORT_CHARS = 14_000;
const TIGHT_REPORT_CHARS = 5_000;

function formatMoment(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(ms, 1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export interface RoutineResultEmailInput {
  jobId: string;
  jobName: string;
  ok: boolean;
  /** The run's report, as the agent wrote it (markdown). */
  outputMarkdown: string;
  errorMessage?: string | null;
  ranAt: Date;
  durationMs?: number | null;
  /** Already advanced by the dispatcher — null for one-offs. */
  nextRunAt?: Date | null;
  /** The routine's timezone, so timestamps read in the owner's local time. */
  timeZone?: string | null;
}

export function renderRoutineResultEmail(input: RoutineResultEmailInput): RenderedEmail {
  const zone = input.timeZone || 'UTC';
  const base = appBaseUrl();
  const detailUrl = base ? `${base}/schedules/${input.jobId}` : '';
  const subject = `${input.jobName} — ${input.ok ? 'completed' : 'failed'}`;

  const stats = [
    {
      label: 'Ran at',
      value: `${formatMoment(input.ranAt, zone)}${zone === 'UTC' ? ' UTC' : ''}`,
    },
    {
      label: 'Took',
      value: typeof input.durationMs === 'number' ? formatDuration(input.durationMs) : '—',
    },
    {
      label: 'Next run',
      value: input.nextRunAt ? formatMoment(input.nextRunAt, zone) : 'No further runs',
    },
  ];

  const errorText = (input.errorMessage ?? '').trim() || 'Unknown error';

  const build = (reportBudget: number): string => {
    const clamped = clampMarkdown(input.outputMarkdown ?? '', reportBudget);
    const body = input.ok
      ? [
          statRow(stats),
          markdownToEmailHtml(clamped.markdown),
          clamped.truncated
            ? fineprint('This report was shortened for email. See the full result in Cortex.')
            : '',
          detailUrl ? button({ href: detailUrl, label: 'Open in Cortex' }) : '',
        ]
      : [
          statRow(stats),
          calloutBox({
            tone: 'danger',
            title: 'The routine did not finish',
            text: 'Nothing further was delivered from this run. The error is below exactly as it was reported.',
          }),
          codeBlock(errorText, { label: 'Error' }),
          detailUrl ? button({ href: detailUrl, label: 'Open in Cortex' }) : '',
        ];

    return renderEmail({
      title: input.jobName,
      preheader: input.ok
        ? `Your routine finished at ${formatMoment(input.ranAt, zone)}. Here is what it found.`
        : `Your routine failed at ${formatMoment(input.ranAt, zone)}. ${errorText.slice(0, 90)}`,
      eyebrow: 'Scheduled routine',
      pillHtml: statusPill({
        label: input.ok ? 'Completed' : 'Failed',
        tone: input.ok ? 'success' : 'danger',
      }),
      bodyHtml: body.filter(Boolean).join(''),
      footerNote: `You are on the recipient list for the "${input.jobName}" routine. Change or pause it in Cortex.`,
    });
  };

  // Gmail clips long messages and hides the button behind "View entire
  // message" — if the report is genuinely huge, send a short version pointing
  // at the app rather than a clipped one.
  let html = build(MAX_REPORT_CHARS);
  if (html.length > MAX_EMAIL_HTML_CHARS) html = build(TIGHT_REPORT_CHARS);

  // The text part has to read on its own — it is what text-only clients,
  // notification previews and corporate gateways show. `null` marks a line
  // that does not apply; empty strings are real blank lines and stay.
  const textReport = clampMarkdown(input.outputMarkdown ?? '', MAX_REPORT_CHARS);
  const text = [
    `${input.jobName} — ${input.ok ? 'Completed' : 'Failed'}`,
    `Ran at: ${formatMoment(input.ranAt, zone)}${zone === 'UTC' ? ' UTC' : ''}`,
    typeof input.durationMs === 'number' ? `Took: ${formatDuration(input.durationMs)}` : null,
    input.nextRunAt ? `Next run: ${formatMoment(input.nextRunAt, zone)}` : null,
    '',
    '----------------------------------------',
    '',
    input.ok ? textReport.markdown || '(no output)' : `The routine failed:\n\n${errorText}`,
    textReport.truncated ? '\n(Shortened for email — see the full result in Cortex.)' : null,
    '',
    detailUrl ? `Open in Cortex: ${detailUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return { subject, html, text };
}
