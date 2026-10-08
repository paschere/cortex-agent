import { describe, expect, it } from 'vitest';
import {
  HEADER_REVEAL_ZONE,
  PULL_MAX,
  cardHref,
  headerHidden,
  parseAppTheme,
  pullDistance,
  pullProgress,
  pullTriggers,
  splitTabs,
} from './app-nav';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `s${i}` }));

describe('barra inferior', () => {
  it('hasta cinco pantallas caben todas', () => {
    expect(splitTabs(mk(5), 's0')).toMatchObject({ more: [], moreActive: false });
    expect(splitTabs(mk(5), 's0').tabs).toHaveLength(5);
    expect(splitTabs(mk(2), 's0').tabs).toHaveLength(2);
  });
  it('con más de cinco: cuatro y «Más», y Más se enciende si la actual quedó adentro', () => {
    const six = splitTabs(mk(8), 's6');
    expect(six.tabs.map((t) => t.slug)).toEqual(['s0', 's1', 's2', 's3']);
    expect(six.more).toHaveLength(4);
    expect(six.moreActive).toBe(true);
    expect(splitTabs(mk(8), 's1').moreActive).toBe(false);
  });
});

describe('cabecera que se esconde', () => {
  it('arriba nunca se esconde', () => {
    expect(headerHidden(0, HEADER_REVEAL_ZONE, true)).toBe(false);
  });
  it('baja de verdad → se esconde; sube → vuelve; un temblor no cambia nada', () => {
    expect(headerHidden(100, 140, false)).toBe(true);
    expect(headerHidden(140, 120, true)).toBe(false);
    expect(headerHidden(140, 143, true)).toBe(true);
    expect(headerHidden(140, 138, false)).toBe(false);
  });
});

describe('tirar para actualizar', () => {
  it('es elástico, con tope, y hacia arriba no cuenta', () => {
    expect(pullDistance(-30)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(100)).toBe(50);
    expect(pullDistance(10_000)).toBe(PULL_MAX);
  });
  it('suelta y refresca sólo pasado el umbral', () => {
    expect(pullTriggers(pullDistance(60))).toBe(false);
    expect(pullTriggers(pullDistance(72))).toBe(true);
    expect(pullProgress(pullDistance(36))).toBeCloseTo(0.5, 1);
    expect(pullProgress(pullDistance(500))).toBe(1);
  });
});

describe('tema por persona', () => {
  it('lo guardado manda; lo raro es «sistema»', () => {
    expect(parseAppTheme('dark')).toBe('dark');
    expect(parseAppTheme('light')).toBe('light');
    expect(parseAppTheme('system')).toBe('system');
    expect(parseAppTheme(null)).toBe('system');
    expect(parseAppTheme('azul')).toBe('system');
  });
});

describe('enlace de una tarjeta', () => {
  it('sin pantalla no hay enlace', () => {
    expect(cardHref('/a/x', '', { screen: null, filter: null })).toBeNull();
  });
  it('lleva la lista filtrada y conserva «Ver como…»', () => {
    expect(cardHref('/a/x', '', { screen: 'guias', filter: null })).toBe('/a/x/guias');
    expect(cardHref('/a/x', '', { screen: 'guias', filter: 'estado=Duplicado' })).toBe(
      '/a/x/guias?f=estado%3DDuplicado',
    );
    expect(
      cardHref('/apps/p', '?como=cliente', { screen: 'guias', filter: 'estado=Duplicado' }),
    ).toBe('/apps/p/guias?como=cliente&f=estado%3DDuplicado');
  });
});
