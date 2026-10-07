import {
  cacheUrlOf,
  isCacheablePath,
  staleCaches,
  userCacheName,
  userKeyOf,
} from './offline-cache';

/**
 * EL SERVICE WORKER DE UNA APP (0209): /a/<app>/sw.js, con alcance /a/<app>/.
 *
 * Lo que guarda y lo que no, y por qué, está argumentado en offline-cache.ts.
 * En corto:
 *   - cascarón (`/_next/static/`, inmutable y sin datos): primero la caché.
 *   - pantallas visitadas y sus datos: primero la red; al fallar, la copia de
 *     ESA persona (una caché por usuario; nunca la de otro).
 *   - la página le dice al worker quién es (`{type:'who'}`): sólo entonces se
 *     guarda algo, y se borran las cachés de cualquier otra persona.
 *   - al salir (`{type:'signout'}`) o si la red contesta que ya no hay sesión
 *     (redirige a la entrada), se borra todo lo de la persona.
 *   - la cola sin internet de los formularios ya existe en el navegador
 *     (lib/views/offline-queue.ts) y NO pasa por aquí: los POST no se tocan.
 */
export function buildAppServiceWorker(appId: string): string {
  return `/* Service worker de la app ${appId}. Generado por lib/apps/service-worker-source.ts */
const APP = ${JSON.stringify(appId)};
const SCOPE = '/a/' + APP + '/';
const SHELL = 'cortex-app-' + APP + '-shell-v1';
const META = 'cortex-app-' + APP + '-meta';
const WHO_KEY = '/__who';
const userKeyOf = ${userKeyOf.toString()};
const userCacheName = ${userCacheName.toString()};
const isCacheablePath = ${isCacheablePath.toString()};
const cacheUrlOf = ${cacheUrlOf.toString()};
const staleCaches = ${staleCaches.toString()};

async function currentUser() {
  try {
    const meta = await caches.open(META);
    const hit = await meta.match(WHO_KEY);
    return hit ? userKeyOf(await hit.text()) : null;
  } catch (e) {
    return null;
  }
}

async function setCurrentUser(userKey) {
  const meta = await caches.open(META);
  if (userKey) await meta.put(WHO_KEY, new Response(userKey));
  else await meta.delete(WHO_KEY);
  // Sobran las cachés de cualquier otra persona (o todas, si nadie entró).
  const doomed = staleCaches(APP, userKey, await caches.keys());
  await Promise.all(doomed.map((n) => caches.delete(n)));
}

async function remember(userKey, request, response) {
  if (!userKey || !response.ok || response.redirected) return;
  const cache = await caches.open(userCacheName(APP, userKey));
  await cache.put(cacheUrlOf(request.url), response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('cortex-app-' + APP + '-shell-') && k !== SHELL)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'who') {
    const userKey = userKeyOf(data.userKey);
    event.waitUntil(
      (async () => {
        await setCurrentUser(userKey);
        // La página que acaba de abrirse es de ESTA persona: se guarda su copia
        // para abrirla sin señal. Misma dirección, mismo navegador, misma cookie.
        if (userKey && typeof data.url === 'string') {
          const url = new URL(data.url, self.location.origin);
          if (url.origin === self.location.origin && isCacheablePath(APP, url.pathname)) {
            const res = await fetch(url.toString(), { credentials: 'same-origin', cache: 'reload' }).catch(() => null);
            if (res) await remember(userKey, new Request(url.toString()), res);
          }
        }
      })(),
    );
  } else if (data.type === 'signout') {
    event.waitUntil(setCurrentUser(null));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) await cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  const navigating = request.mode === 'navigate' && url.pathname.startsWith(SCOPE);
  const wantsData = isCacheablePath(APP, url.pathname) && url.pathname.endsWith('/data');
  if (!navigating && !wantsData) return;

  event.respondWith(
    (async () => {
      const userKey = await currentUser();
      try {
        const res = await fetch(request);
        if (res.redirected && navigating && !isCacheablePath(APP, new URL(res.url).pathname)) {
          // La red mandó a la entrada: ya no hay sesión. Nada de esa persona se queda.
          await setCurrentUser(null);
        } else if (wantsData && (res.status === 401 || res.status === 404)) {
          await setCurrentUser(null);
        } else if (wantsData && userKey) {
          await remember(userKey, request, res);
        }
        return res;
      } catch (e) {
        if (userKey) {
          const cache = await caches.open(userCacheName(APP, userKey));
          const hit = await cache.match(cacheUrlOf(request.url));
          if (hit) return hit;
        }
        if (navigating)
          return new Response(OFFLINE_HTML, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        return new Response(JSON.stringify({ error: 'Sin conexión.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    })(),
  );
});

const OFFLINE_HTML = ${JSON.stringify(OFFLINE_HTML)};
`;
}

const OFFLINE_HTML = `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7fb;color:#1b1d2a;text-align:center;padding:24px}main{max-width:340px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5b5f73;line-height:1.5}</style></head><body><main><h1>Sin conexión</h1><p>Esta pantalla todavía no se guardó en tu teléfono. Abre la app con señal una vez y la próxima vez la verás sin conexión. Lo que registraste se envía solo cuando vuelva la señal.</p></main></body></html>`;
