import { describe, expect, it } from 'vitest';
import { APP_ICON_NAMES, normalizeAppIcon } from './icon-names';

describe('normalizeAppIcon', () => {
  it('deja los nombres de la lista y los emoji', () => {
    expect(normalizeAppIcon('Plane')).toBe('Plane');
    expect(normalizeAppIcon('🚚')).toBe('🚚');
  });
  it('arregla mayúsculas, guiones y parecidos', () => {
    expect(normalizeAppIcon('layout-dashboard')).toBe('LayoutDashboard');
    expect(normalizeAppIcon('clipboard')).toBe('ClipboardList');
    expect(normalizeAppIcon('BarChart')).toBe('BarChart3');
  });
  it('un nombre desconocido nunca se guarda como texto', () => {
    expect(normalizeAppIcon('Rocketship')).toBe('LayoutPanelTop');
    expect(normalizeAppIcon('')).toBe('LayoutPanelTop');
  });
  it('la lista no repite nombres', () => {
    expect(new Set(APP_ICON_NAMES).size).toBe(APP_ICON_NAMES.length);
  });
});
