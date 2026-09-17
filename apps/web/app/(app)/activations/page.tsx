import { requireSession } from '@/lib/session';
import { workspaceHref } from '@/lib/workspace-context';
import { ActivationWorkspace } from './ActivationWorkspace';

export const metadata = { title: 'Activaciones · Cortex' };
export const dynamic = 'force-dynamic';

export default async function ActivationsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const user = await requireSession();
  const workspaceId = user.organization.id;
  const { source } = await searchParams;

  return (
    <ActivationWorkspace
      key={`${workspaceId}:${user.id}`}
      workspaceId={workspaceId}
      organizationName={user.organization.name}
      feedHref={workspaceHref(workspaceId, '/feed')}
      feedFileHref={workspaceHref(workspaceId, '/feed?mode=file')}
      feedUrlHref={workspaceHref(workspaceId, '/feed?mode=url')}
      feedTextHref={workspaceHref(workspaceId, '/feed?mode=text')}
      feedApiHref={workspaceHref(workspaceId, '/feed?mode=api')}
      managementHref={workspaceHref(workspaceId, '/management')}
      initialSourceId={source ?? null}
    />
  );
}
