import { PageHeader } from '@/components/ui/page-header';
import { askCortexHref } from '@/lib/help/shape';
import {
  HELP_CATEGORIES,
  HELP_CATEGORY_LABEL,
  type HelpArticle,
  helpArticles,
  helpExcerpt,
  helpIndex,
  isHelpArticleVisible,
  searchHelp,
} from '@cortex/agent-tools';
import { ArrowRight, BookOpen, Inbox, LifeBuoy, MessageSquare, Search } from 'lucide-react';
import Link from 'next/link';

/**
 * El centro de ayuda, pintado en el servidor: categorías o resultados de la
 * búsqueda. Lo usan /ayuda (con la sesión) y su vitrina de desarrollo
 * (/v/ayuda-showcase), así que no lee la sesión: recibe lo que necesita.
 */
export function HelpCenterView({
  query,
  enabled,
  operator,
  support,
}: {
  query: string;
  /** Módulos encendidos; `undefined` = sin filtro. */
  enabled: ReadonlySet<string> | undefined;
  operator: boolean;
  support: boolean;
}) {
  const visible = helpArticles().filter((a) => isHelpArticleVisible(a, enabled));
  const hits = query ? searchHelp(helpIndex(), query, { enabled, limit: 12 }) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Ayuda"
        subtitle="Cómo usar Cortex, paso a paso. Busca un tema, abre la ayuda de cualquier pantalla con el botón ? de arriba, o pregúntale a Cortex."
        icon={<LifeBuoy className="h-5 w-5" />}
        actions={
          <>
            {operator && (
              <Link
                href="/overview/soporte"
                className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
              >
                <Inbox className="h-4 w-4" /> Bandeja de soporte
              </Link>
            )}
            {support && (
              <Link
                href="/ayuda/soporte"
                className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
              >
                <LifeBuoy className="h-4 w-4" /> Escribir a soporte
              </Link>
            )}
          </>
        }
      />

      <form action="/ayuda" method="get" aria-label="Buscar en la ayuda" className="relative mb-8">
        <label htmlFor="help-q" className="sr-only">
          Buscar en la ayuda
        </label>
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-faint" />
        <input
          id="help-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="¿Qué necesitas? Ej.: conectar Siigo, subir extracto, vincular WhatsApp"
          className="h-14 w-full rounded-pill border border-border-strong bg-surface pl-12 pr-32 text-base text-ink shadow-card placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <button
          type="submit"
          className="cortex-primary-button absolute right-2 top-1/2 inline-flex min-h-10 -translate-y-1/2 items-center rounded-pill bg-primary px-5 text-sm font-bold text-white hover:bg-primary-strong"
        >
          Buscar
        </button>
      </form>

      {query ? (
        <section aria-label="Resultados" data-help-results>
          <h2 className="mb-3 text-sm font-bold text-ink-muted">
            {hits.length > 0
              ? `${hits.length} ${hits.length === 1 ? 'artículo' : 'artículos'} para «${query}»`
              : `No encontré artículos para «${query}»`}
          </h2>
          <ul className="space-y-3">
            {hits.map(({ article }) => (
              <li key={article.slug}>
                <ArticleRow article={article} excerpt={helpExcerpt(article, query, 220)} />
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={askCortexHref(query)}
              className="inline-flex min-h-10 items-center gap-2 rounded-pill bg-primary-soft px-4 text-sm font-bold text-primary hover:brightness-95"
            >
              <MessageSquare className="h-4 w-4" /> Pregúntale a Cortex: «{query}»
            </Link>
            <Link
              href="/ayuda"
              className="inline-flex min-h-10 items-center rounded-pill px-4 text-sm font-semibold text-ink-muted hover:text-ink"
            >
              Ver todos los temas
            </Link>
          </div>
        </section>
      ) : (
        <div className="grid gap-5 md:grid-cols-2" data-help-categories>
          {HELP_CATEGORIES.map((category) => {
            const items = visible.filter((a) => a.category === category);
            if (items.length === 0) return null;
            return (
              <section
                key={category}
                className="rounded-card border border-border bg-surface p-5 shadow-card"
              >
                <h2 className="text-base font-extrabold text-ink">
                  {HELP_CATEGORY_LABEL[category]}
                </h2>
                <ul className="mt-3 divide-y divide-border">
                  {items.map((article) => (
                    <li key={article.slug}>
                      <Link
                        href={`/ayuda/${article.slug}`}
                        className="group flex items-start gap-3 py-2.5"
                      >
                        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-bold text-ink group-hover:text-primary">
                            {article.title}
                          </span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                            {article.summary}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {support && (
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-card bg-primary-soft p-5">
          <div>
            <p className="text-base font-bold text-ink">¿Algo no funciona como debería?</p>
            <p className="mt-1 text-sm text-ink-muted">
              Escríbenos con un pantallazo. Adjuntamos la pantalla y el navegador por ti.
            </p>
          </div>
          <Link
            href="/ayuda/soporte"
            className="cortex-primary-button inline-flex min-h-10 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white hover:bg-primary-strong"
          >
            Escribir a soporte <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}
    </div>
  );
}

function ArticleRow({ article, excerpt }: { article: HelpArticle; excerpt: string }) {
  return (
    <Link
      href={`/ayuda/${article.slug}`}
      className="group block rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40"
    >
      <span className="text-micro font-bold uppercase tracking-wide text-ink-faint">
        {HELP_CATEGORY_LABEL[article.category]}
      </span>
      <span className="mt-1 flex items-center gap-2 text-base font-bold text-ink group-hover:text-primary">
        {article.title}
      </span>
      <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{excerpt}</span>
    </Link>
  );
}
