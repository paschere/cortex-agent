import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Wompi avisa sin cookie y quien pide acceso todavía no tiene cuenta. Si estas
 * rutas salen de PUBLIC_PATHS, el middleware las manda a /login: el aviso de un
 * pago aprobado rebota (307 → 405) y la empresa que pagó sigue en solo lectura.
 *
 * Y al revés: el checkout y /plan NO pueden ser públicos. Se lee SÓLO el array,
 * como shared-links-public-paths.test.ts.
 */
const WEB = fileURLToPath(new URL('../../', import.meta.url));

describe('rutas públicas del cobro y del registro', () => {
  const src = readFileSync(`${WEB}middleware.ts`, 'utf8');
  const block = src.slice(
    src.indexOf('const PUBLIC_PATHS'),
    src.indexOf('interface SessionPayload'),
  );

  it('el aviso de Wompi y «Pide tu acceso» abren sin sesión', () => {
    expect(block).toContain("'/api/billing/wompi/webhook'");
    expect(block).toContain("'/acceso'");
    expect(block).toContain("'/api/access-requests'");
  });

  it('sólo el aviso: el resto del cobro sigue detrás de la sesión', () => {
    expect(block).not.toContain("'/api/billing'");
    expect(block).not.toContain("'/api/billing/wompi'");
    expect(block).not.toContain("'/plan'");
  });

  it('la ruta del aviso verifica la firma antes de tocar la base', () => {
    const route = readFileSync(`${WEB}app/api/billing/wompi/webhook/route.ts`, 'utf8');
    const verify = route.indexOf('verifyWebhook(');
    const apply = route.indexOf('applyVerifiedEvent(event');
    expect(verify).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(verify);
    expect(route).toContain('status: 401');
  });
});
