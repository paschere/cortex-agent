import { CollectionView } from '../../_components/CollectionView';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';

export default async function TeamKb({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const user = await requireSession();
  const sb = getSupabaseServiceClient();

  // org_admins have full access; otherwise verify user is a team_admin of this team
  if (user.role !== 'org_admin') {
    const { data: membership } = await sb
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership || membership.role !== 'team_admin') {
      notFound();
    }
  }

  // Resolve team name for a friendlier title
  const { data: team } = await sb
    .from('teams')
    .select('name')
    .eq('id', teamId)
    .maybeSingle();

  const title = team?.name ? `${team.name as string} KB` : 'Team Knowledge Base';

  return (
    <CollectionView
      scope="team"
      scopeId={teamId}
      title={title}
      subtitle="Shared documents available to everyone on this team"
    />
  );
}
