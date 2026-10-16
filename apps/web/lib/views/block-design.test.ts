import { describe, expect, it } from 'vitest';
import { designAttrs, heroInkFor } from './block-design';

describe('block-design', () => {
  it('sin design no pone atributos de superficie', () => {
    expect(designAttrs('metric', undefined)).toEqual({ className: 'view-surf', data: {} });
  });
  it('traduce el design a atributos', () => {
    const a = designAttrs('metric', { surface: 'hero', tone: 'rose', height: 'tall', emphasis: 'strong', title: 'hidden', variant: 'ring' });
    expect(a.data).toMatchObject({
      'data-surface': 'hero',
      'data-tone': 'rose',
      'data-height': 'tall',
      'data-emphasis': 'strong',
      'data-title': 'hidden',
      'data-hero-ink': 'light',
      'data-variant': 'ring',
    });
  });
  it('elige tinta clara u oscura para el hero', () => {
    expect(heroInkFor('255 255 255')).toBe('light');
    expect(heroInkFor('20 20 20')).toBe('dark');
    expect(heroInkFor(undefined)).toBe('light');
  });
});
