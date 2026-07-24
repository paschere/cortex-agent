# Zippy Evaluation Runbook (non-engineers)

How to run the capability tests from the July 2026 evaluation criteria
yourself. No terminal, no code — everything happens in claude.ai or in the
Zipdev OS web app.

## One-time setup (~2 minutes)

1. Open **https://zippy-zipdev.vercel.app** and sign in with your
   `@zipdev.com` Google account.
2. In **claude.ai** → Settings → Connectors → **Add custom connector**, paste:

   ```
   https://zippy-zipdev.vercel.app/mcp
   ```

3. Approve with the same Google account when the login window opens. Done —
   every Claude chat can now use Zippy's tools (enable the "zipdev" connector
   in the chat's tool menu if it isn't on).

You can also run every test in the **Zipdev OS chat** (same brain, same
tools) at https://zippy-zipdev.vercel.app/chat.

## Running the tests

Type the prompt, wait for the answer, then verify against the ground-truth
source listed in the criteria. Zippy must cite ids/URLs you can click and
check — an answer without sources is a fail even if it sounds right.

### Test 1 — Client roster pull

> List every team member currently assigned to **[client]**. Use the Assigned
> Team Contact Info sheet and show which sheet/range you read.

Verify against the sheet itself. (Zippy reads it with the Google Sheets tool
using your own Google access — if it says it lacks access, connect Google
under Integrations in Zipdev OS.)

### Test 2 — Rate lookup

> What is the bill rate and pay rate for **[team member]**? Cite the exact
> source (sheet cell / payroll record).

Pass requires exact figures. "Approximately" or unsourced numbers = fail.

### Test 3 — Candidate matching

> Search our talent database and return the top 5 candidates for this role,
> with reasoning: **[paste job description]**

Send the list to Avit or Alfred. Reasoning must reference real profile data
(names, assessments, interviews you can open), never invented details.

### Test 4 — Req status synthesis

> Summarize the state of **[active req]**: candidates in each stage, days
> open, and the next action.

Verify counts and stages against Workable directly.

### Test 5 — Job-post signal detection (growth pilot)

> Sweep job boards for new signals: roles "senior fullstack engineer" and
> "senior QA engineer", remote, US companies. Show me what's new.

Zippy stores every signal it finds and never re-counts an old one. Follow up
with "show me this week's signals" any time. Weekly target: 15 qualified
signals confirmed by Mikey.

### Test 6 — Contact identification

> For the signal at **[company]**, who is the likely hiring decision-maker
> and what's the best contact path? Show your evidence.

Zippy returns evidence with source URLs and labels the contact **found**
(seen publicly) or **inferred** (derived from a documented email pattern). A
guess without evidence = fail; "unknown" with honest reasoning = acceptable.

### Test 7 — Outreach drafting

> Draft a cold email to that contact referencing their actual job post, in
> Zipdev's voice.

Zippy drafts; it does **not** send. Sending is confirmation-gated: it shows
you the exact email and waits for an explicit yes (and during the pilot, all
sends are human-approved by policy).

## The audit check (applies to every test)

Everything Zippy touches is recorded. Two places to look:

- **Zipdev OS → Admin → Audit Logs** — one row per tool call: who asked,
  which tool, when, status, latency. This answers "what did it just access."
- **Zipdev OS → Conversations** — Claude sessions appear as conversations
  (surface "mcp") with every tool call and result preserved.

If you can't find a task you just ran in the audit log, that's a finding —
report it.

## If something fails

- "Tool not available / not connected" → check Integrations in Zipdev OS
  (Google, etc.) for your user.
- Web search tests (5–6) need the search key configured
  (`TAVILY_API_KEY`) — an explicit error about it is a setup gap, not a
  model failure.
- Anything else: copy the error text and the time, and check Admin → Audit
  Logs for the failing row.
