/**
 * La ayuda de Cortex: artículos en Markdown (apps/web/content/ayuda), su
 * búsqueda en memoria y `help.search` para que el chat conteste «¿cómo uso
 * Cortex?» con los mismos artículos que se leen en /ayuda.
 *
 * Barril estrecho y con nombres propios (el resto del paquete comparte raíz).
 */

// Registro de la herramienta (por importarla).
export { helpSearch, helpSearchResult } from './tools';
export type { HelpSearchArticle, HelpSearchOutput } from './tools';

export {
  HELP_CATEGORIES,
  HELP_CATEGORY_LABEL,
  articleLead as helpArticleLead,
  articleRoutes as helpArticleRoutes,
  articleSection as helpArticleSection,
  isArticleVisible as isHelpArticleVisible,
  parseHelpArticle,
} from './article';
export type { HelpArticle, HelpCategory, HelpModule } from './article';
export { helpArticle, helpArticles, helpIndex, helpProblems, loadHelpCorpus } from './corpus';
export { helpEnabledModules } from './modules';
export {
  articlesForRoute as helpArticlesForRoute,
  bestExcerpt as helpExcerpt,
  buildHelpIndex,
  foldText as foldHelpText,
  routeMatchLength as helpRouteMatchLength,
  searchHelp,
} from './search';
export type { HelpHit } from './search';
