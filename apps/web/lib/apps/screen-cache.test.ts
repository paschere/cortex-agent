import { describe, expect, it } from 'vitest';
import {
  LISTS_PER_APP,
  SCREENS_PER_APP,
  SCREEN_MAX_AGE_MS,
  isListEntry,
  isUsable,
  listEntryName,
  pickScreen,
  savedLabel,
  screenCacheKey,
  screensToDrop,
} from './screen-cache';

const NOW = 1_800_000_000_000;
const meta = (appKey: string, userKey: string, screen: string, savedAt = NOW - 1000) => ({
  key: screenCacheKey(appKey, userKey, screen),
  appKey,
  userKey,
  screen,
  savedAt,
});

describe('copias de pantallas sin señal', () => {
  it('la llave lleva app, persona y pantalla', () => {
    expect(screenCacheKey('planta', 'u1', 'envios')).toBe('planta|u1|envios');
  });

  it('caduca a los 7 días y no confía en horas del futuro', () => {
    expect(isUsable(NOW - 1000, NOW)).toBe(true);
    expect(isUsable(NOW - SCREEN_MAX_AGE_MS - 1, NOW)).toBe(false);
    expect(isUsable(NOW + 10 * 60_000, NOW)).toBe(false);
    expect(isUsable(Number.NaN, NOW)).toBe(false);
  });

  it('dice «guardado hace X»', () => {
    expect(savedLabel(NOW - 12 * 60_000, NOW)).toBe('guardado hace 12 minutos');
    expect(savedLabel(NOW - 5_000, NOW)).toBe('guardado hace un momento');
  });

  it('NUNCA muestra la copia de otra persona', () => {
    const all = [meta('planta', 'ana', 'envios'), meta('planta', 'luis', 'envios')];
    expect(pickScreen(all, { appKey: 'planta', userKey: 'luis' }, 'envios', NOW)?.userKey).toBe(
      'luis',
    );
    expect(pickScreen(all, { appKey: 'planta', userKey: 'otra' }, 'envios', NOW)).toBeNull();
  });

  it('ni la de otra app, ni una caducada', () => {
    const all = [
      meta('otra', 'ana', 'envios'),
      meta('planta', 'ana', 'viejo', NOW - SCREEN_MAX_AGE_MS - 5),
    ];
    expect(pickScreen(all, { appKey: 'planta', userKey: 'ana' }, 'envios', NOW)).toBeNull();
    expect(pickScreen(all, { appKey: 'planta', userKey: 'ana' }, 'viejo', NOW)).toBeNull();
  });

  it('al entrar otra persona se borran las copias de las demás (de cualquier app) y las caducadas', () => {
    const all = [
      meta('planta', 'ana', 'a'),
      meta('otra', 'ana', 'b'),
      meta('planta', 'luis', 'c'),
      meta('planta', 'luis', 'vieja', NOW - SCREEN_MAX_AGE_MS - 1),
    ];
    expect(screensToDrop(all, { appKey: 'planta', userKey: 'luis' }, NOW).sort()).toEqual(
      [all[0], all[1], all[3]].map((s) => (s as { key: string }).key).sort(),
    );
  });

  it('conserva sólo las últimas pantallas de la app', () => {
    const all = Array.from({ length: SCREENS_PER_APP + 3 }, (_, i) =>
      meta('planta', 'ana', `p${i}`, NOW - i * 1000),
    );
    const dropped = screensToDrop(all, { appKey: 'planta', userKey: 'ana' }, NOW);
    expect(dropped).toHaveLength(3);
    // Las que sobran son las más viejas.
    expect(dropped).toContain(screenCacheKey('planta', 'ana', `p${SCREENS_PER_APP + 2}`));
    expect(dropped).not.toContain(screenCacheKey('planta', 'ana', 'p0'));
  });

  it('las listas de opciones no le quitan sitio a las pantallas y tienen su propio tope', () => {
    const screens = Array.from({ length: SCREENS_PER_APP }, (_, i) =>
      meta('planta', 'ana', `p${i}`, NOW - i * 1000),
    );
    const lists = Array.from({ length: LISTS_PER_APP + 2 }, (_, i) =>
      meta('planta', 'ana', listEntryName(`/api/x/relation?field=${i}`), NOW - i * 1000),
    );
    const dropped = screensToDrop([...screens, ...lists], { appKey: 'planta', userKey: 'ana' }, NOW);
    expect(dropped).toHaveLength(2);
    expect(dropped.every((k) => k.includes('list:'))).toBe(true);
    expect(isListEntry(listEntryName('/a'))).toBe(true);
    expect(isListEntry('envios')).toBe(false);
  });

  it('las listas de otra persona también se borran', () => {
    const mine = meta('planta', 'ana', listEntryName('/a'));
    const theirs = meta('planta', 'luis', listEntryName('/a'));
    expect(screensToDrop([mine, theirs], { appKey: 'planta', userKey: 'ana' }, NOW)).toEqual([
      theirs.key,
    ]);
  });
});
