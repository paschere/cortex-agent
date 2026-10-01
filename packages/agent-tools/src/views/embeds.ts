/**
 * ENLACES, IMÁGENES E INSERCIONES EN UNA VISTA: QUÉ SE DEJA PASAR.
 *
 * Una vista puede abrirse desde afuera (/v/<token>) y la escribe un modelo a
 * partir de lo que alguien pide. Por eso nada de lo que entra aquí es HTML: son
 * direcciones, y cada una pasa por una de tres puertas.
 *
 *   - `httpsUrl`: una imagen o un enlace externo. Sólo `https:` (nunca
 *     `javascript:`, `data:`, `http:` ni `file:`), sin usuario ni contraseña
 *     dentro de la dirección, con un nombre de dominio de verdad (nada de
 *     `localhost` ni IPs: una imagen que apunta a la red interna de quien
 *     mira es una forma vieja de sondearla).
 *   - `embedSrc`: un iframe, y sólo de una lista corta de servicios que se
 *     hicieron para insertarse (YouTube, Google Maps, Loom, Google Slides y
 *     Docs publicados). La dirección que la persona pega se TRADUCE a la de
 *     inserción del servicio; lo que se pinta nunca es la cadena que llegó.
 *     Cualquier otra cosa no se inserta: se rechaza al guardar.
 *   - `safeHref`: un botón de navegación. Una ruta interna (`/views/cartera`)
 *     o un `https:` externo; nada de `//otro-sitio` (un enlace «interno» que
 *     sale del dominio) ni barras invertidas, que algunos navegadores leen
 *     como `/`.
 *
 * Puro y sin dependencias: lo usan el contrato (spec.ts), el cálculo
 * (compute.ts) y las pruebas.
 */

const MAX_URL = 1000;

/** Una dirección `https:` pública y limpia, normalizada. Null si no lo es. */
export function httpsUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL || /[\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  // Una IPv4 o IPv6 escrita a mano: afuera no hay razón para ella.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  return url.toString();
}

export type EmbedProvider = 'youtube' | 'maps' | 'loom' | 'slides' | 'docs';

export const EMBED_PROVIDER_LABEL: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  maps: 'Google Maps',
  loom: 'Loom',
  slides: 'Google Slides',
  docs: 'Google Docs',
};

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const LOOM_ID = /^[a-f0-9]{16,64}$/i;
const PUB_ID = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * La dirección de inserción de un servicio permitido, o null. La salida se
 * arma con partes validadas (un id con su patrón), no copiando la entrada.
 */
export function embedSrc(raw: string | null | undefined): {
  provider: EmbedProvider;
  src: string;
} | null {
  const safe = httpsUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  // YouTube: watch?v=, youtu.be/<id>, /embed/<id>, /shorts/<id>.
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const id =
      parts[0] === 'watch'
        ? url.searchParams.get('v')
        : parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live'
          ? parts[1]
          : null;
    return id && YT_ID.test(id)
      ? { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  }
  if (host === 'youtu.be') {
    const id = parts[0];
    return id && YT_ID.test(id)
      ? { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  }

  // Google Maps: sólo la dirección de «Insertar un mapa» (/maps/embed?pb=…).
  if ((host === 'google.com' || host === 'maps.google.com') && parts[0] === 'maps') {
    const pb = url.searchParams.get('pb');
    if (parts[1] === 'embed' && pb && /^[A-Za-z0-9!._:%-]{10,2000}$/.test(pb))
      return {
        provider: 'maps',
        src: `https://www.google.com/maps/embed?pb=${encodeURIComponent(pb).replace(/%21/g, '!')}`,
      };
    return null;
  }

  // Loom: /share/<id> o /embed/<id>.
  if (host === 'loom.com' && (parts[0] === 'share' || parts[0] === 'embed')) {
    const id = parts[1];
    return id && LOOM_ID.test(id)
      ? { provider: 'loom', src: `https://www.loom.com/embed/${id}` }
      : null;
  }

  // Google Slides y Docs PUBLICADOS en la web (/d/e/<id>/pub…): sólo lo que su
  // dueño decidió publicar, nunca un documento privado con su sesión.
  if (host === 'docs.google.com' && parts[1] === 'd' && parts[2] === 'e') {
    const id = parts[3];
    if (!id || !PUB_ID.test(id)) return null;
    if (parts[0] === 'presentation')
      return {
        provider: 'slides',
        src: `https://docs.google.com/presentation/d/e/${id}/embed?start=false&loop=false`,
      };
    if (parts[0] === 'document')
      return {
        provider: 'docs',
        src: `https://docs.google.com/document/d/e/${id}/pub?embedded=true`,
      };
  }
  return null;
}

const INTERNAL_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*$/;

/** Un destino de botón: ruta interna o `https:` externo. Null si no sirve. */
export function safeHref(raw: string | null | undefined): {
  href: string;
  external: boolean;
} | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL) return null;
  if (value.startsWith('/'))
    return INTERNAL_PATH.test(value) && !value.includes('\\')
      ? { href: value, external: false }
      : null;
  const url = httpsUrl(value);
  return url ? { href: url, external: true } : null;
}
