import { describe, expect, it } from 'vitest';
import { blockedUrlReason } from '../../../packages/agent-tools/src/browser/chrome/domain';
import { originPattern, protectedHostsOf } from './lib';

describe('lib de la extensión', () => {
  it('el patrón de permiso de Chrome cubre el sitio y sus subdominios, nada más', () => {
    expect(originPattern('bancolombia.com')).toBe('*://*.bancolombia.com/*');
  });

  it('protege la página de Cortex a la que está emparejada la extensión', () => {
    const hosts = protectedHostsOf('https://cortex-vertix.vercel.app');
    expect(hosts).toEqual(['cortex-vertix.vercel.app']);
    expect(blockedUrlReason('https://cortex-vertix.vercel.app/chat', hosts)).toBeTruthy();
    expect(blockedUrlReason('https://otra.vercel.app/', hosts)).toBeNull();
  });

  it('un origen roto no protege nada ni revienta', () => {
    expect(protectedHostsOf('no es url')).toEqual([]);
  });
});
