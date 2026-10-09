import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE ALLOWLIST, AND WHY IT IS A TEST RATHER THAN A COMMENT.
 *
 * `getSupabaseServiceClient()` returns a handle that sees every workspace in
 * the install. There are eighteen places that legitimately need one and no
 * nineteenth that is obvious from the outside — a raw client and a scoped one
 * are the same type, read the same at the call site, and differ only in whether
 * the query comes back with one company's rows or everybody's.
 *
 * So the list below is not documentation of what the code does; it is the
 * decision about what the code may do, and this test is what makes the decision
 * bind. Adding a file means adding a line here with a reason, in a diff a
 * reviewer will actually see, instead of the reason living in somebody's head
 * for the ten minutes it takes to merge.
 *
 * Every entry states the shape it belongs to — see the note at the top of
 * lib/supabase/service.ts — and if you cannot write one, that is the answer.
 */
const ALLOWED = new Map<string, string>([
  [
    'inngest/functions/activation-followup.ts',
    'Cron scans only due automation IDs and organization IDs; each execution then uses a tenant-scoped client and an actor-authorized database claim.',
  ],
  [
    'inngest/functions/activation-followup.test.ts',
    'Test-only mock of the raw cron dispatcher client; production execution remains covered by the adjacent allowlisted worker and tenant-scoped claim.',
  ],
  [
    'lib/supabase/service.ts',
    'Defines both clients. The scoped one is built by wrapping the raw one.',
  ],
  [
    'lib/oauth.ts',
    'The MCP OAuth handshake. Clients, codes and tokens are keyed by hash and issued before any workspace is in hand; the workspace comes from the user the token resolves to.',
  ],
  [
    'lib/dev-tasks/repository.ts',
    'A Linear webhook carries no workspace. The repository the issue names IS the workspace, so the allowlist read cannot already be scoped to the answer it is looking for.',
  ],
  [
    'lib/dev-tasks/linear-comment.ts',
    'Only to ask whether exactly one workspace has Linear connected, for the rejection path where no repository — and therefore no workspace — could be resolved.',
  ],
  [
    'lib/dev-work-notify.ts',
    'Type-only: the shared helpers below it are typed against the client this function returns.',
  ],
  [
    'app/api/chat-app/google/route.ts',
    'Google Chat webhook. The sender is a Google identity; resolving it to a Cortex directory row is what determines the workspace.',
  ],
  [
    'app/api/files/presentation/[token]/route.ts',
    'A public download link. The row is found by an unguessable token and there is no session to scope by.',
  ],
  [
    'app/api/files/report/[token]/route.ts',
    'The same posture as the presentation link, on purpose: a shared report is opened from WhatsApp or Outlook where no Cortex cookie exists, so the token is the credential. The row it finds carries its own workspace; nothing widens from there.',
  ],
  [
    'lib/board/public.ts',
    'A partners report link (/informe/<token>, migration 0191) is opened by partners or board members with no Cortex account, so the token is the credential — the same posture as a shared view. It is used for exactly two reads: the report row by token and its workspace name. The PDF, the logo and the password attempt go through getOrgScopedClient(report.organization_id).',
  ],
  [
    'lib/compliance/public.ts',
    'The public PQRS form (/pqrs/<token>, migration 0195) is opened by a customer with no Cortex account, so the token is the credential — the same posture as a quote link. It is used for exactly two reads: the compliance profile by token (only when the form is enabled) and its workspace name. The PQRS is filed through getOrgScopedClient(profile.organization_id).',
  ],
  [
    'lib/sales/public.ts',
    'A quote link (/cotizacion/<token>, migration 0182) is opened by the client, who has no Cortex account, so the token is the credential — the same posture as a shared view. It is used for exactly two reads: the quote row by token and its workspace name. The lines, the brand, the logo and the acceptance are read and written through getOrgScopedClient(row.organization_id).',
  ],
  [
    'lib/crm/public.ts',
    'A satisfaction survey link (/encuesta/<token>, migration 0193) is opened by the client, who has no Cortex account, so the token is the credential — the same posture as a quote link. It is used for exactly two reads: the survey row by token and its workspace name. Recording the answer, the follow-up task and the notice go through getOrgScopedClient(row.organization_id).',
  ],
  [
    'lib/support/operator-store.ts',
    'The platform support inbox (migration 0190): the people who operate Cortex read every company’s tickets on purpose. Every exported function starts with requireSupportOperator() — platform admin (ba_user.role) or SUPPORT_OPERATORS — so a server action called on its own cannot skip the gate, and a reply is stamped with the organization of the ticket it answers, never another.',
  ],
  [
    'lib/apps/external-session.ts',
    'The entrance of an application for external users (/a/<app>, migration 0209) has no session, so the company is not known yet. The raw client is used for exactly one read: the PUBLISHED app by its id (findPublishedApp). Everything after — users, sessions, roles, rows — is read through getOrgScopedClient(app.organization_id), the only workspace that session can ever open.',
  ],
  [
    'lib/views/public.ts',
    'A shared view (/v/<token>) is opened by people with no Cortex account, so the token is the credential — the same posture as the report link. It is used for exactly two reads: the view row by token and its workspace name. Every row the view then shows is read through getOrgScopedClient(view.organization_id).',
  ],
  [
    'inngest/functions/legal-data.ts',
    'Cron (0188). "Which data exports expired" and "which company deletions finished their 30-day grace" span the install and there is no session behind a cron; the raw handle runs two SELECTs of ids and nothing else. Each id rides on its own call or event, and the export and the purge name the organization in every statement (lib/legal/export-run.ts, lib/legal/purge-run.ts).',
  ],
  [
    'inngest/functions/turn-context-purge.ts',
    'Retention sweep over captured turn contexts. It redacts and deletes by date across every workspace, which is the point — a per-tenant sweep would need a tenant to run it, and the rows nobody is looking at are exactly the ones that must still expire.',
  ],
  [
    'app/api/mcp/route.ts',
    'Bearer-token surface. The token lookup determines the workspace; everything after it is scoped.',
  ],
  [
    'app/api/webhooks/linear/route.ts',
    'Signature-authenticated webhook with no session. Writes the delivery ledger row before the delivery can be attributed to anything.',
  ],
  [
    'inngest/functions/learning-pass.ts',
    'Cron. The dispatcher asks "which workspaces asked anything yesterday", which spans the install; it selects organization_id off turn_contexts and nothing else. Every event then carries one workspace, and runLearningPass takes a single scoped handle and no list of workspaces — so the one module that generalises from usage is structurally unable to generalise across customers.',
  ],
  [
    'inngest/functions/schedule-dispatch.ts',
    'Cron. "Every routine due this minute" spans the install; each event then carries the workspace of the job it names.',
  ],
  [
    'inngest/functions/commitments-watch.ts',
    'Cron. "Which workspaces have deadlines to watch" spans the install; each event then carries one workspace, and every handle inside the per-workspace function is built from it.',
  ],
  [
    'inngest/functions/management-follow-up.ts',
    'Cron. "Which workspaces have open management cases" spans the install; each event then carries one workspace and every read and notice in the per-workspace job uses a handle pinned to it.',
  ],
  [
    'inngest/functions/table-sync.ts',
    'Cron. "Which table syncs are due" spans the install; each sync then runs on its own event with a handle pinned to its workspace, under the identity of the source owner who created it.',
  ],
  [
    'inngest/functions/app-automations.ts',
    'Cron. "Which app automations have a schedule or row poll that is due" and "which runs are queued" span the install; the raw handle reads (id, organization_id, app_id, trigger, conditions, schedule_last_slot) of enabled schedule and rows_poll rules and (id, organization_id) of queued runs, and resets runs stuck in "running". Each schedule slot is then claimed and each run executed with a handle pinned to its own workspace; app users are only ever looked up by the rule\'s app_id.',
  ],
  [
    'inngest/functions/app-location.ts',
    'Cron. "Which apps exist and how many days of location trail each one keeps" spans the install; the raw handle selects (id, organization_id, location) and nothing else. The deletion of expired trail and the closing of forgotten shifts then run per app with a handle pinned to its own workspace.',
  ],
  [
    'inngest/functions/view-digest.ts',
    'Cron. "Which views have a periodic digest" spans the install; the raw handle selects (id, organization_id, spec->digest, digest_last_sent_at) and nothing else. Each view then runs on its own event with a handle pinned to its workspace, reads no personal or Feed source (no viewerId) and mails only people still in that workspace directory.',
  ],
  [
    'inngest/functions/drive-table.ts',
    'Cron. "Which Drive folders feeding a table are due" spans the install; the raw handle selects (id, organization_id) and nothing else. Each folder then runs on its own event with a handle pinned to its workspace, reading Drive with the credentials of the person who connected it.',
  ],
  [
    'inngest/functions/accounting-sync.ts',
    'Cron. "Which accounting-program connections (Siigo…) are due" spans the install; the raw handle selects (id, organization_id) and nothing else. Each connection then runs on its own event with a handle pinned to its workspace, and its encrypted key is only decrypted through that scoped handle.',
  ],
  [
    'inngest/functions/receivables-watch.ts',
    'Cron. "Which workspaces have receivable invoices" spans the install; each event then carries one workspace and every handle in the per-workspace job is built from it. The only other unscoped read is that workspace\'s own name for the email header.',
  ],
  [
    'inngest/functions/management-workflow.ts',
    'Cron discovers due workflow IDs across companies; each execution uses a handle pinned to the organization on the event.',
  ],
  [
    'inngest/functions/autopilot.ts',
    'Cron. "Which workspaces have the autopilot on at this Bogotá hour" spans the install; the raw handle selects organization_id off autopilot_settings and nothing else. Each id rides on its own event and the run builds every handle (settings, snapshot, items, runTool context, notify) pinned to it.',
  ],
  [
    'inngest/functions/briefing.ts',
    'Cron. "Which workspaces have an agent" spans the install; the raw handle selects organization_id off agents and nothing else. Each id rides on its own event and the per-workspace job builds every handle (reads, notify, push, directory) pinned to it.',
  ],
  [
    'inngest/functions/clients-link.ts',
    'Cron. "Which workspaces have clients or an accounting connection" spans the install; the raw handle selects organization_id and nothing else. Each id rides on its own event and linkClientRecords runs with a handle pinned to it.',
  ],
  [
    'inngest/functions/follow-through.ts',
    'Cron. "Which workspaces have open work, proposed drafts or recent recommendations" spans the install; the raw handle selects organization_id and nothing else. Each id rides on its own event and every read, claim, notice and recommendation in the per-workspace job uses a handle pinned to it.',
  ],
  [
    'inngest/functions/work-sync.ts',
    'Cron. "Which workspaces have work to read" (management cases, commitments, proposed actions, recent approvals, a work_settings row) spans the install; the raw handle selects organization_id and nothing else. Each id rides on its own event and syncWork runs with a handle pinned to it; the reassignment notice is built from a scoped handle too.',
  ],
  [
    'inngest/functions/goals-watch.ts',
    'Cron. "Which workspaces have an active goal" spans the install and there is no session behind a cron; the dispatcher selects organization_id off goals and nothing else. Every id rides on its own event, and the per-workspace function builds every handle from it — so one company\'s readings can only ever be computed from that company\'s rows.',
  ],
  [
    'inngest/functions/weekly-report.ts',
    'Cron. "Which workspaces have somebody who answers for them" spans the install, and behind a cron there is no session to scope by; the dispatcher selects organization_id off users and nothing else. Each event then carries one workspace and runWeeklyReport takes a single scoped handle, so the parte of one company is structurally unable to read another\'s rows.',
  ],
  [
    'inngest/functions/actions-sweep.ts',
    'Cron. "Which workspaces have something to propose, or something sent that is still waiting on an answer" spans the install; the raw handle runs two SELECTs of organization_id and nothing else, and every event then carries one workspace that the per-workspace function builds every handle from.',
  ],
  [
    'inngest/functions/drive-sync.ts',
    'Cron. Scans every synced folder; each sync-state row names its workspace and the per-collection step is scoped to it.',
  ],
  [
    'inngest/functions/meeting-import.ts',
    'Cron. Scans every Google connection in the install; the per-user sweep is scoped to the workspace that granted it.',
  ],
  [
    'inngest/functions/gmail-learn.ts',
    'Cron. "Qué buzones de Gmail hay conectados" abarca todo el install y no hay sesión detrás de un cron; el handle crudo hace un SELECT de (user_id, organization_id) y todo lo demás corre con un handle clavado al espacio que nombra cada fila.',
  ],
  [
    'inngest/functions/memory-derive.ts',
    "Cron. Scans yesterday's activity across the install; the workspace rides on the per-person event.",
  ],
  [
    'inngest/functions/orchestrator-sweep.ts',
    'Cron. "Which orchestrator runs anywhere in the install have gone quiet" spans every workspace and there is no session behind a cron; the raw handle runs one SELECT and every write goes through a handle pinned to the run\'s own workspace.',
  ],
  [
    'inngest/functions/reindex-embeddings.ts',
    'Install-wide maintenance. Fills in missing vectors by row id and returns nothing to any caller; it is also the only reader of kb_chunks with no document in hand.',
  ],
  [
    'inngest/functions/ingest-document.ts',
    'One lookup of the document by primary key to learn its workspace, because ingestion is triggered from four different places and none of them should have to remember to pass it.',
  ],
  [
    'inngest/functions/dev-task-status.ts',
    'One lookup of the task by primary key to learn its workspace: the executor reports by task id from a sandbox that never saw one.',
  ],
  [
    'inngest/functions/dev-task-intake.ts',
    'Settles the webhook delivery ledger row, which was written before the delivery had a workspace, and stamps it once the intake resolved one.',
  ],
  [
    'app/api/whatsapp/bridge/dm/route.ts',
    'A WhatsApp direct message carries a phone number and nothing else. Resolving it to a Cortex directory row is what determines the workspace, and the result is checked against the one the bridge claims before anything runs.',
  ],
  [
    'app/api/whatsapp/bridge/group-mention/route.ts',
    'Same as the direct-message route: a mention in a group carries a phone number, and resolving it to a Cortex directory row is what determines the workspace. The result is checked against the workspace the bridge claims before any tool is offered.',
  ],
  [
    'inngest/functions/errand-sweep.ts',
    'Cron. "Which errands anywhere in the install need a look, and which monitors are due" spans every workspace and there is no session behind a cron; the raw handle runs two SELECTs and every write goes through a handle pinned to the errand\'s own workspace.',
  ],
  [
    'app/api/admin/storage-migrate/route.ts',
    'El puente de mudanza de Supabase Storage a app_files (0109), y el único sitio donde .storage sobrevive. Storage no sabe de espacios, así que listar los buckets exige el cliente crudo; cada archivo copiado lleva el organization_id resuelto del dato que ya lo conocía, y la ruta muere con Supabase.',
  ],
  [
    'app/api/whatsapp/links/route.ts',
    'whatsapp_links is keyed by the phone number install-wide, so "already linked somewhere else" is invisible to a scoped read and would surface as a constraint error instead of an explanation. One read, for that message only; the write is scoped.',
  ],
  [
    'app/api/whatsapp/pairing/route.test.ts',
    'Test-only mock of the raw client for the WhatsApp bridge sessions route (0189); it fakes the claim/release functions and never reaches a database.',
  ],
  [
    'app/api/whatsapp/bridge/sessions/route.ts',
    'The multi-workspace WhatsApp bridge asks which workspaces need a socket in this process (0189). Like a cron dispatcher it is about every workspace at once and has none to scope to; it only calls whatsapp_bridge_claim / whatsapp_bridge_release, which return workspace ids and a paired flag — never credentials or content. Everything the bridge does next goes through the per-workspace routes and their scoped clients.',
  ],
  [
    'app/api/whatsapp/status/route.ts',
    'Single mode only (0189): a bridge pinned by WHATSAPP_ORGANIZATION_ID reports into that workspace, so another one has no session row and a scoped read can only say "not reporting". One unscoped existence check — admins only, only when there is no row here and no multi-workspace bridge is alive — turns into a yes/no that tells the admin to change the variable; no id, number or timestamp of the other workspace leaves the route.',
  ],
  [
    'app/api/meetings/live/voice-answer/route.ts',
    'The meet-bot posts here with a service token and an organization id, no session. Resolving that org to a directory user (the owner) is what the raw client is for; the turn itself then runs on a handle scoped to that workspace.',
  ],
  [
    'lib/billing/webhook.ts',
    'A payment gateway event (Wompi) arrives with no session and no workspace, only the payment reference Cortex signed. One read of billing_payments.organization_id by that unique reference, after the signature is verified; everything else runs on a handle scoped to that workspace.',
  ],
  [
    'lib/billing/renewals.ts',
    'Daily billing cron. Lists only the organization_id of workspaces that have a billing row; each one is then read, reminded and updated through its own scoped handle.',
  ],
]);

/** Files that mention the raw client only in order to police it. */
const NAMES_IT_WITHOUT_CALLING_IT = new Set([
  // This file, which lists every allowed path in prose.
  'lib/tenancy-guard.test.ts',
  // The errand equivalent: asserts that nothing under lib/errands, its routes
  // or its screens reaches for the raw client, and names it to do so.
  'lib/errands/tenancy.test.ts',
  // The same, for avisos: asserts that the notifications module has exactly one
  // writer and never reaches for the raw client. It names the helper to look
  // for it in the source it scans.
  'lib/notifications/tenancy.test.ts',
]);

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['app', 'lib', 'inngest'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function filesUsingTheRawClient(): string[] {
  const hits: string[] = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(join(WEB_ROOT, root))) {
      const relative = file.slice(WEB_ROOT.length);
      // Tests that ASSERT something about raw-client usage name the helper in
      // prose without ever calling it. Skipped by path rather than by some
      // cleverer heuristic, so the exemption stays as visible as the list.
      if (NAMES_IT_WITHOUT_CALLING_IT.has(relative)) continue;
      if (readFileSync(file, 'utf8').includes('getSupabaseServiceClient')) hits.push(relative);
    }
  }
  return hits.sort();
}

describe('unscoped database access', () => {
  it('happens only in the places that were argued for', () => {
    const unexpected = filesUsingTheRawClient().filter((f) => !ALLOWED.has(f));
    expect(
      unexpected,
      'These files reach for a client that sees every workspace. Almost certainly they want ' +
        'getOrgScopedClient(user.organization.id) instead. If one of them genuinely needs the ' +
        'raw client, add it to ALLOWED in this file with the reason.',
    ).toEqual([]);
  });

  it('has no stale entries, so the list stays an argument rather than a graveyard', () => {
    const actual = new Set(filesUsingTheRawClient());
    const stale = [...ALLOWED.keys()].filter((f) => !actual.has(f));
    expect(stale, 'These files no longer use the raw client — drop them from ALLOWED.').toEqual([]);
  });

  it('gives a real reason for each exemption', () => {
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file} needs a reason somebody can disagree with`).toBeGreaterThan(
        40,
      );
    }
  });
});
