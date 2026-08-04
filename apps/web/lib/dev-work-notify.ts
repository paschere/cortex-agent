import "server-only";
import {
  DEV_TASK_COLUMNS,
  type DevTask,
  formatCost,
  formatDuration,
  taskElapsedMs,
  toDevTask,
} from "@/lib/dev-work";
import { sendEmail } from "@/lib/email";
import { renderDevTaskEmail } from "@/lib/email-templates";
import { sendChatDm, toChatText } from "@/lib/google-chat";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { logger } from "@cortex/core";

/**
 * "Cortex did some work on our software" notifications.
 *
 * The point of the whole oversight surface is that nobody has to sit and watch
 * it, so exactly two things are worth interrupting a person for:
 *
 *   needs_review  the run finished and a pull request is waiting on a human
 *   failed        the run could not finish
 *
 * ── HOW THIS AVOIDS BEING NOISE ───────────────────────────────────────────
 *  1. Two events, not seven. Queued, started, branch pushed, checks green —
 *     none of those are told to anyone. They are on the page for whoever looks.
 *  2. A PR opening and the run needing review are the SAME event, so a
 *     successful run produces one message, not one per milestone.
 *  3. Email and Chat are two channels for one message, never two messages —
 *     same content, and Chat only reaches people who have linked it.
 *  4. Delivery is CLAIMED before it is sent: a conditional update on
 *     `dev_tasks.notified_state` means only one caller wins per outcome, so a
 *     retried Inngest step, a webhook redelivery or two racing workers still
 *     produce one message. Re-notification only happens if the outcome itself
 *     changes (failed → needs_review after a retry), which is news.
 *
 * Best-effort by design, like every other notifier here: a mail or Chat failure
 * must never fail the run that triggered it. Nothing throws.
 */

export type DevTaskNotice = "needs_review" | "failed";

/** Chat groups both messages about one run into a single thread. */
const threadKeyFor = (taskId: string) => `dev-task:${taskId}`;

interface Recipient {
  userId: string | null;
  email: string | null;
  firstName: string | null;
}

/**
 * Who hears about it: the person who asked. If the Linear author never mapped
 * to a Cortex account there is nobody to tell personally, so it falls back to
 * the workspace admins — the people accountable for Cortex touching the code.
 */
async function resolveRecipients(
  db: ReturnType<typeof getSupabaseServiceClient>,
  task: DevTask,
): Promise<Recipient[]> {
  if (task.requestedBy) {
    const { data } = await db
      .from("users")
      .select("id, email, name")
      .eq("id", task.requestedBy)
      .maybeSingle();
    if (data?.email) {
      return [
        {
          userId: data.id as string,
          email: data.email as string,
          firstName: data.name
            ? (String(data.name).split(" ")[0] ?? null)
            : null,
        },
      ];
    }
  }

  const { data: admins } = await db
    .from("users")
    .select("id, email, name")
    .eq("role", "org_admin")
    .limit(10);
  return (admins ?? [])
    .filter((a) => a.email)
    .map((a) => ({
      userId: a.id as string,
      email: a.email as string,
      firstName: a.name ? (String(a.name).split(" ")[0] ?? null) : null,
    }));
}

/**
 * Claim the right to notify. Returns false when somebody already sent this
 * exact outcome for this task.
 *
 * `notified_state` is a column the oversight layer needs and the intake agent
 * may not have added yet. If the claim errors we deliver anyway and log it: in
 * that window a duplicate email is a nuisance, a silent failure is the thing
 * the person went on holiday trusting would not happen.
 */
async function claimNotification(
  db: ReturnType<typeof getSupabaseServiceClient>,
  taskId: string,
  notice: DevTaskNotice,
): Promise<boolean> {
  const { data, error } = await db
    .from("dev_tasks")
    .update({ notified_state: notice })
    .eq("id", taskId)
    .or(`notified_state.is.null,notified_state.neq.${notice}`)
    .select("id");

  if (error) {
    logger.warn("dev-work: could not claim the notification, sending anyway", {
      taskId,
      reason: error.message,
    });
    return true;
  }
  return (data ?? []).length > 0;
}

function chatMessage(opts: {
  task: DevTask;
  notice: DevTaskNotice;
  repository: string | null;
  detailUrl: string;
  durationText: string | null;
  costText: string | null;
  checkSummary: string | null;
}): string {
  const { task, notice, repository, detailUrl } = opts;
  const meta = [
    repository ? `Repository: ${repository}` : null,
    task.issueKey ? `Linear issue: ${task.issueKey}` : null,
    opts.checkSummary ? `Checks: ${opts.checkSummary}` : null,
    opts.durationText ? `Took: ${opts.durationText}` : null,
    opts.costText ? `Cost: ${opts.costText}` : null,
  ].filter(Boolean) as string[];

  if (notice === "needs_review") {
    return toChatText(
      [
        `**Ready for you — ${task.title}**`,
        "",
        "I finished this one and opened a pull request. Nothing merges until you say so.",
        "",
        ...meta,
        "",
        task.prUrl ? `[Review the pull request](${task.prUrl})` : "",
        detailUrl ? `[See the whole run](${detailUrl})` : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      detailUrl ? { moreUrl: detailUrl } : undefined,
    );
  }

  return toChatText(
    [
      `**I could not finish — ${task.title}**`,
      "",
      task.failureReason ??
        "I stopped before the work was done. Nothing was merged.",
      "",
      ...meta,
      "",
      detailUrl ? `[See what happened](${detailUrl})` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    detailUrl ? { moreUrl: detailUrl } : undefined,
  );
}

function summariseChecks(task: DevTask): string | null {
  if (task.checks.length === 0) return null;
  const failed = task.checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    return `${failed.length} failed — ${failed.map((c) => c.name).join(", ")}`;
  }
  const pending = task.checks.filter((c) => c.status === "pending").length;
  const passed = task.checks.filter((c) => c.status === "passed").length;
  if (pending > 0)
    return `${passed} of ${task.checks.length} passed, ${pending} still running`;
  return `all ${task.checks.length} passed`;
}

/**
 * Tell the person who asked that their run needs them, or that it failed.
 *
 * Call this ONCE per outcome from wherever the executor finalises a run. Safe
 * to call again — the claim makes repeats no-ops.
 */
export async function notifyDevTaskOutcome(opts: {
  taskId: string;
  notice: DevTaskNotice;
}): Promise<void> {
  try {
    const db = getSupabaseServiceClient();
    const { data: row, error } = await db
      .from("dev_tasks")
      .select(DEV_TASK_COLUMNS)
      .eq("id", opts.taskId)
      .maybeSingle();
    if (error || !row) {
      logger.warn("dev-work: nothing to notify about", {
        taskId: opts.taskId,
        reason: error?.message ?? "task not found",
      });
      return;
    }

    const task = toDevTask(row as unknown as Record<string, unknown>);
    if (!(await claimNotification(db, opts.taskId, opts.notice))) return;

    let repository: string | null = null;
    if (task.repositoryId) {
      const { data: repo } = await db
        .from("dev_repositories")
        .select("name, full_name")
        .eq("id", task.repositoryId)
        .maybeSingle();
      repository =
        ((repo?.full_name as string | null) ??
          (repo?.name as string | null) ??
          null) ||
        null;
    }

    const base = (
      process.env.APP_BASE_URL ??
      process.env.BETTER_AUTH_URL ??
      ""
    ).replace(/\/+$/, "");
    const detailUrl = base ? `${base}/dev-work/${task.id}` : "";
    const durationText = formatDuration(taskElapsedMs(task));
    const costText = formatCost(task.costUsd);
    const checkSummary = summariseChecks(task);

    const recipients = await resolveRecipients(db, task);
    if (recipients.length === 0) {
      logger.warn("dev-work: no one to notify", { taskId: task.id });
      return;
    }

    for (const person of recipients) {
      const mail = renderDevTaskEmail({
        taskId: task.id,
        title: task.title,
        outcome: opts.notice,
        repository,
        issueKey: task.issueKey,
        issueUrl: task.issueUrl,
        branch: task.branch,
        prUrl: task.prUrl,
        summary: task.summary,
        failureReason: task.failureReason,
        errorDetail: task.errorDetail,
        checks: task.checks.map((c) => ({ name: c.name, status: c.status })),
        durationText: durationText === "—" ? null : durationText,
        costText,
        firstName: person.firstName,
      });

      if (person.email) {
        const sent = await sendEmail({
          to: person.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        if (!sent.sent) {
          logger.warn("dev-work: result email not sent", {
            taskId: task.id,
            reason: sent.reason,
          });
        }
      }

      // Second channel for the same message, never a second message. A no-op
      // for anyone who has not linked Google Chat.
      if (person.userId) {
        const chat = await sendChatDm({
          userId: person.userId,
          text: chatMessage({
            task,
            notice: opts.notice,
            repository,
            detailUrl,
            durationText: durationText === "—" ? null : durationText,
            costText,
            checkSummary,
          }),
          threadKey: threadKeyFor(task.id),
        });
        if (!chat.sent && chat.reason !== "not linked") {
          logger.warn("dev-work: result Chat DM not sent", {
            taskId: task.id,
            reason: chat.reason,
          });
        }
      }
    }
  } catch (err) {
    logger.error("dev-work: notification failed", {
      taskId: opts.taskId,
      error: (err as Error).message,
    });
  }
}
