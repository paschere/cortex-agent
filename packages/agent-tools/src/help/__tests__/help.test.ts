import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTool } from '../../registry';
import '../tools';
import { HelpArticleError, articleSection, parseHelpArticle } from '../article';
import { helpArticles, helpIndex, helpProblems, loadHelpCorpus } from '../corpus';
import {
  articlesForRoute,
  bestExcerpt,
  buildHelpIndex,
  foldText,
  routeMatchLength,
  searchHelp,
  tokenize,
} from '../search';
import { HELP_SOURCES } from '../sources.generated';
import { helpSearchResult } from '../tools';

const CONTENT = fileURLToPath(new URL('../../../../../apps/web/content/ayuda/', import.meta.url));

const top = (query: string, enabled?: ReadonlySet<string>) =>
  searchHelp(helpIndex(), query, { enabled, limit: 3 }).map((h) => h.article.slug);

describe('los artículos', () => {
  it('el archivo generado es copia exacta del Markdown (corre scripts/build-help-index.mjs)', () => {
    const files = readdirSync(CONTENT)
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(HELP_SOURCES.map((s) => s.file)).toEqual(files);
    for (const source of HELP_SOURCES) {
      const disk = readFileSync(join(CONTENT, source.file), 'utf8').replace(/\r\n/g, '\n');
      expect(source.raw, source.file).toBe(disk);
    }
  });

  it('todos se leen sin problemas y hay al menos 25', () => {
    expect(helpProblems()).toEqual([]);
    expect(helpArticles().length).toBeGreaterThanOrEqual(25);
  });

  it('cada uno trae los pasos, el reparto Cortex/tú y los problemas comunes', () => {
    for (const article of helpArticles()) {
      expect(articleSection(article, 'Paso a paso'), article.slug).toBeTruthy();
      expect(articleSection(article, 'Qué hace Cortex y qué haces tú'), article.slug).toBeTruthy();
      expect(articleSection(article, 'Problemas comunes'), article.slug).toBeTruthy();
    }
  });

  it('los enlaces a otros artículos apuntan a artículos que existen', () => {
    const slugs = new Set(helpArticles().map((a) => a.slug));
    const broken: string[] = [];
    for (const article of helpArticles()) {
      for (const m of article.body.matchAll(/\]\(\/ayuda\/([a-z0-9-]+)\)/g)) {
        const target = m[1] ?? '';
        if (target !== 'soporte' && !slugs.has(target)) broken.push(`${article.slug} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('el frontmatter', () => {
  const ok = (extra = '') =>
    `---\ntitle: Algo\nsummary: Para qué sirve.\ncategory: plata\nmodule: payables\nroute: /pagar\n${extra}keywords: [a, b]\nupdated: 2026-10-03\n---\n\n${'Texto. '.repeat(40)}`;

  it('lee listas, módulo y orden', () => {
    const a = parseHelpArticle('x/por-pagar.md', ok('routes: [/pagar, /finance]\norder: 2\n'));
    expect(a.slug).toBe('por-pagar');
    expect(a.module).toBe('payables');
    expect(a.routes).toEqual(['/finance']);
    expect(a.keywords).toEqual(['a', 'b']);
    expect(a.order).toBe(2);
  });

  it('rechaza un módulo que no está en el catálogo', () => {
    expect(() => parseHelpArticle('m.md', ok().replace('payables', 'nomina_magica'))).toThrow(
      HelpArticleError,
    );
  });

  it('rechaza rutas raras, fechas mal escritas y campos que faltan', () => {
    expect(() => parseHelpArticle('r.md', ok().replace('/pagar', 'pagar'))).toThrow(/ruta/);
    expect(() => parseHelpArticle('d.md', ok().replace('2026-10-03', '3/10/2026'))).toThrow(
      /fecha/,
    );
    expect(() => parseHelpArticle('t.md', ok().replace('title: Algo\n', ''))).toThrow(/title/);
    expect(() => parseHelpArticle('n.md', 'sin frontmatter')).toThrow(/frontmatter/);
  });

  it('un artículo roto no tumba los demás', () => {
    const corpus = loadHelpCorpus([
      { file: 'bueno.md', raw: ok() },
      { file: 'malo.md', raw: 'nada' },
    ]);
    expect(corpus.articles.map((a) => a.slug)).toEqual(['bueno']);
    expect(corpus.problems[0]).toMatch(/malo\.md/);
  });
});

describe('la búsqueda', () => {
  it('dobla tildes pero respeta la eñe', () => {
    expect(foldText('Conexión DIAN Año')).toBe('conexion dian año');
    expect(tokenize('¿Cómo conecto Siigo?')).toEqual(tokenize('como conectar siigo'));
  });

  it('contesta las preguntas de siempre con el artículo correcto', () => {
    expect(top('¿cómo conecto Siigo?')[0]).toBe('programas-contables');
    expect(top('subir extracto bancolombia')[0]).toBe('extractos-bancarios');
    expect(top('vincular whatsapp')[0]).toBe('whatsapp-vincular');
    expect(top('soat poliza vence')[0]).toBe('documentos-que-vencen');
    expect(top('captcha dian firma')).toContain('navegador-y-tramites');
    expect(top('conectar gmail calendario')[0]).toBe('conectar-google-outlook');
    expect(top('factura proveedor por pagar')[0]).toBe('por-pagar');
  });

  it('da lo mismo con o sin tildes', () => {
    expect(top('proyeccion de caja')).toEqual(top('proyección de caja'));
    expect(top('proyeccion de caja')[0]).toBe('finanzas-y-proyeccion-de-caja');
  });

  it('esconde los artículos de un módulo apagado', () => {
    const withInventory = top('inventario bodega', new Set(['inventory']));
    expect(withInventory[0]).toBe('inventario');
    expect(top('inventario bodega', new Set())).not.toContain('inventario');
  });

  it('una consulta sin palabras con significado no devuelve nada', () => {
    expect(top('¿cómo de la?')).toEqual([]);
  });

  it('el título pesa más que una mención de pasada', () => {
    const make = (slug: string, title: string, body: string) =>
      parseHelpArticle(
        `${slug}.md`,
        `---\ntitle: ${title}\nsummary: Resumen.\ncategory: plata\nmodule: general\nroute: /x\nkeywords: [k]\nupdated: 2026-10-03\n---\n\n${body}${' relleno'.repeat(60)}`,
      );
    const index = buildHelpIndex([
      make('menciona', 'Otra cosa', 'Aquí se nombra el extracto una vez.'),
      make('titulo', 'Subir el extracto', 'Cómo se sube.'),
    ]);
    expect(searchHelp(index, 'extracto')[0]?.article.slug).toBe('titulo');
  });

  it('el extracto sale del párrafo que más casa', () => {
    const article = helpArticles().find((a) => a.slug === 'programas-contables');
    expect(article).toBeTruthy();
    if (article) expect(foldText(bestExcerpt(article, 'siigo'))).toContain('siigo');
  });
});

describe('la ayuda de la pantalla abierta', () => {
  it('casa por segmento, no por prefijo de texto', () => {
    expect(routeMatchLength('/pagar', '/pagar')).toBe(6);
    expect(routeMatchLength('/pagar/123', '/pagar')).toBe(6);
    expect(routeMatchLength('/pagares', '/pagar')).toBe(0);
    expect(routeMatchLength('/pagar?x=1', '/pagar')).toBe(6);
  });

  it('gana la ruta más específica', () => {
    const slugs = articlesForRoute(helpArticles(), '/integrations/whatsapp/atencion', {
      enabled: new Set(['whatsapp_service']),
    }).map((a) => a.slug);
    expect(slugs[0]).toBe('whatsapp-atencion');
    expect(slugs).toContain('whatsapp-vincular');
  });

  it('la pantalla principal va antes que una mención', () => {
    const slugs = articlesForRoute(helpArticles(), '/integrations').map((a) => a.slug);
    expect(slugs.slice(0, 2).sort()).toEqual(['conectar-google-outlook', 'programas-contables']);
  });

  it('cada pantalla con módulo trae su artículo', () => {
    const all = new Set(['payables', 'sales', 'inventory', 'taxes', 'finance', 'doc_expirations']);
    expect(articlesForRoute(helpArticles(), '/pagar', { enabled: all })[0]?.slug).toBe('por-pagar');
    expect(articlesForRoute(helpArticles(), '/impuestos', { enabled: all })[0]?.slug).toBe(
      'impuestos',
    );
    // Con el módulo apagado su artículo no sale; los generales que mencionan
    // la pantalla, sí.
    const off = articlesForRoute(helpArticles(), '/pagar', { enabled: new Set() });
    expect(off.map((a) => a.slug)).not.toContain('por-pagar');
    expect(off.every((a) => a.module === 'general')).toBe(true);
  });
});

describe('help.search', () => {
  it('está registrada, es de sólo lectura y no pide confirmación', () => {
    const tool = getTool('help.search');
    expect(tool).toBeTruthy();
    expect(tool?.requiresConfirmation).toBeFalsy();
  });

  it('devuelve enlaces, la pantalla y los pasos del mejor artículo', () => {
    const out = helpSearchResult({ query: '¿cómo conecto Siigo?' }, undefined);
    expect(out.articles[0]?.slug).toBe('programas-contables');
    expect(out.articles[0]?.url).toBe('/ayuda/programas-contables');
    expect(out.articles[0]?.screen).toBe('/integrations');
    expect(out.articles[0]?.steps).toMatch(/^1\./);
    expect(out.articles[1]?.steps).toBeUndefined();
    expect(out.guidance).toMatch(/help articles only/);
  });

  it('sin resultados lo dice y manda a soporte', () => {
    const out = helpSearchResult({ query: 'xyzzy qwerty' }, undefined);
    expect(out.articles).toEqual([]);
    expect(out.guidance).toMatch(/\/ayuda\/soporte/);
  });

  it('la ruta completa la búsqueda sin repetir', () => {
    const out = helpSearchResult(
      { query: 'aprobar factura', route: '/pagar', limit: 5 },
      undefined,
    );
    const slugs = out.articles.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('por-pagar');
  });

  it('respeta los módulos apagados', () => {
    const out = helpSearchResult({ route: '/inventario' }, new Set());
    expect(out.articles.map((a) => a.slug)).not.toContain('inventario');
  });

  it('sin consulta ni ruta ofrece por dónde empezar', () => {
    const out = helpSearchResult({}, undefined);
    expect(out.articles[0]?.slug).toBe('primeros-pasos');
  });
});
