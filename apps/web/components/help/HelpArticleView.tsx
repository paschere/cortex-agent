import { HelpFeedback } from '@/components/help/HelpFeedback';
import { HelpMarkdown } from '@/components/help/HelpMarkdown';
import { askCortexHref, screenLabel } from '@/lib/help/shape';
import {
  HELP_CATEGORY_LABEL,
  type HelpArticle,
  helpArticles,
  isHelpArticleVisible,
} from '@cortex/agent-tools';
import { ArrowRight, ChevronRight, LifeBuoy, MessageSquare } from 'lucide-react';
import Link from 'next/link';

const DATE = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Un artículo de ayuda: el Markdown, la pantalla de la que habla, los
 * relacionados y «¿Te sirvió?». No lee la sesión (lo usa también la vitrina
 * de desarrollo /v/ayuda-showcase): recibe los módulos y el voto.
 */
export function HelpArticleView({
  article,
  enabled,
  vote,
  support,
}: {
  article: HelpArticle;
  enabled: ReadonlySet<string> | undefined;
  vote: boolean | null;
  support: boolean;
}) {
  const moduleOff = !isHelpArticleVisible(article, enabled);
  const related = helpArticles()
    .filter(
      (a) =>
        a.slug !== article.slug &&
        a.category === article.category &&
        isHelpArticleVisible(a, enabled),
    )
    .slice(0, 4);
  const screen = screenLabel(article.route) ?? 'la pantalla';

  return (
    <div className="mx-auto max-w-5xl" data-help-article={article.slug}>
      <nav aria-label="Ruta" className="mb-4 flex items-center gap-1.5 text-sm text-ink-faint">
        <Link href="/ayuda" className="font-semibold hover:text-ink">
          Ayuda
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span>{HELP_CATEGORY_LABEL[article.category]}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <article>
          <h1 className="text-balance text-xl font-extrabold text-ink md:text-display">
            {article.title}
          </h1>
          <p className="mt-2 max-w-2xl text-base leading-relaxed text-ink-muted">
            {article.summary}
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            Actualizado el {DATE.format(new Date(`${article.updated}T00:00:00Z`))}
          </p>
          {moduleOff && (
            <p className="mt-4 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-ink">
              Este módulo está apagado en tu empresa. Un administrador lo puede prender en Ajustes.
            </p>
          )}
          <div className="mt-6 rounded-card border border-border bg-surface p-5 shadow-card md:p-8">
            <HelpMarkdown>{article.body}</HelpMarkdown>
          </div>
          <div className="mt-6">
            <HelpFeedback slug={article.slug} initial={vote} />
          </div>
        </article>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Link
            href={article.route}
            className="cortex-primary-button flex min-h-11 items-center justify-between gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white hover:bg-primary-strong"
          >
            Ir a {screen} <ArrowRight className="h-4 w-4" />
          </Link>
          <div className="rounded-card bg-primary-soft p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-ink">
              <MessageSquare className="h-4 w-4 text-primary" /> ¿Te quedó una duda?
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Cortex contesta con este artículo y lo hace contigo.
            </p>
            <Link
              href={askCortexHref(`Tengo una duda sobre «${article.title}»: `)}
              className="mt-3 inline-flex min-h-9 items-center gap-1.5 text-sm font-bold text-primary hover:underline"
            >
              Pregúntale a Cortex <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {related.length > 0 && (
            <div className="rounded-card border border-border bg-surface p-4 shadow-card">
              <p className="text-micro font-bold uppercase tracking-wide text-ink-faint">
                También en {HELP_CATEGORY_LABEL[article.category]}
              </p>
              <ul className="mt-2 space-y-1.5">
                {related.map((a) => (
                  <li key={a.slug}>
                    <Link
                      href={`/ayuda/${a.slug}`}
                      className="text-sm font-semibold text-ink hover:text-primary"
                    >
                      {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {support && (
            <Link
              href={`/ayuda/soporte?desde=${encodeURIComponent(article.route)}`}
              className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-muted hover:text-ink"
            >
              <LifeBuoy className="h-4 w-4" /> Escribir a soporte
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}
