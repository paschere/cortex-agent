import { describe, expect, it } from 'vitest';
import { decideConsent, withRule } from '../consent';
import { blockedUrlReason, hostInSite, siteOf, siteOfUrl, validSite } from '../domain';

describe('siteOf', () => {
  it('toma el dominio registrable, incluidos los sufijos de dos partes', () => {
    expect(siteOf('www.bancolombia.com')).toBe('bancolombia.com');
    expect(siteOf('sucursalvirtual.bancolombia.com')).toBe('bancolombia.com');
    expect(siteOf('muisca.dian.gov.co')).toBe('dian.gov.co');
    expect(siteOf('empresa.com.co')).toBe('empresa.com.co');
  });
  it('un sufijo público solo nunca es un sitio', () => {
    expect(siteOf('gov.co')).toBeNull();
    expect(siteOf('com.co')).toBeNull();
    expect(siteOf('co')).toBeNull();
    expect(validSite('gov.co')).toBe(false);
    expect(validSite('dian.gov.co')).toBe(true);
  });
  it('rechaza basura', () => {
    expect(siteOf('a b.com')).toBeNull();
    expect(siteOf('exa_mple.com')).toBeNull();
    expect(siteOf('[::1]')).toBeNull();
  });
});

describe('hostInSite', () => {
  it('compara por frontera de etiqueta', () => {
    expect(hostInSite('login.bancolombia.com', 'bancolombia.com')).toBe(true);
    expect(hostInSite('bancolombia.com', 'bancolombia.com')).toBe(true);
    expect(hostInSite('evilbancolombia.com', 'bancolombia.com')).toBe(false);
    expect(hostInSite('bancolombia.com.evil.io', 'bancolombia.com')).toBe(false);
  });
});

describe('blockedUrlReason', () => {
  it('bloquea páginas del navegador, archivos y esquemas raros', () => {
    for (const u of [
      'chrome://settings',
      'chrome-extension://abc/x.html',
      'file:///etc/passwd',
      'about:blank',
      'javascript:alert(1)',
      'view-source:https://a.com',
      'data:text/html,hi',
      'edge://flags',
    ]) {
      expect(blockedUrlReason(u)).toBeTruthy();
    }
  });
  it('bloquea red privada y metadatos', () => {
    for (const u of [
      'http://localhost:3000',
      'http://127.0.0.1/',
      'http://192.168.1.1/admin',
      'http://10.0.0.5',
      'http://169.254.169.254/latest',
      'http://router/',
      'https://nas.local/',
      'http://[::1]/',
    ]) {
      expect(blockedUrlReason(u)).toBeTruthy();
    }
  });
  it('bloquea usuario y clave incrustados', () => {
    expect(blockedUrlReason('https://user:pass@banco.com/')).toBeTruthy();
  });
  it('bloquea el sitio de Cortex mismo y sus subdominios, pero no a quien se le parezca', () => {
    expect(blockedUrlReason('https://app.cortex.test/chat', ['app.cortex.test'])).toBeTruthy();
    expect(blockedUrlReason('https://x.app.cortex.test/', ['app.cortex.test'])).toBeTruthy();
    expect(blockedUrlReason('https://otro.cortex.test/', ['app.cortex.test'])).toBeNull();
    expect(blockedUrlReason('https://notapp.cortex.test/', ['app.cortex.test'])).toBeNull();
  });
  it('deja pasar un sitio normal', () => {
    expect(blockedUrlReason('https://sucursalvirtual.bancolombia.com/inicio')).toBeNull();
  });
});

describe('decideConsent', () => {
  const base = { rules: [], onceSites: [] as string[], protectedSites: ['app.cortex.test'] };
  it('pregunta la primera vez', () => {
    expect(decideConsent({ ...base, url: 'https://www.bancolombia.com/x' })).toEqual({
      kind: 'ask',
      site: 'bancolombia.com',
    });
  });
  it('«siempre» y «solo esta vez» dejan pasar; «nunca» le gana a todo', () => {
    const url = 'https://login.bancolombia.com/';
    expect(
      decideConsent({ ...base, url, rules: [{ site: 'bancolombia.com', decision: 'always' }] }),
    ).toMatchObject({ kind: 'allow', via: 'always' });
    expect(decideConsent({ ...base, url, onceSites: ['bancolombia.com'] })).toMatchObject({
      kind: 'allow',
      via: 'once',
    });
    expect(
      decideConsent({
        ...base,
        url,
        onceSites: ['bancolombia.com'],
        rules: [{ site: 'bancolombia.com', decision: 'never' }],
      }),
    ).toMatchObject({ kind: 'deny', reason: 'never' });
  });
  it('una regla de un sitio no abre otro (ni uno parecido)', () => {
    const rules = [{ site: 'bancolombia.com', decision: 'always' as const }];
    expect(decideConsent({ ...base, url: 'https://bancolombia.com.evil.io/', rules }).kind).toBe(
      'ask',
    );
    expect(decideConsent({ ...base, url: 'https://evilbancolombia.com/', rules }).kind).toBe('ask');
  });
  it('lo bloqueado se niega aunque haya regla «siempre»', () => {
    const rules = [{ site: 'cortex.test', decision: 'always' as const }];
    expect(decideConsent({ ...base, url: 'https://app.cortex.test/', rules }).kind).toBe('deny');
    expect(decideConsent({ ...base, url: 'chrome://settings', rules }).kind).toBe('deny');
  });
  it('withRule reemplaza la regla anterior del sitio', () => {
    const r = withRule([{ site: 'a.com', decision: 'always' }], {
      site: 'a.com',
      decision: 'never',
    });
    expect(r).toEqual([{ site: 'a.com', decision: 'never' }]);
  });
  it('siteOfUrl', () => {
    expect(siteOfUrl('https://muisca.dian.gov.co/x')).toBe('dian.gov.co');
    expect(siteOfUrl('chrome://x')).toBeNull();
  });
});
