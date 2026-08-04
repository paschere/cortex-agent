import { PageHeader } from '@/components/ui/page-header';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { DEV_REPO_COLUMNS, isMissingTable, toDevRepository } from '@/lib/dev-work';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
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
          <ArrowLeft className="h-3.5 w-3.5" /> Trabajo de desarrollo
        </Link>
      </div>

      <PageHeader
        title="Dónde puede trabajar Cortex"
        subtitle="La lista completa de repositorios que Cortex tiene permitido cambiar. Lo que no está aquí, no lo puede tocar."
        icon={<ShieldCheck className="h-5 w-5" />}
      />

      {notReady ? (
        <Panel className="p-10 text-center text-[13px] text-ink-muted">
          <FolderGit2 className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="mb-1 text-[15px] font-bold text-ink">
            Todavía no está activo en este ambiente
          </p>
          <p className="mx-auto max-w-md leading-relaxed">
            Aquí Cortex no tiene repositorios propios y no puede tener ninguno hasta que se instale
            la base de datos que lo soporta.
          </p>
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel className="flex flex-wrap items-center gap-3 p-4">
            <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
            <p className="min-w-0 flex-1 text-[12.5px] text-ink-muted">
              {enabled.length === 0 ? (
                <>
                  Ahora mismo Cortex no puede cambiar{' '}
                  <span className="font-semibold text-ink">ningún</span> código. No hay nada
                  activado.
                </>
              ) : (
                <>
                  Cortex puede abrir pull requests en{' '}
                  <span className="font-semibold text-ink">
                    {enabled.length === 1 ? 'un repositorio' : `${enabled.length} repositorios`}
                  </span>
                  . Nunca integra nada por su cuenta: siempre aprueba una persona.
                </>
              )}
            </p>
          </Panel>

          {isAdmin && (
            <Panel className="p-5">
              <Eyebrow>Permitir un repositorio nuevo</Eyebrow>
              <p className="mt-1.5 text-[12.5px] text-ink-muted">
                Agregar uno amplía lo que Cortex puede cambiar. Agrega solo repositorios en los que
                estés dispuesto a que abra pull requests.
              </p>
              <form action={addRepository} className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  name="fullName"
                  required
                  pattern="[\w.\-]+/[\w.\-]+"
                  placeholder="dueño/repositorio"
                  title="dueño/repositorio, tal como aparece en GitHub"
                  aria-label="Nombre completo del repositorio"
                  className="min-w-[220px] flex-1 rounded-card border border-border bg-surface px-3 py-2 font-mono text-[13px] text-ink transition-colors placeholder:text-ink-faint focus:border-border-strong focus:outline-none"
                />
                <input
                  name="defaultBranch"
                  placeholder="main"
                  aria-label="Rama base"
                  className="w-28 rounded-card border border-border bg-surface px-3 py-2 font-mono text-[13px] text-ink transition-colors placeholder:text-ink-faint focus:border-border-strong focus:outline-none"
                />
                <input
                  name="description"
                  placeholder="¿Qué es? (opcional)"
                  aria-label="Descripción del repositorio"
                  className="min-w-[200px] flex-1 rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink transition-colors placeholder:text-ink-faint focus:border-border-strong focus:outline-none"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-strong"
                >
                  <Plus className="h-3.5 w-3.5" /> Permitir
                </button>
              </form>
            </Panel>
          )}

          {repos.length === 0 ? (
            <Panel className="p-8 text-center text-[13px] text-ink-muted">
              <p className="mb-1 text-[14px] font-bold text-ink">No hay repositorios</p>
              <p className="mx-auto max-w-sm leading-relaxed">
                Mientras esta lista esté vacía, Cortex no puede cambiar ningún código.
                {isAdmin
                  ? ' Agrega uno arriba para habilitarlo.'
                  : ' Pídele a un administrador que agregue el primero.'}
              </p>
            </Panel>
          ) : (
            <div className="space-y-3">
              {repos.map((repo) => {
                const runs = runsByRepo[repo.id] ?? 0;
                return (
                  <Panel key={repo.id} className="p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <span
                        className={`grid h-9 w-9 shrink-0 place-items-center rounded-card border ${
                          repo.enabled
                            ? 'border-emerald/40 bg-emerald-soft text-emerald'
                            : 'border-border bg-surface-2 text-ink-faint'
                        }`}
                      >
                        <FolderGit2 className="h-4 w-4" />
                      </span>

                      <div className="min-w-0 flex-1 basis-[18rem]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-mono text-[13px] font-bold text-ink">
                            {repo.fullName ?? repo.name}
                          </span>
                          <span className={chipClass(repo.enabled ? 'emerald' : 'neutral')}>
                            {repo.enabled ? 'Cortex puede editar' : 'Apagado'}
                          </span>
                        </div>
                        {repo.description && (
                          <p className="mt-1 text-[12.5px] text-ink-muted">{repo.description}</p>
                        )}
                        <div className="tabular mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
                          <span className="inline-flex items-center gap-1.5">
                            <GitBranch className="h-3.5 w-3.5" />
                            ramifica desde {repo.defaultBranch ?? 'main'}
                          </span>
                          <span>
                            {runs === 0
                              ? 'sin ejecuciones'
                              : `${runs} ${runs === 1 ? 'ejecución' : 'ejecuciones'}`}
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
                              className={`inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                repo.enabled
                                  ? 'text-amber hover:bg-amber-soft'
                                  : 'text-emerald hover:bg-emerald-soft'
                              }`}
                              title={
                                repo.enabled
                                  ? 'Cortex deja de tomar trabajo aquí. El historial se conserva.'
                                  : 'Deja que Cortex vuelva a trabajar aquí.'
                              }
                            >
                              <Power className="h-3.5 w-3.5" />
                              {repo.enabled ? 'Apagar' : 'Encender'}
                            </button>
                          </form>
                          <form action={removeRepository}>
                            <input type="hidden" name="id" value={repo.id} />
                            <button
                              type="submit"
                              title="Olvidar este repositorio por completo. Casi siempre lo que quieres es apagarlo."
                              className="inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-rose transition-colors hover:bg-rose-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-rose"
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Quitar
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
            <p className="flex items-start gap-2 px-1 text-[12px] text-ink-muted">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Solo un administrador del espacio puede cambiar esta lista. Detener una ejecución en
              curso lo puede hacer cualquiera.
            </p>
          )}
        </div>
      )}
    </>
  );
}
