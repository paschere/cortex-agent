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
    'app/api/mcp/route.ts',
    'Bearer-token surface. The token lookup determines the workspace; everything after it is scoped.',
  ],
  [
    'app/api/webhooks/linear/route.ts',
    'Signature-authenticated webhook with no session. Writes the delivery ledger row before the delivery can be attributed to anything.',
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
    'inngest/functions/drive-sync.ts',
    'Cron. Scans every synced folder; each sync-state row names its workspace and the per-collection step is scoped to it.',
  ],
  [
    'inngest/functions/meeting-import.ts',
    'Cron. Scans every Google connection in the install; the per-user sweep is scoped to the workspace that granted it.',
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
    'app/api/whatsapp/links/route.ts',
    'whatsapp_links is keyed by the phone number install-wide, so "already linked somewhere else" is invisible to a scoped read and would surface as a constraint error instead of an explanation. One read, for that message only; the write is scoped.',
  ],
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
      // This file names every allowed path in prose; it is not a caller.
      if (relative === 'lib/tenancy-guard.test.ts') continue;
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
