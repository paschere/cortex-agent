import { HelpArticleView } from '@/components/help/HelpArticleView';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { supportChannel } from '@/lib/support/shape';
import { readHelpFeedback } from '@/lib/support/store';
import { helpArticle, helpEnabledModules } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Un artículo de ayuda: el Markdown, la pantalla de la que habla y «¿Te sirvió?». */
export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = helpArticle(slug);
  if (!article) notFound();

  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [enabled, vote] = await Promise.all([
    helpEnabledModules(db),
    readHelpFeedback(db, user.id, article.slug),
  ]);
  return (
    <HelpArticleView
      article={article}
      enabled={enabled}
      vote={vote}
      support={supportChannel(process.env.SUPPORT_CHANNEL) !== 'off'}
    />
  );
}
