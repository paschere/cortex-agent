import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listVisibleSpaces } from '@cortex/agent-tools';
import { MailLearningReview, type Proposal } from './review';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [proposals, spaces] = await Promise.all([
    db
      .from('mail_learning_proposals')
      .select('id,thread_id,draft,state,created_at,reviewed_at,review_note,document_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(51),
    listVisibleSpaces(db, user.id),
  ]);
  if (proposals.error) throw new Error('No se pudo leer la bandeja privada de aprendizaje.');
  return (
    <MailLearningReview
      proposals={(proposals.data ?? []).slice(0, 50) as Proposal[]}
      partial={(proposals.data?.length ?? 0) > 50}
      spaces={
        user.role === 'org_admin'
          ? spaces.filter((s) => s.kind !== 'personal').map((s) => ({ id: s.id, name: s.name }))
          : []
      }
    />
  );
}
