/**
 * LA LÓGICA PURA DE LA CACHÉ SIN CONEXIÓN DE UNA APP (0209), PROBADA APARTE.
 *
 * El service worker de una app (lib/apps/service-worker-source.ts) guarda las
 * pantallas que la persona ya visitó y sus datos para abrirlos sin señal. A
 * diferencia del de Cortex (public/sw.js, que no guarda nada por una razón
 * escrita allí), esta caché SÍ guarda datos de una empresa; por eso cada
 * decisión que podría mezclar personas vive aquí, en funciones sin estado que
 * se prueban con los casos que importan (offline-cache.test.ts):
 *
 *   - CADA USUARIO TIENE SU PROPIA CACHÉ (`userCacheName`): el nombre incluye
 *     el id del usuario, así que A y B nunca comparten una caché y borrar la de
 *     uno no toca la del otro. Un id que no parece uno (`userKeyOf` → null) no
 *     guarda nada: ante la duda, no se cachea.
 *   - SÓLO SE GUARDA LO DE ESTA APP: las pantallas bajo /a/<app>/ y los datos
 *     de /api/apps/public/<app>/. Nada más.
 *   - AL SALIR O CAMBIAR DE PERSONA se borran las cachés ajenas (`staleCaches`).
 *
 * IMPORTANTE: estas funciones se incrustan en el texto del service worker con
 * `Function.prototype.toString()`. Por eso son autocontenidas: no llaman a
 * otras funciones del módulo ni a constantes de fuera.
 */

/** Un id de usuario válido (uuid). Cualquier otra cosa: no se cachea. */
export function userKeyOf(raw: unknown): string | null {
  return typeof raw === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : null;
}

/** El nombre de la caché de UN usuario en UNA app. */
export function userCacheName(appId: string, userKey: string): string {
  return `cortex-app-${appId}-u-${userKey}`;
}

/**
 * ¿Se puede guardar esta dirección? Las pantallas (`/a/<app>/<pantalla>`, sin
 * puntos: nada de manifiesto, íconos ni sw.js) y los datos de la app. La
 * entrada (`/a/<app>`) NO se guarda: es la pantalla de «escribe tu correo».
 */
export function isCacheablePath(appId: string, pathname: string): boolean {
  const screen = `/a/${appId}/`;
  if (pathname.startsWith(screen)) {
    const rest = pathname.slice(screen.length);
    return rest.length > 0 && !rest.includes('.') && !rest.includes('/');
  }
  const api = `/api/apps/public/${appId}/screens/`;
  return pathname.startsWith(api) && pathname.endsWith('/data');
}

/**
 * Lo que se guarda al INSTALAR la app aunque la persona todavía no haya abierto
 * esa pantalla: la primera (la de inicio de su rol) y sus datos, para que el
 * primer arranque sin señal ya tenga algo que mostrar. Sólo direcciones de
 * esta app; el worker las vuelve a validar y las guarda en la caché de LA
 * persona que está dentro, nunca en una común.
 */
export function precacheUrlsOf(appId: string, homeSlug: string | null | undefined): string[] {
  if (!homeSlug || !/^[a-z][a-z0-9_]{1,47}$/.test(homeSlug)) return [];
  const slug = encodeURIComponent(homeSlug);
  return [`/a/${appId}/${slug}`, `/api/apps/public/${appId}/screens/${slug}/data`].filter((u) =>
    isCacheablePath(appId, u.split('?')[0] as string),
  );
}

/** La dirección con la que se guarda: sin los parámetros que sólo sirven a Next. */
export function cacheUrlOf(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('_rsc');
  url.hash = '';
  return url.toString();
}

/**
 * Las cachés de esta app que sobran: las de OTROS usuarios (al entrar otra
 * persona o salir la actual, `keep` es null y sobran todas).
 */
export function staleCaches(appId: string, keep: string | null, names: string[]): string[] {
  const prefix = `cortex-app-${appId}-u-`;
  const mine = keep ? `${prefix}${keep}` : null;
  return names.filter((n) => n.startsWith(prefix) && n !== mine);
}

/** «hace 5 minutos», «hace 2 horas»: lo que dice el aviso de sin conexión. */
export function agoLabel(from: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'hace un momento';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `hace ${min} ${min === 1 ? 'minuto' : 'minutos'}`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.floor(hours / 24);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}
