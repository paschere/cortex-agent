import { PageHeader } from '@/components/ui/page-header';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { DEV_REPO_COLUMNS, isMissingTable, toDevRepository } from '@/lib/dev-work';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  ArrowLeft,
  FolderGit2,
  GitBranch,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * The blast radius.
 *
 * This list is the whole answer to "what can Cortex break". A repository that is
 * not on it, or is on it switched off, is a repository Cortex cannot open a pull
 * request against — so the page is written to be read by whoever is
 * accountable, not only by whoever writes the code.
 *
 * Everyone can SEE the list: knowing what an autonomous agent is allowed to
 * touch is not a privilege. Only an org admin can change it, enforced in each
 * server action rather than by hiding the form.
 */

/** `owner/repo`, the only shape GitHub actually uses. */
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

async function addRepository(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');

  const fullName = (formData.get('fullName') as string | null)?.trim();
  if (!fullName || !FULL_NAME.test(fullName)) return;
  const description = (formData.get('description') as string | null)?.trim() || null;
  const defaultBranch = (formData.get('defaultBranch') as string | null)?.trim() || 'main';

  const sb = getSupabaseServiceClient();
  await sb.from('dev_repositories').insert({
    name: fullName.split('/')[1],
    full_name: fullName,
    description,
    default_branch: defaultBranch,
    enabled: true,
    added_by: user.id,
  });
  revalidatePath('/dev-work/repositories');
}

async function setEnabled(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');

  const id = (formData.get('id') as string | null)?.trim();
  const enabled = formData.get('enabled') === 'true';
  if (!id) return;

  const sb = getSupabaseServiceClient();
  await sb.from('dev_repositories').update({ enabled }).eq('id', id);
  revalidatePath('/dev-work/repositories');
}

async function removeRepository(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');

  const id = (formData.get('id') as string | null)?.trim();
  if (!id) return;

  const sb = getSupabaseServiceClient();
  await sb.from('dev_repositories').delete().eq('id', id);
  revalidatePath('/dev-work/repositories');
}

export default async function DevRepositoriesPage() {
  const user = await requireSession();
  const isAdmin = user.role === 'org_admin';
  const sb = getSupabaseServiceClient();

  const [repoRes, taskRes] = await Promise.all([
    sb.from('dev_repositories').select(DEV_REPO_COLUMNS).order('name'),
    sb.from('dev_tasks').select('repository_id'),
  ]);

  const notReady = isMissingTable(repoRes.error);
  const repos = ((repoRes.data ?? []) as unknown as Record<string, unknown>[]).map(toDevRepository);

  const runsByRepo = ((taskRes.data ?? []) as { repository_id: string | null }[]).reduce<
    Record<string, number>
  >((acc, t) => {
    if (t.repository_id) acc[t.repository_id] = (acc[t.repository_id] ?? 0) + 1;
    return acc;
  }, {});

  const enabled = repos.filter((r) => r.enabled);

  return (
    <>
      <div className="mb-4">
        <Link
          href="/dev-work"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Dev Work
        </Link>
      </div>

      <PageHeader
        title="Where Cortex may work"
        subtitle="The complete list of repositories Cortex is allowed to change. Anything not on this list is out of reach."
        icon={<ShieldCheck className="h-5 w-5" />}
      />

      {notReady ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          <FolderGit2 className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="mb-1 font-semibold text-ink">Not switched on in this environment yet</p>
          <p className="mx-auto max-w-md">
            Cortex has no repositories of its own here, and cannot get any until the groundwork is
            installed.
          </p>
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel className="flex flex-wrap items-center gap-3 p-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
              <FolderGit2 className="h-4 w-4" />
            </span>
            <p className="min-w-0 flex-1 text-[12.5px] text-ink-muted">
              {enabled.length === 0 ? (
                <>
                  Cortex currently cannot change <span className="font-semibold text-ink">any</span>{' '}
                  code. Nothing here is switched on.
                </>
              ) : (
                <>
                  Cortex can open pull requests in{' '}
                  <span className="font-semibold text-ink">
                    {enabled.length === 1 ? 'one repository' : `${enabled.length} repositories`}
                  </span>
                  . It never merges anything on its own — a person always approves.
                </>
              )}
            </p>
          </Panel>

          {isAdmin && (
            <Panel className="p-5">
              <Eyebrow>Allow a new repository</Eyebrow>
              <p className="mt-1.5 text-[12.5px] text-ink-muted">
                Adding one widens what Cortex can change. Only add repositories you are willing to
                have it open pull requests against.
              </p>
              <form action={addRepository} className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  name="fullName"
                  required
                  pattern="[\w.\-]+/[\w.\-]+"
                  placeholder="zipdev/cortex-agent"
                  title="owner/repository, exactly as it appears on GitHub"
                  className="min-w-[220px] flex-1 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                />
                <input
                  name="defaultBranch"
                  placeholder="main"
                  className="w-28 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                />
                <input
                  name="description"
                  placeholder="What is it? (optional)"
                  className="min-w-[200px] flex-1 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
                >
                  <Plus className="h-3.5 w-3.5" /> Allow
                </button>
              </form>
            </Panel>
          )}

          {repos.length === 0 ? (
            <Panel className="p-8 text-center text-[13px] text-ink-faint">
              No repositories yet — Cortex cannot change any code.
            </Panel>
          ) : (
            <div className="space-y-3">
              {repos.map((repo) => {
                const runs = runsByRepo[repo.id] ?? 0;
                return (
                  <Panel key={repo.id} className="p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <span
                        className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${
                          repo.enabled
                            ? 'bg-emerald-soft text-emerald'
                            : 'bg-surface-2 text-ink-faint'
                        }`}
                      >
                        <FolderGit2 className="h-4 w-4" />
                      </span>

                      <div className="min-w-0 flex-1 basis-[18rem]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[13.5px] font-bold text-ink">
                            {repo.fullName ?? repo.name}
                          </span>
                          <span
                            className={`rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${
                              repo.enabled
                                ? 'bg-emerald-soft text-emerald'
                                : 'bg-surface-2 text-ink-faint'
                            }`}
                          >
                            {repo.enabled ? 'Cortex may edit' : 'Switched off'}
                          </span>
                        </div>
                        {repo.description && (
                          <p className="mt-1 text-[12.5px] text-ink-muted">{repo.description}</p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
                          <span className="inline-flex items-center gap-1.5">
                            <GitBranch className="h-3.5 w-3.5" />
                            branches from {repo.defaultBranch ?? 'main'}
                          </span>
                          <span>
                            {runs === 0
                              ? 'no runs yet'
                              : `${runs} run${runs === 1 ? '' : 's'} so far`}
                          </span>
                        </div>
                      </div>

                      {isAdmin && (
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <form action={setEnabled}>
                            <input type="hidden" name="id" value={repo.id} />
                            <input
                              type="hidden"
                              name="enabled"
                              value={repo.enabled ? 'false' : 'true'}
                            />
                            <button
                              type="submit"
                              className={`inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold shadow-card transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                repo.enabled
                                  ? 'text-amber hover:bg-amber-soft'
                                  : 'text-emerald hover:bg-emerald-soft'
                              }`}
                              title={
                                repo.enabled
                                  ? 'Cortex stops picking up work here. History is kept.'
                                  : 'Let Cortex work here again.'
                              }
                            >
                              <Power className="h-3.5 w-3.5" />
                              {repo.enabled ? 'Switch off' : 'Switch on'}
                            </button>
                          </form>
                          <form action={removeRepository}>
                            <input type="hidden" name="id" value={repo.id} />
                            <button
                              type="submit"
                              title="Forget this repository entirely. Switching it off is usually what you want."
                              className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-rose shadow-card transition hover:bg-rose-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-rose"
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Remove
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  </Panel>
                );
              })}
            </div>
          )}

          {!isAdmin && (
            <p className="flex items-start gap-2 px-1 text-[12px] text-ink-faint">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Only a workspace admin can change this list. Anyone can stop a run in progress.
            </p>
          )}
        </div>
      )}
    </>
  );
}
