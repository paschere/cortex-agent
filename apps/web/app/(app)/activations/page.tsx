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
      managementHref={workspaceHref(workspaceId, '/management')}
      initialSourceId={source ?? null}
    />
  );
}
