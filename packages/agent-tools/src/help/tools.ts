import { z } from 'zod';
import { registerTool } from '../registry';
import { type HelpArticle, articleSection } from './article';
import { helpArticles, helpIndex } from './corpus';
import { helpEnabledModules } from './modules';
import { type HelpIndex, articlesForRoute, bestExcerpt, searchHelp } from './search';

/**
 * help.search — Cortex como guía de sí mismo.
 *
 * «¿Cómo conecto Siigo?», «¿dónde subo el extracto?», «¿qué es el piloto
 * automático?»: preguntas sobre CÓMO USAR Cortex, no sobre los datos de la
 * empresa. Se contestan con los artículos de /ayuda (Markdown versionado en
 * el repo), nunca de memoria: el modelo no sabe qué botones tiene la pantalla.
 *
 * Sólo lectura, sin red y sin base salvo una lectura de los módulos encendidos
 * (un artículo de un módulo apagado no se ofrece).
 */

const MAX_STEPS_CHARS = 1_800;

const articleOut = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  /** El artículo en el centro de ayuda. */
  url: z.string(),
  /** La pantalla del producto de la que habla. */
  screen: z.string(),
  excerpt: z.string(),
  /** El «Paso a paso» del primer resultado, en Markdown. */
  steps: z.string().optional(),
});

export type HelpSearchArticle = z.infer<typeof articleOut>;

export interface HelpSearchOutput {
  articles: HelpSearchArticle[];
  guidance: string;
}

/** Arma la salida. Pura, para probarla sin registro ni base. */
export function helpSearchResult(
  input: { query?: string; route?: string; limit?: number },
  enabled: ReadonlySet<string> | undefined,
  corpus: { articles: readonly HelpArticle[]; index: HelpIndex } = {
    articles: helpArticles(),
    index: helpIndex(),
  },
): HelpSearchOutput {
  const { articles, index } = corpus;
  const limit = input.limit ?? 4;
  const query = input.query?.trim() ?? '';
  const route = input.route?.trim() ?? '';

  let found: HelpArticle[] = [];
  if (query) {
    found = searchHelp(index, query, { limit, enabled }).map((hit) => hit.article);
  }
  if (route) {
    // La pantalla abierta desempata y completa: lo que casa con la ruta va
    // detrás de lo que casa con la pregunta, sin repetir.
    const byRoute = articlesForRoute(articles, route, { enabled, limit });
    const seen = new Set(found.map((a) => a.slug));
    found = [...found, ...byRoute.filter((a) => !seen.has(a.slug))].slice(0, limit);
  }
  if (!query && !route) {
    found = articles.filter((a) => a.category === 'empezar').slice(0, limit);
  }

  const out = found.map((article, i) => {
    const steps = i === 0 ? articleSection(article, 'Paso a paso') : null;
    return {
      slug: article.slug,
      title: article.title,
      summary: article.summary,
      url: `/ayuda/${article.slug}`,
      screen: article.route,
      excerpt: bestExcerpt(article, query || article.title),
      ...(steps
        ? {
            steps: steps.length > MAX_STEPS_CHARS ? `${steps.slice(0, MAX_STEPS_CHARS)}…` : steps,
          }
        : {}),
    };
  });

  const guidance =
    out.length > 0
      ? 'Answer from these help articles only, in plain Spanish, as short steps. Link the article as [Título](url) and the screen as a link to `screen`. Do not invent buttons or screens the articles do not mention. If the person wants to do it now and a tool can, offer to do it.'
      : 'No help article covers this. Say so plainly, do not improvise how the product works, and offer «Escribir a soporte» at [/ayuda/soporte](/ayuda/soporte).';

  return { articles: out, guidance };
}

export const helpSearch = registerTool({
  id: 'help.search',
  description:
    'How to USE Cortex itself — the in-app help center (/ayuda). Call it for questions about the product, not about company data: «¿cómo conecto Siigo?», «¿dónde subo el extracto del banco?», «¿qué es el piloto automático?», «¿cómo vinculo WhatsApp?», «¿cómo invito a alguien?», «¿qué hace la Bandeja vs el Cerebro?», «¿por qué no puedo radicar en la DIAN?», «¿cuánto cuesta el plan?». Returns the matching help articles with a link (/ayuda/<slug>), the screen they are about, an excerpt and the step-by-step of the best one. Pass `route` (the screen the person is on, e.g. "/pagar") to bias toward that screen. Answer only from what it returns, with the links; if nothing matches, say so and point to «Escribir a soporte».',
  inputSchema: z.object({
    query: z
      .string()
      .max(300)
      .optional()
      .describe('The question in the person’s words, e.g. «cómo conecto Siigo»'),
    route: z
      .string()
      .max(200)
      .optional()
      .describe('The product screen the question is about, e.g. "/integrations"'),
    limit: z.number().int().min(1).max(8).default(4),
  }),
  outputSchema: z.object({
    articles: z.array(articleOut),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    const enabled = await helpEnabledModules(ctx.db);
    return helpSearchResult(input, enabled);
  },
});
