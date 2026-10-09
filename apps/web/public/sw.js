/**
 * EL SERVICE WORKER QUE NO GUARDA NADA, Y ESO ES LA DECISIÓN.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Chrome no ofrece instalar una aplicación que no tenga un service worker con
 * un manejador de `fetch`. Ése es todo el motivo por el que este archivo está
 * aquí: sin él no hay botón de instalar.
 *
 * ===========================================================================
 * POR QUÉ NO CACHEA NI UNA PÁGINA
 * ===========================================================================
 * La tentación evidente —guardar el HTML para que abra rápido— es aquí un
 * error grave, y por dos razones distintas:
 *
 *   ES DE OTRA PERSONA. Todas las pantallas de este producto están detrás de
 *   una sesión y llevan datos de una empresa: la cartera, la nómina, quién
 *   aprueba qué. Un HTML guardado sobrevive al cierre de sesión, así que en un
 *   computador compartido —un mostrador, una bodega— el siguiente en abrirlo
 *   vería la pantalla del anterior. La caché no sabe de sesiones.
 *
 *   ESTÁ VIEJO Y NO LO DICE. «Les deben 12 millones» servido desde la caché no
 *   se ve distinto de la cifra de ahora. Este producto entero se sostiene sobre
 *   decir de dónde salió cada dato y de cuándo es; una cifra sin fecha servida
 *   como si fuera fresca es exactamente el artefacto que existe para dejar de
 *   producir.
 *
 * Así que el manejador deja pasar TODO a la red, sin tocarlo. Cuando no hay
 * red, una navegación recibe una página que lo dice con esas palabras, en vez
 * del dinosaurio del navegador o —peor— de una pantalla de ayer.
 *
 * Los archivos estáticos tampoco se guardan: los sirve Vercel con su propia
 * caché inmutable, que ya hace ese trabajo mejor y sabe cuándo invalidarla.
 */

const OFFLINE_URL = '/sin-conexion.html';
const SHELL = 'cortex-shell-v1';

self.addEventListener('install', (event) => {
  // Lo único que se guarda en toda la aplicación: la página que dice que no hay
  // red. Tiene que estar disponible justamente cuando no se puede pedir nada.
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Se barren las cachés de versiones anteriores. Si algún día alguien añade
  // una caché de contenido y luego la quita, esto la borra de los navegadores
  // que ya la tengan — sin esto, seguiría sirviéndose para siempre.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Sólo se interviene en la navegación, y sólo para tener algo que enseñar
  // cuando la red falla. Todo lo demás —API, datos, imágenes— va directo: que
  // falle como falla en el navegador es la respuesta correcta.
  if (request.mode !== 'navigate') return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return (
        cached ??
        new Response('Sin conexión.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      );
    }),
  );
});

// Avisos de Cortex (Web Push, 0220): «Tu día» y lo que no puede esperar. El
// cuerpo lo arma el servidor (lib/notifications/push.ts) con una ruta interna;
// aquí sólo se muestra y, al tocarlo, se abre esa ruta.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Cortex';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : 'cortex',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof data.url === 'string' ? data.url : '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const url = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(url).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
