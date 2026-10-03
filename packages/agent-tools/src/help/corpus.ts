import { type HelpArticle, parseHelpArticle } from './article';
import { type HelpIndex, buildHelpIndex } from './search';
import { HELP_SOURCES, type HelpSource } from './sources.generated';

/**
 * La ayuda entera, leída una vez por proceso.
 *
 * Un artículo roto no tumba la ayuda: se salta y se registra en `problems`
 * (la prueba de frontmatter es la que falla en CI). En producción es mejor
 * enseñar 24 artículos que ninguno.
 */

interface Corpus {
  articles: HelpArticle[];
  bySlug: Map<string, HelpArticle>;
  index: HelpIndex;
  problems: string[];
}

let cached: Corpus | null = null;

export function loadHelpCorpus(sources: readonly HelpSource[] = HELP_SOURCES): Corpus {
  const articles: HelpArticle[] = [];
  const problems: string[] = [];
  for (const source of sources) {
    try {
      articles.push(parseHelpArticle(source.file, source.raw));
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  articles.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'es'));
  return {
    articles,
    bySlug: new Map(articles.map((a) => [a.slug, a])),
    index: buildHelpIndex(articles),
    problems,
  };
}

function corpus(): Corpus {
  cached ??= loadHelpCorpus();
  return cached;
}

/** Todos los artículos válidos, en orden de lectura. */
export function helpArticles(): readonly HelpArticle[] {
  return corpus().articles;
}

export function helpArticle(slug: string): HelpArticle | null {
  return corpus().bySlug.get(slug) ?? null;
}

export function helpIndex(): HelpIndex {
  return corpus().index;
}

/** Los artículos que no se pudieron leer, con el porqué. */
export function helpProblems(): readonly string[] {
  return corpus().problems;
}
