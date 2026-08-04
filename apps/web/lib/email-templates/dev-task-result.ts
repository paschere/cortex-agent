import {
  button,
  calloutBox,
  codeBlock,
  keyValueTable,
  statRow,
  statusPill,
} from "./components";
import {
  MAX_EMAIL_HTML_CHARS,
  type RenderedEmail,
  appBaseUrl,
  renderEmail,
} from "./layout";
import { clampMarkdown, markdownToEmailHtml } from "./markdown";

/**
 * "Cortex worked on the codebase" email.
 *
 * Two outcomes only, and one email each:
 *
 *   needs_review  Cortex finished, the pull request is open, a person has to
 *                 look. This is the ONE message a successful run sends — there
 *                 is no "started", no "branch pushed", no "checks green".
 *   failed        Cortex could not finish. The reason leads as a sentence; the
 *                 technical detail sits underneath it, for whoever wants it.
 *
 * The person reading this may not be an engineer. Branch names and check names
 * are facts on the record, not the headline.
 */

const MAX_SUMMARY_CHARS = 6_000;
const TIGHT_SUMMARY_CHARS = 2_000;

export interface DevTaskEmailCheck {
  name: string;
  status: "passed" | "failed" | "pending" | "skipped";
}

export interface DevTaskEmailInput {
  taskId: string;
  /** What was asked, one line. */
  title: string;
  outcome: "needs_review" | "failed";
  repository?: string | null;
  issueKey?: string | null;
  issueUrl?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  /** Plain-language "what changed", as the executor wrote it (markdown). */
  summary?: string | null;
  /** One sentence. Never a stack trace. */
  failureReason?: string | null;
  /** The technical detail — secondary, and only if it exists. */
  errorDetail?: string | null;
  checks?: DevTaskEmailCheck[];
  durationText?: string | null;
  costText?: string | null;
  /** First name of the person this is going to, when we know it. */
  firstName?: string | null;
}

function checkLine(checks: DevTaskEmailCheck[]): string | null {
  if (checks.length === 0) return null;
  const failed = checks.filter((c) => c.status === "failed");
  const passed = checks.filter((c) => c.status === "passed").length;
  if (failed.length > 0) {
    return `${failed.length} check${failed.length === 1 ? "" : "s"} failed — ${failed
      .map((c) => c.name)
      .join(", ")}`;
  }
  const pending = checks.filter((c) => c.status === "pending").length;
  if (pending > 0)
    return `${passed} of ${checks.length} checks passed, ${pending} still running`;
  return `All ${checks.length} check${checks.length === 1 ? "" : "s"} passed`;
}

export function renderDevTaskEmail(input: DevTaskEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const detailUrl = base ? `${base}/dev-work/${input.taskId}` : "";
  const ok = input.outcome === "needs_review";
  const checks = input.checks ?? [];
  const checkSummary = checkLine(checks);
  const hello = input.firstName ? `${input.firstName}, ` : "";

  const subject = ok
    ? `Ready for you: ${input.title}`
    : `Cortex could not finish: ${input.title}`;

  const facts = keyValueTable(
    [
      { label: "Repository", value: input.repository ?? "" },
      { label: "Linear issue", value: input.issueKey ?? "" },
      { label: "Branch", value: input.branch ?? "" },
      { label: "Checks", value: checkSummary ?? "" },
    ].filter((r) => r.value),
  );

  const stats = statRow(
    [
      { label: "Took", value: input.durationText ?? "" },
      { label: "Cost", value: input.costText ?? "" },
    ].filter((s) => s.value),
  );

  const reason =
    (input.failureReason ?? "").trim() ||
    "Cortex stopped before it finished the work.";

  const build = (budget: number): string => {
    const clamped = clampMarkdown(input.summary ?? "", budget);
    const body = ok
      ? [
          calloutBox({
            tone: "success",
            title: "Waiting on you",
            text: `${hello}Cortex finished this one and opened a pull request. Nothing merges until a person says so.`,
          }),
          stats,
          facts,
          clamped.markdown ? markdownToEmailHtml(clamped.markdown) : "",
          input.prUrl
            ? button({ href: input.prUrl, label: "Review the pull request" })
            : "",
          detailUrl
            ? button({
                href: detailUrl,
                label: "See the whole run in Cortex",
                tone: "quiet",
              })
            : "",
        ]
      : [
          calloutBox({
            tone: "danger",
            title: "What went wrong",
            text: reason,
          }),
          stats,
          facts,
          input.errorDetail
            ? codeBlock(input.errorDetail, { label: "Technical detail" })
            : "",
          detailUrl
            ? button({ href: detailUrl, label: "Open the run in Cortex" })
            : "",
        ];

    return renderEmail({
      title: input.title,
      preheader: ok
        ? `Cortex opened a pull request${input.repository ? ` in ${input.repository}` : ""}. It needs a human review before anything merges.`
        : `${reason.slice(0, 110)}`,
      eyebrow: "Cortex · dev work",
      pillHtml: statusPill({
        label: ok ? "Needs review" : "Failed",
        tone: ok ? "warn" : "danger",
      }),
      bodyHtml: body.filter(Boolean).join(""),
      footerNote: ok
        ? "You get this because you asked Cortex for this change. One message per run — no follow-ups unless something changes."
        : "You get this because you asked Cortex for this change. Nothing was merged.",
    });
  };

  let html = build(MAX_SUMMARY_CHARS);
  if (html.length > MAX_EMAIL_HTML_CHARS) html = build(TIGHT_SUMMARY_CHARS);

  const textSummary = clampMarkdown(input.summary ?? "", MAX_SUMMARY_CHARS);
  const text = [
    ok ? `Ready for you — ${input.title}` : `Could not finish — ${input.title}`,
    "",
    ok
      ? "Cortex finished this one and opened a pull request. Nothing merges until a person says so."
      : reason,
    "",
    input.repository ? `Repository: ${input.repository}` : null,
    input.issueKey
      ? `Linear issue: ${input.issueKey}${input.issueUrl ? ` (${input.issueUrl})` : ""}`
      : null,
    input.branch ? `Branch: ${input.branch}` : null,
    checkSummary ? `Checks: ${checkSummary}` : null,
    input.durationText ? `Took: ${input.durationText}` : null,
    input.costText ? `Cost: ${input.costText}` : null,
    "",
    ok && textSummary.markdown
      ? `What changed:\n\n${textSummary.markdown}`
      : null,
    !ok && input.errorDetail
      ? `Technical detail:\n\n${input.errorDetail}`
      : null,
    "",
    input.prUrl ? `Pull request: ${input.prUrl}` : null,
    detailUrl ? `The whole run: ${detailUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { subject, html, text };
}
