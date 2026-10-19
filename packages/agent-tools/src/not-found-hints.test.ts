import { describe, expect, it } from 'vitest';
import { platformSourceMatches, renderNameHints } from './not-found-hints';

const SOURCES = [
  { id: 'cortex.ventas', name: 'Ventas facturadas' },
  { id: 'cortex.pagos', name: 'Pagos recibidos' },
  { id: 'cortex.cartera', name: 'Cartera' },
];

describe('pistas cuando un nombre no existe', () => {
  it('«pagos» y «ventas» son fuentes de la plataforma', () => {
    expect(platformSourceMatches('pagos', SOURCES).map((s) => s.id)).toEqual(['cortex.pagos']);
    expect(platformSourceMatches('cortex.ventas', SOURCES).map((s) => s.id)).toEqual([
      'cortex.ventas',
    ]);
    expect(platformSourceMatches('xx', SOURCES)).toEqual([]);
  });

  it('explica cómo leer una fuente y no la manda a trackers_query', () => {
    const text = renderNameHints('tabla', {
      platform: [{ id: 'cortex.ventas', name: 'Ventas facturadas' }],
      tables: [],
      views: [],
      apps: [],
    });
    expect(text).toContain('FUENTE de la plataforma');
    expect(text).toContain('views_create');
    expect(text).toContain('No se lee con trackers_query');
  });

  it('una vista pedida como app se señala como vista', () => {
    const text = renderNameHints('aplicación', {
      platform: [],
      tables: [],
      views: [{ slug: 'indicadores_financieros', name: 'Indicadores financieros' }],
      apps: [],
    });
    expect(text).toContain('VISTA');
    expect(text).toContain('views_get');
  });

  it('no repite el tipo que ya se buscó y no dice nada si no hay pistas', () => {
    const text = renderNameHints('tabla', {
      platform: [],
      tables: [{ slug: 'pagos', name: 'Pagos' }],
      views: [],
      apps: [],
    });
    expect(text).toBe('');
  });
});
