import { HelpArticleView } from '@/components/help/HelpArticleView';
import { HelpCenterView } from '@/components/help/HelpCenterView';
import { type PanelArticle, screenLabel } from '@/lib/help/shape';
import {
  MODULE_KEYS,
  helpArticle,
  helpArticles,
  helpArticlesForRoute,
  helpExcerpt,
  helpIndex,
  searchHelp,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { HelpPanelShowcase } from './Showcase';

/**
 * LA AYUDA SIN SESIÓN. SÓLO EN DESARROLLO.
 *
 * /ayuda pide sesión; aquí se pintan los mismos componentes con todos los
 * módulos encendidos, para mirarlos (y fotografiarlos) sin entrar:
 *
 *   ?vista=centro                 las categorías
 *   ?vista=centro&q=extracto      resultados de búsqueda
 *   ?vista=articulo&slug=por-pagar un artículo
 *   ?vista=panel&ruta=/pagar      el panel «?» abierto sobre una pantalla
 *
 * En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const ALL = new Set<string>(MODULE_KEYS);

function toPanel(slug: string, query?: string): PanelArticle | null {
  const a = helpArticle(slug);
  if (!a) return null;
  return {
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    route: a.route,
    ...(query ? { excerpt: helpExcerpt(a, query, 180) } : {}),
  };
}

export default async function AyudaShowcase({
  searchParams,
}: { searchParams: Promise<{ vista?: string; q?: string; slug?: string; ruta?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;

  if (q.vista === 'articulo') {
    const article = helpArticle(q.slug ?? 'por-pagar');
    if (!article) notFound();
    return (
      <div className="cortex-workspace min-h-screen bg-canvas px-4 py-8 md:px-8">
        <HelpArticleView article={article} enabled={ALL} vote={null} support />
      </div>
    );
  }

  if (q.vista === 'panel') {
    const route = q.ruta?.startsWith('/') ? q.ruta : '/pagar';
    const articles = helpArticlesForRoute(helpArticles(), route, { enabled: ALL, limit: 5 })
      .map((a) => toPanel(a.slug))
      .filter((a): a is PanelArticle => a !== null);
    const searchable = helpArticles()
      .map((a) => toPanel(a.slug))
      .filter((a): a is PanelArticle => a !== null);
    const sample = 'aprobar factura';
    const sampleHits = searchHelp(helpIndex(), sample, { enabled: ALL, limit: 6 })
      .map((h) => toPanel(h.article.slug, sample))
      .filter((a): a is PanelArticle => a !== null);
    return (
      <HelpPanelShowcase
        screen={screenLabel(route)}
        articles={articles}
        searchable={searchable}
        sampleHits={sampleHits}
      />
    );
  }

  return (
    <div className="cortex-workspace min-h-screen bg-canvas px-4 py-8 md:px-8">
      <HelpCenterView query={(q.q ?? '').trim()} enabled={ALL} operator={false} support />
    </div>
  );
}
