import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A RATCHET, NOT AN ALLOWLIST.
 *
 * ===========================================================================
 * WHAT IS BEING COUNTED AND WHY IT MATTERS
 * ===========================================================================
 * `supabase-js` never throws. A failed query comes back as `{ data: null,
 * error }`, so this line turns a database failure into an empty screen:
 *
 *     const { data } = await db.from('messages').select(...);
 *
 * An empty screen and a broken screen look identical and mean opposite things.
 * That exact shape has shipped to production in this repo more than once — most
 * visibly as every conversation in the product reading as brand new, because a
 * deploy landed a `select` before its migration and PostgREST rejected the whole
 * query for one unknown column. Neither the build, nor the types, nor the tests
 * could catch it: the column was real in the repo and missing only in the
 * database that was running. `lib/supabase/read.ts` is the fix; this file is
 * what stops the fix from being optional.
 *
 * ===========================================================================
 * WHY A BASELINE INSTEAD OF THE tenancy-guard.test.ts SHAPE
 * ===========================================================================
 * `tenancy-guard.test.ts` is the model this follows and it uses an allowlist
 * with a written reason per entry, which works beautifully there: raw-client
 * usage is rare, deliberate, and there are twenty-eight of them.
 *
 * There are over a hundred of these. Demanding a paragraph for each one today
 * would mean either a hundred invented justifications — worthless, and worse
 * than nothing, because a list of fake reasons trains everybody to add one more
 * — or blocking every other piece of work until they are all migrated.
 *
 * So the rule is weaker and enforceable: THIS NUMBER MAY GO DOWN, NEVER UP. A
 * new file with an unchecked read fails. An existing file that grows one fails.
 * Fixing them is free and shows up in the diff as the count dropping, which is
 * the only kind of progress bar that cannot be faked.
 *
 * When a file reaches zero, delete its line. When the map is empty, delete this
 * file and replace it with a flat "none anywhere" assertion.
 */

/**
 * Files that read from Supabase without looking at `error`, and how many times.
 *
 * Recorded on 2026-08-13. Every entry is a place where a database failure
 * currently renders as emptiness. NOT a list of things that are fine.
 */
const BASELINE = new Map<string, number>([
  ['lib/errands/repository.ts', 8],
  ['app/api/whatsapp/status/route.ts', 6],
  ['app/(app)/integrations/page.tsx', 5],
  ['lib/guided-setup/store.ts', 5],
  ['inngest/functions/actions-sweep.ts', 4],
  // 4 → 1 el 2026-08-14: las tres lecturas de `users` que resolvían el
  // destinatario de un aviso se mudaron a directory/store.ts y ahora miran su
  // `error`. Importaba más que la media: una base caída se leía como «esta
  // empresa no tiene administradores», y el aviso se archivaba como entregado a
  // nadie.
  ['inngest/functions/commitments-watch.ts', 1],
  ['lib/dev-tasks/linear-comment.ts', 4],
  ['lib/orchestrator/repository.ts', 4],
  ['app/(app)/conversations/[id]/page.tsx', 3],
  ['app/api/browser/flows/[id]/route.ts', 3],
  ['app/api/chat-app/google/route.ts', 3],
  ['app/api/mcp/route.ts', 3],
  ['app/api/whatsapp/bridge/group-mention/route.ts', 3],
  ['inngest/functions/ingest-document.ts', 2],
  ['inngest/functions/schedule-run.ts', 3],
  ['lib/dev-work-notify.ts', 3],
  ['app/(app)/admin/users/[id]/page.tsx', 2],
  ['app/(app)/kb/_lib/inspect.ts', 2],
  ['app/(app)/kb/actions.ts', 2],
  ['app/(app)/pipelines/[slug]/page.tsx', 2],
  ['app/(app)/tools/page.tsx', 2],
  ['app/api/chat-app/google/turn.ts', 2],
  ['app/api/chat/attachments/route.ts', 2],
  ['app/api/chat/route.ts', 2],
  ['app/api/custom-tools/[id]/route.ts', 2],
  ['app/api/kb/drive/import-files/route.ts', 2],
  ['app/api/kb/graph/route.ts', 2],
  ['app/api/kb/meetings/route.ts', 2],
  ['app/api/mcp-servers/[id]/refresh/route.ts', 2],
  ['app/api/pipelines/[slug]/duplicate/route.ts', 2],
  ['app/api/whatsapp/bridge/heartbeat/route.ts', 2],
  ['app/api/whatsapp/bridge/messages/route.ts', 2],
  ['app/api/whatsapp/links/route.ts', 2],
  ['lib/browser-delivery.ts', 2],
  ['lib/google-chat.ts', 2],
  ['lib/guided-setup/apply.ts', 2],
  ['lib/orchestrator/executor.ts', 2],
  ['app/(app)/admin/usage/page.tsx', 1],
  ['app/(app)/agents/[slug]/page.tsx', 1],
  ['app/(app)/agents/page.tsx', 1],
  ['app/(app)/conversations/[id]/actions.ts', 1],
  ['app/(app)/conversations/page.tsx', 1],
  ['app/(app)/dev-work/[id]/page.tsx', 1],
  ['app/(app)/dev-work/page.tsx', 1],
  ['app/(app)/kb/_components/Digestion.tsx', 1],
  ['app/(app)/kb/_components/DriveSyncPanel.tsx', 1],
  ['app/(app)/kb/_components/MeetingImportPanel.tsx', 1],
  ['app/(app)/kb/_lib/brain.ts', 1],
  ['app/(app)/kb/page.tsx', 1],
  ['app/(app)/pipelines/[slug]/edit/page.tsx', 1],
  ['app/(app)/prospects/actions.ts', 1],
  ['app/(app)/prospects/page.tsx', 1],
  ['app/(app)/schedules/[id]/page.tsx', 1],
  ['app/(app)/schedules/page.tsx', 1],
  ['app/(auth)/signup/page.tsx', 1],
  ['app/(chat)/chat/[conversationId]/page.tsx', 1],
  ['app/(chat)/chat/actions.ts', 1],
  ['app/api/admin/_lib/audit-filters.ts', 1],
  ['app/api/admin/audit/export/route.ts', 1],
  ['app/api/chat/confirm/route.ts', 1],
  ['app/api/chat/conversations/[id]/route.ts', 1],
  ['app/api/chat/followups/route.ts', 1],
  ['app/api/chat/turn-metrics/route.ts', 1],
  ['app/api/conversations/[id]/route.ts', 1],
  ['app/api/conversations/route.ts', 1],
  ['app/api/custom-tools/[id]/test/route.ts', 1],
  ['app/api/errands/[id]/cancel/route.ts', 1],
  ['app/api/integrations/google/callback/route.ts', 1],
  ['app/api/integrations/microsoft/callback/route.ts', 1],
  ['app/api/kb/drive/_lib.ts', 1],
  ['app/api/kb/drive/status/route.ts', 1],
  ['app/api/orchestrator/[id]/cancel/route.ts', 1],
  ['app/api/pipelines/[slug]/route.ts', 1],
  ['app/api/schedules/[id]/route.ts', 1],
  ['app/api/schedules/[id]/run/route.ts', 1],
  ['app/api/settings/test-chat/route.ts', 1],
  ['app/api/whatsapp/bridge/state/route.ts', 1],
  ['app/api/whatsapp/groups/route.ts', 1],
  ['inngest/functions/dev-task-status.ts', 1],
  ['inngest/functions/errand-sweep.ts', 1],
  ['inngest/functions/meeting-import.ts', 1],
  ['inngest/functions/memory-derive.ts', 1],
  ['lib/approval-email.ts', 1],
  ['lib/approvals/claim.ts', 1],
  ['lib/approvals/decide.ts', 1],
  ['lib/chat-attachments.ts', 1],
  ['lib/nav-signals.ts', 1],
  ['lib/session.ts', 1],
]);

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['app', 'lib', 'inngest'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo']);

/**
 * `const { data }` or `const { data: rows }`, with nothing after it.
 *
 * Deliberately syntactic and deliberately conservative: it cannot tell a
 * Supabase read from any other destructuring of a `data` property, so it will
 * occasionally count something harmless. That is the right way to be wrong here
 * — the cost is one extra line in the baseline, and the alternative (a cleverer
 * pattern that misses real cases) is the failure this test exists to prevent.
 */
const UNCHECKED = /const \{ data(?::[^,}]+)? \}/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function countByFile(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of SCANNED) {
    for (const file of sourceFiles(join(WEB_ROOT, root))) {
      const hits = readFileSync(file, 'utf8').match(UNCHECKED)?.length ?? 0;
      if (hits > 0) counts.set(file.slice(WEB_ROOT.length), hits);
    }
  }
  return counts;
}

describe('reads that would render a database error as an empty screen', () => {
  it('never appear in a file that did not already have one', () => {
    const actual = countByFile();
    const added = [...actual.keys()].filter((f) => !BASELINE.has(f)).sort();
    expect(
      added,
      'These files destructure `data` without looking at `error`, so a failed query ' +
        'renders as emptiness instead of saying what went wrong. Use `mustRead` / ' +
        '`mustReadList` from lib/supabase/read.ts. If this is a COUNTER or a badge — where ' +
        'swallowing the error is right, see lib/nav-signals.ts — check the error explicitly ' +
        'and return the fallback, so the decision is visible at the call site.',
    ).toEqual([]);
  });

  it('never become more numerous in a file that has them', () => {
    const actual = countByFile();
    const grew: string[] = [];
    for (const [file, before] of BASELINE) {
      const now = actual.get(file) ?? 0;
      if (now > before) grew.push(`${file}: ${before} → ${now}`);
    }
    expect(grew, 'These files gained unchecked reads. The count may only go down.').toEqual([]);
  });

  it('keeps its own baseline honest, so the list cannot rot into fiction', () => {
    const actual = countByFile();
    const stale: string[] = [];
    for (const [file, before] of BASELINE) {
      const now = actual.get(file) ?? 0;
      if (now < before) stale.push(`${file}: ${before} → ${now}`);
    }
    expect(
      stale,
      'These files have FEWER unchecked reads than the baseline claims — which is good news. ' +
        'Update the numbers in BASELINE (or drop the line if it reached zero) so the list keeps ' +
        'measuring something real.',
    ).toEqual([]);
  });
});
