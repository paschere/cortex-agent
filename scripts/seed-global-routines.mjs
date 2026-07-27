#!/usr/bin/env node
/**
 * Seed the four GLOBAL monitoring routines (Zippy's standing watch).
 *
 * Each routine is two rows:
 *   1. a `pipelines` row — the reusable playbook a human can also run by hand
 *      from /pipelines, with structured steps that name the real tool ids;
 *   2. a `scheduled_jobs` row (kind='agent', is_global=true) — the weekly cron
 *      that makes Zippy run that playbook unattended and mail the written
 *      report to the recipients.
 *
 * These routines only READ and REPORT: no checkpoints, no external writes,
 * allow_unattended_writes=false. If a finding needs action, a human takes it.
 *
 * Usage:
 *   node scripts/seed-global-routines.mjs [--dry-run] [postgres://...]
 *
 * Connection string: first non-flag argument, else $SUPABASE_DB_URL.
 *
 * Idempotent: pipelines are matched by slug, scheduled_jobs by name. Re-running
 * updates the existing rows in place and never duplicates. Safe to run on every
 * deploy.
 */
// This script lives outside any workspace package, so bare ESM imports don't
// resolve — pull `pg` from the web app's dependencies (same trick as
// scripts/reembed-kb.mjs).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const rawUrl = args.find((a) => !a.startsWith('--')) ?? process.env.SUPABASE_DB_URL;

if (!rawUrl) {
  console.error(
    'Missing connection string. Pass it as an argument or set SUPABASE_DB_URL.\n' +
      '  node scripts/seed-global-routines.mjs [--dry-run] postgres://...',
  );
  process.exit(1);
}

// pg-connection-string treats sslmode=require as verify-full and its parsed ssl
// config wins over the explicit `ssl` option — so strip sslmode from the URL and
// pass the ssl object ourselves. Supabase's pooler presents a cert signed by
// Supabase's own CA, which Node doesn't trust out of the box. Disabling
// verification is scoped to this one connection (never NODE_TLS_REJECT_UNAUTHORIZED).
// Same pattern as apps/web/lib/auth.ts.
const connectionString = rawUrl
  .replace(/[?&]sslmode=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''))
  .replace(/\?&/, '?')
  .replace(/\?$/, '');

const TIMEZONE = 'America/Bogota';
const RECIPIENTS = ['mateo.angel@zipdev.com', 'linda.rans@zipdev.com'];

// ---------------------------------------------------------------------------
// Cron helper — next occurrence of a weekly "M H * * DOW" expression.
// Deliberately narrow: these four crons are all "one weekday, one time", so a
// day-by-day scan over the next 8 local days is exact and needs no cron lib.
// ---------------------------------------------------------------------------

/** Offset of `tz` from UTC, in ms, at the given instant (positive = ahead). */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in `tz` to the matching UTC instant. */
function zonedTimeToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  // Two passes converge for every real-world zone (offset is stable near the
  // target instant; America/Bogota has no DST at all).
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** Local (tz) calendar fields for an instant. */
function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    dow: dows[get('weekday')],
  };
}

/** Next firing instant of "M H * * DOW" in `tz`, strictly after `from`. */
function nextCronRun(cron, tz, from = new Date()) {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (dom !== '*' || month !== '*' || !/^\d+$/.test(dow)) {
    throw new Error(`Unsupported cron for this seeder (expected "M H * * DOW"): ${cron}`);
  }
  const targetDow = Number(dow);
  const h = Number(hour);
  const mi = Number(minute);
  for (let i = 0; i <= 8; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const p = zonedParts(probe, tz);
    if (p.dow !== targetDow) continue;
    const candidate = zonedTimeToUtc(p.year, p.month, p.day, h, mi, tz);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new Error(`Could not compute next run for cron: ${cron}`);
}

// ---------------------------------------------------------------------------
// The four routines.
// Every tool id below was verified against packages/agent-tools/src/**.
// ---------------------------------------------------------------------------

const REPORT_RULE =
  'The result must be a written report for humans: concise, business language, ' +
  'numbers first, no tool names, no ids, no technical jargon. Lead with the answer. ' +
  'If there is nothing worth flagging, say so in one line instead of padding the report.';

const ROUTINES = [
  {
    pipeline: {
      slug: 'payroll-consistency-check',
      name: 'Payroll Consistency Check',
      emoji: '💰',
      description:
        'Compares the latest payroll period against the previous ones and flags anomalies in cost, headcount, individual pay and currency mix.',
      intro:
        'A read-only audit of the most recent payroll period. The goal is not to reproduce the payroll — it is to catch the handful of things that do not match the pattern of the previous periods, so a human can check them before anyone else notices. Everything here is internal compensation data: keep it inside the report, never quote it outside Zipdev.',
      steps: [
        {
          title: 'Pull the payroll trend',
          detail:
            'Get the aggregate payroll numbers for the latest closed period and at least the three periods before it: total gross cost, headcount paid, average cost per person, and the split by currency. Write down the exact figures — every later step compares against them.',
          tools: ['payroll.payroll_stats'],
          checkpoint: false,
        },
        {
          title: 'Compare period over period',
          detail:
            'Compute the change from the previous period for total gross cost, headcount, and average cost per person, in both absolute and percentage terms. Treat a move above 5% in total cost, or any headcount change, as something that needs an explanation. Also compare the currency mix: a shift in the share paid in a given currency can hide an FX effect rather than a real cost increase.',
          tools: ['payroll.payroll_stats'],
          checkpoint: false,
        },
        {
          title: 'Reconcile against active assignments',
          detail:
            'List the current team assignments and check that the people being paid match the people assigned to clients: anyone paid without an active assignment, anyone assigned but missing from payroll, and any assignment whose rate does not line up with what was paid. Note who joined and who left versus the previous period.',
          tools: ['payroll.team_assignments'],
          checkpoint: false,
        },
        {
          title: 'Drill into the outliers',
          detail:
            'For each person whose pay moved materially versus their own recent history — or who appears or disappears unexpectedly — open their profile and look for the explanation: a rate change, a partial month, a bonus, a new assignment, a termination. Keep the list short: the five clearest outliers are enough. Anything you can explain from the data is NOT an anomaly and should not be flagged.',
          tools: ['payroll.employee_profile'],
          checkpoint: false,
        },
        {
          title: 'Write the report',
          detail:
            'Audience: non-technical leadership. Open with the verdict in one line ("Payroll for <period> is consistent" or "3 items need review"). Then: what changed versus the prior period, with the numbers (total cost, headcount, average, currency mix). Then the flagged items only — one line each: who or what, the amount, the change, and the most likely explanation. Do not list anything you were able to explain. If the period is clean, state explicitly that nothing anomalous was found, and still give the headline numbers so the trend is on record.',
          tools: [],
          checkpoint: false,
        },
      ],
    },
    job: {
      name: 'Weekly Payroll Consistency Check',
      cron: '0 8 * * 1',
      instructionExtra:
        'Compensation figures are internal: the report goes only to the recipients of this routine. ' +
        'Flag only what you could not explain from the data, and say "nothing anomalous" plainly when the period is clean.',
    },
  },
  {
    pipeline: {
      slug: 'workable-activity-check',
      name: 'Workable Activity Check',
      emoji: '📋',
      description:
        'Finds recruiting pipelines that went quiet: open jobs with no candidate movement, stages piling up, and reqs open a long time with too few candidates.',
      intro:
        'A weekly health check on the recruiting pipeline. Open roles fail quietly — nobody reports a job that simply stopped moving. This routine finds those before the client does.',
      steps: [
        {
          title: 'List the open roles',
          detail:
            'Pull every job that is currently open or published, with its title, client, and how long it has been open. This is the universe for the rest of the check.',
          tools: ['workable.list_jobs'],
          checkpoint: false,
        },
        {
          title: 'Read the funnel per role',
          detail:
            'For each open job, get the candidate counts by stage. Note the total in the pipeline, how many are in the late stages (interview, offer), and where the largest cluster sits. A role with candidates piled in one early stage is stalled even if the totals look healthy.',
          tools: ['workable.job_candidates_summary'],
          checkpoint: false,
        },
        {
          title: 'Check for movement',
          detail:
            'Review the recent activity across candidates over the last 14 days and map it back to the jobs. Identify: (a) jobs with zero candidate movement in 14 days, (b) stages where candidates have been sitting without progressing, (c) jobs open more than 30 days with fewer than 10 candidates in the pipeline.',
          tools: ['workable.list_recent_activity'],
          checkpoint: false,
        },
        {
          title: 'Rank what needs attention',
          detail:
            'Order the problem roles by business impact, not by how long they have been quiet: client-facing and revenue-generating roles first, then the rest. For each, state the single most likely cause visible in the data — no candidates arriving, candidates arriving but not being screened, or candidates stuck late in the funnel — since each needs a different fix.',
          tools: ['workable.list_jobs', 'workable.job_candidates_summary'],
          checkpoint: false,
        },
        {
          title: 'Write the report',
          detail:
            'Audience: non-technical leadership. Open with the count: how many roles are open and how many of those are stalled. Then one line per stalled role: role, client, days open, candidates in pipeline, days since the last movement, and where it is stuck. Close with the two or three roles that most need a decision this week. If every pipeline is moving, say so in one line and give the headline numbers.',
          tools: [],
          checkpoint: false,
        },
      ],
    },
    job: {
      name: 'Weekly Recruiting Pipeline Activity Check',
      cron: '0 9 * * 1',
      instructionExtra:
        'Focus on roles that stopped moving, not on a full pipeline dump. ' +
        'If every open role showed movement, report that in one line with the headline numbers.',
    },
  },
  {
    pipeline: {
      slug: 'expense-anomaly-check',
      name: 'Expense Anomaly Check',
      emoji: '🧾',
      description:
        'Flags unusually high or unexplained expenses by person and category, against their own recent history and against peers, for human review.',
      intro:
        'A review aid, not a verdict. This routine surfaces expenses that stand out statistically so that a human can ask for the justification. An outlier is not wrongdoing — travel, equipment purchases, reimbursed client costs and one-off approvals all look like anomalies from the data alone. Compensation and expense data stays internal to the recipients of this report.',
      steps: [
        {
          title: 'Pull the expense history',
          detail:
            'Get the expenses for the most recent closed period and for the three periods before it, broken down by person and by category. Keep the raw amounts and dates — the report needs them.',
          tools: ['payroll.expenses_report'],
          checkpoint: false,
        },
        {
          title: 'Compare each person against themselves',
          detail:
            'For every person with expenses this period, compare the total and the per-category amounts to their own average over the prior periods. Flag anything materially above their own baseline (roughly double, or a large absolute jump), and flag brand-new categories they have never expensed before.',
          tools: ['payroll.expenses_report'],
          checkpoint: false,
        },
        {
          title: 'Compare against peers',
          detail:
            'Within each category, compare this period across people: who is well above the group norm, and are there categories where the whole company jumped (which points at a policy or vendor change rather than an individual). A company-wide jump is context for the report, not a per-person flag.',
          tools: ['payroll.expenses_report'],
          checkpoint: false,
        },
        {
          title: 'Add context to the top outliers',
          detail:
            'For the top outliers only, open the person profile to see role, client assignment and start date — a new hire buying equipment, or someone on a travel-heavy account, explains most of what looks unusual. Drop anything the context explains; keep what it does not.',
          tools: ['payroll.employee_profile'],
          checkpoint: false,
        },
        {
          title: 'Write the report',
          detail:
            'Audience: non-technical leadership. Open with the total expensed this period and how it compares to the prior period. Then list the top outliers — at most eight — one line each: person, category, amount, date, and how it compares to their own baseline or to peers. State plainly that these are items for a human to verify, not findings of wrongdoing, and that a justification may already exist. If nothing stands out, say so in one line and report the totals.',
          tools: [],
          checkpoint: false,
        },
      ],
    },
    job: {
      name: 'Weekly Expense Anomaly Check',
      cron: '0 16 * * 5',
      instructionExtra:
        'This report flags items for human review — it never accuses anyone. Word every finding as ' +
        '"worth verifying", never as misuse, and note that a legitimate justification may already exist. ' +
        'Compensation and expense data is internal: it goes only to the recipients of this routine.',
    },
  },
  {
    pipeline: {
      slug: 'growth-stats-report',
      name: 'Growth Stats Report',
      emoji: '📈',
      description:
        'Weekly growth snapshot: new job-post signals found, how many were qualified, rejected or contacted, the week-over-week trend, and the best opportunities to act on.',
      intro:
        'The weekly read on top-of-funnel growth: what the market gave us, what we did with it, and what is worth chasing next week. The point is the trend and the shortlist, not a catalogue of every signal.',
      steps: [
        {
          title: 'Count this week',
          detail:
            'List the signals captured over the last 7 days and break them down by status: new, qualified, rejected, contacted. Record the totals — these are the headline numbers of the report.',
          tools: ['growth.list_signals'],
          checkpoint: false,
        },
        {
          title: 'Compare against last week',
          detail:
            'Pull the same breakdown for the previous 7 days and compute the week-over-week change for each status, plus the qualification rate (qualified over total found) and the contact rate (contacted over qualified). Two consecutive down weeks in signals found, or a falling contact rate, is the thing worth saying out loud.',
          tools: ['growth.list_signals'],
          checkpoint: false,
        },
        {
          title: 'Sweep for fresh signals',
          detail:
            'Run a sweep for new job-post signals so the report reflects the market as of today, not only what was already captured. Note how many are genuinely new versus already known, and which companies or roles are showing up repeatedly.',
          tools: ['growth.find_signals'],
          checkpoint: false,
        },
        {
          title: 'Cross-check the commercial pipeline',
          detail:
            'Pull the sales pipeline summary — deals by stage and value — and set the growth numbers against it: is the top of the funnel feeding the deals in flight, or is the pipeline living off older opportunities? Flag any signal that matches a company already in the pipeline, since that is a warm path rather than a cold one.',
          tools: ['hubspot.get_pipeline_summary'],
          checkpoint: false,
        },
        {
          title: 'Pick the opportunities to act on',
          detail:
            'Choose the five best opportunities for next week from the qualified and uncontacted signals. Rank by fit with what Zipdev sells and by how fresh the signal is. For each, one line: company, role, why it fits, and the obvious next move.',
          tools: ['growth.list_signals'],
          checkpoint: false,
        },
        {
          title: 'Write the report',
          detail:
            'Audience: non-technical leadership. Open with the week in one line: signals found, qualified, contacted, and the direction versus last week. Then the numbers table in prose: found, qualified, rejected, contacted, with the week-over-week change for each. Then the top five opportunities with the suggested next move. Close with one line on what the trend means. If the week was flat, say so plainly rather than dressing it up.',
          tools: [],
          checkpoint: false,
        },
      ],
    },
    job: {
      name: 'Weekly Growth Stats Report',
      cron: '30 7 * * 1',
      instructionExtra:
        'Lead with the week-over-week numbers and end with the five opportunities worth acting on. ' +
        'If the week was flat or down, say it plainly.',
    },
  },
];

function buildInstruction(routine) {
  return (
    `Run the "${routine.pipeline.slug}" pipeline. ` +
    `${REPORT_RULE} ${routine.job.instructionExtra}`
  );
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  // Owner: the org admin runs these; every tool call must stay attributable.
  const ownerRes = await client.query(
    `select id, email, role from public.users
      order by (role = 'org_admin') desc, created_at asc
      limit 1`,
  );
  if (ownerRes.rows.length === 0) throw new Error('No users found — cannot own the routines.');
  const owner = ownerRes.rows[0];

  const agentRes = await client.query(`select id, name from public.agents where slug = 'zippy' limit 1`);
  if (agentRes.rows.length === 0) throw new Error("No agent with slug 'zippy' — cannot schedule.");
  const agent = agentRes.rows[0];

  console.log(`Owner : ${owner.email} (${owner.role})`);
  console.log(`Agent : ${agent.name}`);
  console.log(`TZ    : ${TIMEZONE}`);
  console.log(`Mode  : ${DRY_RUN ? 'DRY RUN — no writes' : 'WRITING'}\n`);

  const summary = [];

  for (const routine of ROUTINES) {
    const p = routine.pipeline;
    const instruction = buildInstruction(routine);
    const nextRun = nextCronRun(routine.job.cron, TIMEZONE);

    if (DRY_RUN) {
      console.log(`── ${p.emoji}  ${p.name} (${p.slug})`);
      console.log(`   pipeline : ${p.steps.length} steps, tools: ${[
        ...new Set(p.steps.flatMap((s) => s.tools)),
      ].join(', ')}`);
      console.log(`   job      : "${routine.job.name}"  cron="${routine.job.cron}"  next=${nextRun.toISOString()}`);
      console.log(`   recipients: ${RECIPIENTS.join(', ')}`);
      console.log(`   instruction: ${instruction}\n`);
      summary.push({ slug: p.slug, job: routine.job.name, cron: routine.job.cron, next: nextRun });
      continue;
    }

    // (a) The playbook. `instruction` is the legacy NOT NULL column, superseded
    // by `steps` — kept empty on purpose.
    const pipeRes = await client.query(
      `insert into public.pipelines
         (slug, name, description, emoji, intro, steps, params, instruction, archived, created_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, '', false, $7)
       on conflict (slug) do update set
         name        = excluded.name,
         description = excluded.description,
         emoji       = excluded.emoji,
         intro       = excluded.intro,
         steps       = excluded.steps,
         params      = excluded.params,
         archived    = false,
         updated_at  = now()
       returning id, (xmax = 0) as inserted`,
      [p.slug, p.name, p.description, p.emoji, p.intro, JSON.stringify(p.steps), owner.id],
    );
    const pipeAction = pipeRes.rows[0].inserted ? 'created' : 'updated';

    // (b) The cron. No unique constraint on name, so match by name explicitly.
    const existing = await client.query(
      `select id from public.scheduled_jobs where name = $1 limit 1`,
      [routine.job.name],
    );

    let jobAction;
    if (existing.rows.length > 0) {
      await client.query(
        `update public.scheduled_jobs set
           user_id = $2, agent_id = $3, kind = 'agent', tool_id = null, tool_input = null,
           instruction = $4, schedule_kind = 'cron', cron = $5, timezone = $6,
           run_at = null, next_run_at = $7, status = 'active',
           allow_unattended_writes = false, notify_conversation = true, notify_email = true,
           is_global = true, recipients = $8::text[], updated_at = now()
         where id = $1`,
        [
          existing.rows[0].id,
          owner.id,
          agent.id,
          instruction,
          routine.job.cron,
          TIMEZONE,
          nextRun.toISOString(),
          RECIPIENTS,
        ],
      );
      jobAction = 'updated';
    } else {
      await client.query(
        `insert into public.scheduled_jobs
           (user_id, agent_id, name, kind, instruction, schedule_kind, cron, timezone,
            next_run_at, status, allow_unattended_writes, notify_conversation, notify_email,
            is_global, recipients)
         values ($1, $2, $3, 'agent', $4, 'cron', $5, $6, $7, 'active', false, true, true, true, $8::text[])`,
        [
          owner.id,
          agent.id,
          routine.job.name,
          instruction,
          routine.job.cron,
          TIMEZONE,
          nextRun.toISOString(),
          RECIPIENTS,
        ],
      );
      jobAction = 'created';
    }

    console.log(`${p.emoji}  ${p.slug}: pipeline ${pipeAction}, job ${jobAction}`);
    summary.push({ slug: p.slug, job: routine.job.name, cron: routine.job.cron, next: nextRun });
  }

  // Summary table.
  const fmt = (d) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: false,
    }).format(d);
  const w = (s, n) => String(s).padEnd(n);
  console.log(`\n${w('PIPELINE SLUG', 28)}${w('JOB NAME', 42)}${w('CRON', 14)}NEXT RUN (${TIMEZONE})`);
  console.log('-'.repeat(120));
  for (const r of summary) {
    console.log(`${w(r.slug, 28)}${w(r.job, 42)}${w(r.cron, 14)}${fmt(r.next)}`);
  }
  console.log(
    `\n${summary.length} routines ${DRY_RUN ? 'would be seeded (dry run — nothing written)' : 'seeded'}.`,
  );
} finally {
  await client.end();
}
