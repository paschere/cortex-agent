import { afterEach, describe, expect, it } from 'vitest';
import { forbiddenTargetReason } from '../live-target';

/**
 * El piso SSRF, fijado. Estas respuestas están duplicadas a mano en
 * services/browser/src/target.ts (el archivo dice por qué); si cambias una
 * regla allá y este test no se tocó, esta lista es la que grita.
 */
describe('a dónde el navegador se niega a ir', () => {
  afterEach(() => {
    delete process.env.BROWSER_ALLOW_PRIVATE_HOSTS;
  });

  it('deja pasar los sitios públicos, que son el trabajo', () => {
    expect(forbiddenTargetReason('https://www.runt.gov.co/consultas')).toBeNull();
    expect(forbiddenTargetReason('https://es.wikipedia.org/wiki/Bogotá')).toBeNull();
    expect(forbiddenTargetReason('http://portal-viejo-sin-tls.gov.co')).toBeNull();
  });

  it('bloquea metadata bajo TODA configuración: no hay variable que lo abra', () => {
    process.env.BROWSER_ALLOW_PRIVATE_HOSTS = 'true';
    expect(forbiddenTargetReason('http://169.254.169.254/latest/meta-data')).not.toBeNull();
    expect(
      forbiddenTargetReason('http://metadata.google.internal/computeMetadata/v1/'),
    ).not.toBeNull();
    expect(forbiddenTargetReason('http://100.100.100.200/')).not.toBeNull();
  });

  it('bloquea lo privado por defecto: loopback, RFC1918, link-local, *.internal', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1:8080/admin',
      'http://10.0.0.5/',
      'http://172.20.1.1/',
      'http://192.168.1.1/router',
      'http://postgres.railway.internal:5432',
      'http://[::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(forbiddenTargetReason(url), url).not.toBeNull();
    }
  });

  it('lo privado se abre con la variable — para la intranet legítima de alguien', () => {
    process.env.BROWSER_ALLOW_PRIVATE_HOSTS = 'true';
    expect(forbiddenTargetReason('http://192.168.1.50/portal-interno')).toBeNull();
  });

  it('solo http y https: file, ftp y chrome no son sitios', () => {
    expect(forbiddenTargetReason('file:///etc/passwd')).not.toBeNull();
    expect(forbiddenTargetReason('chrome://settings')).not.toBeNull();
    expect(forbiddenTargetReason('no es una url')).not.toBeNull();
  });

  it('la frase no revela topología: dice privado, nunca qué hay ahí', () => {
    const reason = forbiddenTargetReason('http://10.0.0.5/');
    expect(reason).toMatch(/privada/);
    expect(reason).not.toMatch(/10\.0\.0\.5/);
  });
});
