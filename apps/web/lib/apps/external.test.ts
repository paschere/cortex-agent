import { describe, expect, it } from 'vitest';
import { renderAppInvitationEmail, renderAppLoginCodeEmail } from '../email-templates/app-access';
import { appApiBase } from './api-base';
import { buildAppManifest } from './manifest';
import {
  agoLabel,
  cacheUrlOf,
  isCacheablePath,
  staleCaches,
  userCacheName,
  userKeyOf,
} from './offline-cache';
import { createLimiter } from './rate-limit';
import { buildAppServiceWorker } from './service-worker-source';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ANA = 'e0000000-0000-4000-8000-00000000a001';
const BETO = 'e0000000-0000-4000-8000-00000000b002';

describe('manifiesto por app', () => {
  const app = (id: string, name: string, accent?: string) => ({
    id,
    name,
    description: '',
    theme: accent ? { accent } : {},
  });

  it('cada app instala la suya: start_url y scope propios, íconos propios', () => {
    const a = buildAppManifest(app(A, 'Control en planta'));
    const b = buildAppManifest(app(B, 'Portal de clientes'));
    expect(a.start_url).toBe(`/a/${A}`);
    expect(a.scope).toBe(`/a/${A}/`);
    expect(b.scope).toBe(`/a/${B}/`);
    expect(a.display).toBe('standalone');
    expect(a.icons.every((i) => i.src.startsWith(`/a/${A}/icon-`))).toBe(true);
    expect(b.icons.some((i) => i.src.includes(A))).toBe(false);
    expect(a.id).not.toBe(b.id);
  });

  it('el color sale de la marca de la empresa y, sin ella, del acento de la app', () => {
    expect(buildAppManifest(app(A, 'X'), '#112233').theme_color).toBe('#112233');
    expect(buildAppManifest(app(A, 'X', 'emerald')).theme_color).toBe('#047857');
    expect(buildAppManifest(app(A, 'X'), 'no-es-hex').theme_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('el nombre corto cabe bajo el ícono', () => {
    const m = buildAppManifest(app(A, 'Control de guías en planta'));
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.name).toBe('Control de guías en planta');
  });
});

describe('caché sin conexión: no mezcla usuarios', () => {
  it('cada usuario tiene su propia caché, en cada app', () => {
    expect(userCacheName(A, ANA)).not.toBe(userCacheName(A, BETO));
    expect(userCacheName(A, ANA)).not.toBe(userCacheName(B, ANA));
    expect(userCacheName(A, ANA)).toContain(ANA);
  });

  it('un id que no parece un id no guarda nada', () => {
    expect(userKeyOf(ANA)).toBe(ANA);
    expect(userKeyOf(ANA.toUpperCase())).toBe(ANA);
    for (const bad of [null, undefined, '', 'ana', '../../x', `${ANA}/../${BETO}`, 42])
      expect(userKeyOf(bad)).toBeNull();
  });

  it('al entrar otra persona sobran las cachés de la anterior; al salir, todas; las de otras apps no se tocan', () => {
    const names = [
      userCacheName(A, ANA),
      userCacheName(A, BETO),
      userCacheName(B, ANA),
      'cortex-shell-v1',
      `cortex-app-${A}-shell-v1`,
    ];
    expect(staleCaches(A, BETO, names)).toEqual([userCacheName(A, ANA)]);
    expect(staleCaches(A, null, names).sort()).toEqual(
      [userCacheName(A, ANA), userCacheName(A, BETO)].sort(),
    );
    expect(staleCaches(A, ANA, names)).toEqual([userCacheName(A, BETO)]);
  });

  it('sólo se guardan pantallas y datos de ESTA app; ni la entrada, ni íconos, ni otra app', () => {
    expect(isCacheablePath(A, `/a/${A}/mis_registros`)).toBe(true);
    expect(isCacheablePath(A, `/api/apps/public/${A}/screens/mis_registros/data`)).toBe(true);
    expect(isCacheablePath(A, `/a/${A}`)).toBe(false);
    expect(isCacheablePath(A, `/a/${A}/`)).toBe(false);
    expect(isCacheablePath(A, `/a/${A}/manifest.webmanifest`)).toBe(false);
    expect(isCacheablePath(A, `/a/${A}/sw.js`)).toBe(false);
    expect(isCacheablePath(A, `/a/${B}/mis_registros`)).toBe(false);
    expect(isCacheablePath(A, `/api/apps/public/${B}/screens/x/data`)).toBe(false);
    expect(isCacheablePath(A, `/api/apps/public/${A}/screens/x/export`)).toBe(false);
    expect(isCacheablePath(A, '/chat')).toBe(false);
  });

  it('la clave de la copia no lleva parámetros de Next ni el hash', () => {
    expect(cacheUrlOf(`https://x.co/a/${A}/p?_rsc=abc&f=1#top`)).toBe(`https://x.co/a/${A}/p?f=1`);
  });

  it('«datos de hace X»', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(agoLabel('2026-10-07T11:59:30Z', now)).toBe('hace un momento');
    expect(agoLabel('2026-10-07T11:55:00Z', now)).toBe('hace 5 minutos');
    expect(agoLabel('2026-10-07T11:00:00Z', now)).toBe('hace 1 hora');
    expect(agoLabel('2026-10-05T12:00:00Z', now)).toBe('hace 2 días');
  });

  it('el service worker generado es JavaScript válido, con alcance en SU app y con la misma lógica probada', () => {
    const src = buildAppServiceWorker(A);
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain(`'/a/' + APP + '/'`);
    expect(src).toContain(JSON.stringify(A));
    // Ejecuta las funciones incrustadas: son las mismas que prueban los casos de arriba.
    const probe = new Function(
      `${src.split('self.addEventListener')[0]}; return {userKeyOf, userCacheName, isCacheablePath, staleCaches};`,
    );
    const sw = probe() as {
      userKeyOf: (x: unknown) => string | null;
      userCacheName: (a: string, u: string) => string;
      isCacheablePath: (a: string, p: string) => boolean;
      staleCaches: (a: string, k: string | null, n: string[]) => string[];
    };
    expect(sw.userKeyOf(ANA)).toBe(ANA);
    expect(sw.userKeyOf('x')).toBeNull();
    expect(sw.userCacheName(A, ANA)).toBe(userCacheName(A, ANA));
    expect(sw.isCacheablePath(A, `/a/${A}/pantalla`)).toBe(true);
    expect(sw.isCacheablePath(A, `/a/${B}/pantalla`)).toBe(false);
    expect(sw.staleCaches(A, ANA, [userCacheName(A, BETO)])).toEqual([userCacheName(A, BETO)]);
  });

  it('el worker nunca toca los POST (la cola sin internet de los formularios ya existe)', () => {
    expect(buildAppServiceWorker(A)).toContain("request.method !== 'GET'");
  });
});

describe('topes por IP', () => {
  it('cuenta por llave y por ventana', () => {
    const l = createLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => l.take('ip1', 0))).toEqual([true, true, true, false]);
    expect(l.take('ip2', 0)).toBe(true);
    expect(l.take('ip1', 1500)).toBe(true);
  });
});

describe('rutas y correos', () => {
  it('el externo entra por el prefijo público; el miembro por el de siempre', () => {
    expect(appApiBase({ appId: A, external: true })).toBe(`/api/apps/public/${A}`);
    expect(appApiBase({ appId: 'planta' })).toBe('/api/apps/planta');
  });

  it('el correo del código lleva el código y no promete nada más', () => {
    const mail = renderAppLoginCodeEmail({
      appName: 'Control en planta',
      code: '123456',
      minutes: 10,
    });
    expect(mail.subject).toContain('Control en planta');
    expect(mail.text).toContain('123456');
    expect(mail.html).toContain('123456');
  });

  it('la invitación nombra la app, la empresa y el rol', () => {
    const mail = renderAppInvitationEmail({
      appId: A,
      appName: 'Control en planta',
      organizationName: 'Postal',
      name: 'Ana',
      roleName: 'Operario',
    });
    expect(mail.subject).toContain('Postal');
    expect(mail.text).toContain('Operario');
  });
});
