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
    'lib/supabase/service.ts',
    'Defines both clients. The scoped one is built by wrapping the raw one.',
  ],
  [
    'lib/session.ts',
    'Runs before a workspace is known and is what resolves it: it reads the directory row inside the workspace the session names.',
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
    'app/api/meetings/live/voice-answer/route.ts',
    'The meet-bot posts here with a service token and an organization id, no session. Resolving that org to a directory user (the owner) is what the raw client is for; the turn itself then runs on a handle scoped to that workspace.',
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
