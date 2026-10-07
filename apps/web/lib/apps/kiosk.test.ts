import { describe, expect, it } from 'vitest';
import { isCacheablePath, precacheUrlsOf, staleCaches, userCacheName } from './offline-cache';
import { previewAttributesOf, previewQuery } from './preview-query';
import { buildAppServiceWorker } from './service-worker-source';

/**
 * Lo del modo kiosco y el portal que vive en el navegador y el worker (fase 4):
 * el caché por persona al cambiar de persona en un mismo celular, la primera
 * pantalla guardada al instalar sin mezclar usuarios, y la dirección de
 * «Ver como… cliente X».
 */

const APP = '11111111-1111-4111-8111-111111111111';
const ANA = 'e0000000-0000-4000-8000-00000000a001';
const BETO = 'e0000000-0000-4000-8000-00000000b002';

describe('kiosco: el caché del worker sigue a la persona, no al celular', () => {
  it('al entrar Beto en el celular de Ana, la caché de Ana sobra y la de Beto no', () => {
    const names = [userCacheName(APP, ANA), userCacheName(APP, BETO), `cortex-app-${APP}-shell-v1`];
    expect(staleCaches(APP, BETO, names)).toEqual([userCacheName(APP, ANA)]);
    expect(staleCaches(APP, ANA, names)).toEqual([userCacheName(APP, BETO)]);
  });

  it('al volver a la lista de nombres (cambiar de persona o por inactividad) se borran TODAS las de la app, y las de otra app no', () => {
    const otra = '22222222-2222-4222-8222-222222222222';
    const names = [userCacheName(APP, ANA), userCacheName(APP, BETO), userCacheName(otra, ANA)];
    expect(staleCaches(APP, null, names).sort()).toEqual(
      [userCacheName(APP, ANA), userCacheName(APP, BETO)].sort(),
    );
  });

  it('el worker borra lo de todos al recibir «signout» y deja sólo lo de quien entra con «who»', () => {
    const src = buildAppServiceWorker(APP);
    expect(src).toContain("data.type === 'signout'");
    expect(src).toContain('setCurrentUser(null)');
    expect(src).toContain('staleCaches(APP, userKey, await caches.keys())');
  });
});

describe('instalar: la primera pantalla queda guardada, de ESA persona', () => {
  it('precachea la pantalla de inicio y sus datos, y sólo direcciones guardables de esta app', () => {
    const urls = precacheUrlsOf(APP, 'mis_pedidos');
    expect(urls).toEqual([
      `/a/${APP}/mis_pedidos`,
      `/api/apps/public/${APP}/screens/mis_pedidos/data`,
    ]);
    for (const u of urls) expect(isCacheablePath(APP, u)).toBe(true);
  });

  it('un slug raro o vacío no precachea nada (nada de rutas inventadas)', () => {
    expect(precacheUrlsOf(APP, null)).toEqual([]);
    expect(precacheUrlsOf(APP, '')).toEqual([]);
    expect(precacheUrlsOf(APP, '../otra')).toEqual([]);
    expect(precacheUrlsOf(APP, 'a.b')).toEqual([]);
  });

  it('el worker guarda ese precaché en la caché del usuario que está dentro y vuelve a validar cada dirección', () => {
    const src = buildAppServiceWorker(APP);
    expect(src).toContain('data.precache');
    expect(src).toContain('userCacheName(APP, userKey)');
    // Cada dirección se revisa con la misma regla que el resto: sólo de esta app y guardable.
    expect(src).toMatch(/isCacheablePath\(APP, url\.pathname\)\) continue/);
    // Sin saber quién es (`userKey` nulo) no se guarda nada.
    expect(src).toContain('if (userKey && Array.isArray(data.precache))');
  });
});

describe('«Ver como… cliente X»', () => {
  it('arma la dirección con el rol y los atributos', () => {
    expect(previewQuery('cliente', { cliente: 'Andina SAS' })).toBe(
      '?como=cliente&atr=cliente%3AAndina%20SAS',
    );
    expect(previewQuery('operario')).toBe('?como=operario');
  });

  it('lee los atributos de vuelta, acotados y sin claves raras', () => {
    expect(previewAttributesOf(['cliente:Andina SAS', 'sede:Norte'])).toEqual({
      cliente: 'Andina SAS',
      sede: 'Norte',
    });
    expect(previewAttributesOf('cliente:Andina')).toEqual({ cliente: 'Andina' });
    expect(previewAttributesOf(undefined)).toEqual({});
    // Clave inválida, sin valor o con dos puntos en el valor.
    expect(previewAttributesOf(['Cliente:x', ':x', 'a:', 'zona:Norte:Sur'])).toEqual({
      zona: 'Norte:Sur',
    });
    expect(
      Object.keys(previewAttributesOf(Array.from({ length: 20 }, (_, i) => `k${i}:v`))).length,
    ).toBe(6);
    expect(previewAttributesOf(`cliente:${'x'.repeat(121)}`)).toEqual({});
  });
});
