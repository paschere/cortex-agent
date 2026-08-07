import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildLearningReport } from '@cortex/agent-tools';
import { Sprout } from 'lucide-react';
import { Learning } from './_components/Learning';
import { toView } from './_lib/view';

export const dynamic = 'force-dynamic';

/**
 * What Cortex has learned from being used, and how to take it back.
 *
 * The page exists because the alternative is a system that adjusts itself in
 * the dark. Every claim on it is a row: what changed, what evidence changed it,
 * what has been observed since, and a button that puts it back. Nothing here is
 * a score, a health index or a percentage that nobody can trace to a fact.
 *
 * `viewerId` is passed separately from the workspace on purpose. The workspace
 * decides which rows exist; the viewer decides which document names they may be
 * shown next to, because an adjustment can be about a fragment of somebody's
 * personal space. See learning/report.ts.
 */
export default async function LearningPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const report = await buildLearningReport(db, { viewerId: user.id });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Aprendizaje"
        subtitle="Lo que Cortex fue cambiando solo a punta de usarlo, con qué evidencia, y qué queda esperando a que alguien decida."
        icon={<Sprout className="h-5 w-5" />}
      />
      <Learning view={toView(report)} />
    </div>
  );
}
