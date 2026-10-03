import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULES,
  MODULE_KEYS,
  helpArticleRoutes,
  helpArticles,
  helpProblems,
  moduleForRoute,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { everyDestination } from '../nav-shape';
import { askCortexHref, defaultQuestion, screenLabel } from './shape';

/**
 * LA AYUDA APUNTA A PANTALLAS QUE EXISTEN.
 *
 * Un artículo que manda a «Ir a Por pagar» con una ruta vieja es peor que no
 * tener artículo: la persona hace caso y llega a un 404. Cada `route`/`routes`
 * del frontmatter tiene que ser un destino del menú, la ruta de un módulo del
 * catálogo o, al menos, una carpeta con `page.tsx`. Y un artículo marcado con
 * un módulo tiene que hablar de la pantalla de ese módulo, o se escondería por
 * el interruptor equivocado.
 */

const APP = fileURLToPath(new URL('../../app/', import.meta.url));

function hasPage(route: string): boolean {
  return ['(app)', '(chat)'].some((group) => existsSync(join(APP, group, route, 'page.tsx')));
}

const NAV = new Set(everyDestination());
const MODULE_ROUTES = new Set(MODULES.flatMap((m) => m.routes));

describe('el frontmatter de cada artículo', () => {
  it('se lee completo', () => {
    expect(helpProblems()).toEqual([]);
    expect(helpArticles().length).toBeGreaterThanOrEqual(25);
  });

  it('cada ruta existe en el menú, en el catálogo de módulos o como página', () => {
    const missing: string[] = [];
    for (const article of helpArticles()) {
      for (const route of helpArticleRoutes(article)) {
        if (!NAV.has(route) && !MODULE_ROUTES.has(route) && !hasPage(route)) {
          missing.push(`${article.slug}: ${route}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('la pantalla principal de cada artículo tiene página de verdad', () => {
    const missing = helpArticles()
      .filter((a) => !hasPage(a.route))
      .map((a) => `${a.slug}: ${a.route}`);
    expect(missing).toEqual([]);
  });

  it('el módulo es del catálogo y gobierna la pantalla principal del artículo', () => {
    const wrong: string[] = [];
    for (const article of helpArticles()) {
      if (article.module === 'general') continue;
      if (!(MODULE_KEYS as readonly string[]).includes(article.module)) {
        wrong.push(`${article.slug}: módulo ${article.module}`);
        continue;
      }
      if (moduleForRoute(article.route)?.key !== article.module) {
        wrong.push(`${article.slug}: ${article.route} no es de ${article.module}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('las pantallas de los módulos encendidos por defecto tienen su artículo', () => {
    // Si un módulo con pantalla real no tiene ni un artículo, el «?» de esa
    // pantalla cae a «Primeros pasos», que no le sirve a nadie allí.
    const covered = new Set(helpArticles().flatMap((a) => helpArticleRoutes(a)));
    const uncovered = MODULES.filter((m) => m.defaultOn)
      .flatMap((m) => m.routes)
      .filter((route) => hasPage(route) && !covered.has(route));
    expect(uncovered).toEqual([]);
  });
});

describe('la ayuda en el navegador', () => {
  it('nombra la pantalla como la barra de arriba', () => {
    expect(screenLabel('/pagar')).toBe('Por pagar');
    expect(screenLabel('/integrations/whatsapp')).toBe('WhatsApp');
    expect(screenLabel('/ayuda/por-pagar')).toBe('Ayuda');
    expect(screenLabel('/no-existe')).toBeNull();
  });

  it('«Pregúntale a Cortex» abre el chat con la pregunta', () => {
    expect(askCortexHref('¿Cómo conecto Siigo?')).toBe(
      `/chat?prompt=${encodeURIComponent('¿Cómo conecto Siigo?')}`,
    );
    expect(defaultQuestion('Por pagar')).toBe('¿Cómo uso Por pagar en Cortex?');
    expect(defaultQuestion(null)).toBe('¿Cómo uso Cortex?');
  });
});
