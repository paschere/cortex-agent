import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildLearningReport } from '@cortex/agent-tools';
import { ArrowRight, Sprout } from 'lucide-react';
import Link from 'next/link';
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
      {/*
        Evaluación came off the sidebar — it is the most specialised screen in
        the product (the runs happen in `pnpm test` and on somebody's terminal,
        and this page has no button that starts one), and nothing else in the
        app linked to it, so removing the nav entry would have orphaned it.
        Its door is here because this is the screen it belongs to: this page
        says what Cortex changed about itself, that one says whether the answers
        got better or worse for it. Cause and measurement, one click apart.
      */}
      <PageHeader
        title="Aprendizaje"
        subtitle="Lo que Cortex fue cambiando solo a punta de usarlo, con qué evidencia, y qué queda esperando a que alguien decida."
        icon={<Sprout className="h-5 w-5" />}
        actions={
          <Link
            href="/evaluation"
            className="inline-flex items-center gap-1 rounded-pill border border-border px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors duration-150 hover:border-border-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            ¿Mejoraron las respuestas? <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
      />
      <Learning view={toView(report)} />
    </div>
  );
}
