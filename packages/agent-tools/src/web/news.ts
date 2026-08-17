import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';

/**
 * BÚSQUEDA DE NOTICIAS, COMO HERRAMIENTA PROPIA Y NO COMO UN TRUCO DE QUERY.
 *
 * `web.search` ya existe y el modelo podía escribir «noticias de X» ahí, pero
 * eso mezcla dos preguntas distintas: «¿qué se sabe de X?» (la web entera,
 * atemporal) y «¿qué HA PASADO con X?» (medios, con fecha, reciente). Tavily
 * las separa con `topic: "news"` — indexa fuentes de prensa y devuelve fecha
 * de publicación, que la búsqueda general no trae — y una herramienta aparte
 * es lo que deja al planificador y al ranking semántico elegir bien: «noticias
 * recientes sobre X-Cargo en medios colombianos» debe caer aquí, no en el
 * buscador general que contesta con la página corporativa de hace dos años.
 *
 * Mismo proveedor y misma llave que web.search: cero costo nuevo de
 * integración, mismo tier gratuito (~1000 búsquedas/mes compartidas).
 */
export const webNews = registerTool({
  id: 'web.news',
  description:
    'Search recent NEWS coverage (press, media outlets) with Tavily news mode. Returns dated articles: title, source URL, published date, and snippet. Use for "recent news about X", press mentions, announcements, market events — anything where WHEN it was published matters. For general web lookup use web.search instead.',
  inputSchema: z.object({
    query: z.string().min(1),
    /** Ventana hacia atrás en días. 7 por defecto: «noticias» sin más contexto significa «esta semana». */
    days: z.number().int().min(1).max(365).default(7),
    maxResults: z.number().int().min(1).max(10).default(6),
    includeAnswer: z.boolean().default(true),
  }),
  outputSchema: z.object({
    answer: z.string().nullable(),
    articles: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        /** ISO o lo que el medio declare; null cuando la fuente no la trae. */
        publishedDate: z.string().nullable(),
        content: z.string(),
        score: z.number().nullable(),
      }),
    ),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new IntegrationError('TAVILY_API_KEY not configured', 'web');

    type TavilyResult = {
      title?: string;
      url?: string;
      content?: string;
      score?: number;
      published_date?: string;
    };
    type TavilyResponse = { answer?: string; results?: TavilyResult[] };

    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: input.query,
        topic: 'news',
        days: input.days,
        max_results: input.maxResults,
        include_answer: input.includeAnswer,
      }),
      signal: ctx.signal,
    });
    if (!r.ok) throw new IntegrationError(`Tavily ${r.status}: ${await r.text()}`, 'web');

    const data = (await r.json()) as TavilyResponse;
    return {
      answer: data.answer ?? null,
      articles: (data.results ?? []).map((res) => ({
        title: res.title ?? '',
        url: res.url ?? '',
        publishedDate: res.published_date ?? null,
        content: res.content ?? '',
        score: res.score ?? null,
      })),
    };
  },
});
