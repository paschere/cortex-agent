/**
 * Dominios y direcciones para «Cortex en tu Chrome».
 *
 * MÓDULO PURO Y SIN DEPENDENCIAS, a propósito: lo importan el servidor (las
 * herramientas) Y la extensión (que se empaqueta con esbuild y no puede traer
 * medio paquete detrás). Si lo tocas, el test de esta carpeta fija las
 * respuestas.
 *
 * LA REGLA DE FONDO: una decisión de la persona («permitir en bancolombia.com»)
 * se guarda por SITIO, no por subdominio ni por URL. El sitio es el dominio
 * registrable aproximado: los dos últimos nombres (`bancolombia.com`), o los
 * tres cuando el sufijo es de dos partes (`dian.gov.co`). Sin la lista de
 * sufijos, «permitir en gov.co» abriría TODOS los portales del Estado con un
 * solo clic — por eso un sufijo público jamás es un sitio.
 */

/** Sufijos públicos de dos partes más comunes donde opera la gente de Cortex. */
const MULTI_SUFFIXES = new Set([
  'com.co',
  'org.co',
  'net.co',
  'gov.co',
  'edu.co',
  'mil.co',
  'nom.co',
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'com.mx',
  'org.mx',
  'gob.mx',
  'com.ar',
  'gob.ar',
  'com.br',
  'gov.br',
  'com.pe',
  'gob.pe',
  'com.ec',
  'gob.ec',
  'com.ve',
  'com.pa',
  'com.uy',
  'com.cl',
  'gob.cl',
  'com.es',
  'com.au',
  'co.nz',
  'co.za',
  'co.jp',
  'co.in',
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  '100.100.100.200',
]);
const PRIVATE_SUFFIXES = ['.internal', '.local', '.localhost', '.lan', '.home', '.corp'];

/** El host en minúsculas y sin `www.`; null si no es una dirección http(s). */
export function hostOf(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/**
 * El sitio de un host: lo que se aprueba y se recuerda. Null si no existe un
 * sitio razonable (un sufijo público solo, una sola etiqueta).
 */
export function siteOf(host: string): string | null {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!h || h.length > 253) return null;
  if (IPV4.test(h)) return h;
  if (h.startsWith('[') || h.includes(':')) return null;
  const labels = h.split('.');
  if (labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l) || l.startsWith('-') || l.endsWith('-'))) {
    // Los dominios con acentos llegan en punycode (xn--...), que sí pasa.
    return null;
  }
  if (labels.length < 2) return null;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(last2)) return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return last2;
}

/** ¿Este host cae dentro del sitio aprobado? Por frontera de etiqueta, nunca por texto suelto. */
export function hostInSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/** El sitio de una URL completa, o null. */
export function siteOfUrl(rawUrl: string): string | null {
  const host = hostOf(rawUrl);
  return host ? siteOf(host) : null;
}

function isPrivateIpv4(host: string): boolean {
  const m = IPV4.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([1, 2, 3, 4].some((i) => Number(m[i]) > 255)) return true; // basura: se trata como privada
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Por qué NO se actúa sobre esta dirección, en una frase; null si se puede
 * considerar. `protectedSites` son los sitios de Cortex mismo: jamás se maneja
 * la pantalla donde la persona aprueba lo que Cortex hace.
 */
export function blockedUrlReason(
  rawUrl: string,
  protectedSites: readonly string[] = [],
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Esa no es una dirección válida.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Cortex solo trabaja en páginas web (http o https), no en páginas del navegador ni archivos.';
  }
  if (url.username || url.password)
    return 'Esa dirección trae usuario y clave incrustados; no se usa.';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'Esa no es una dirección válida.';
  if (METADATA_HOSTS.has(host)) return 'Esa dirección no es un sitio web.';
  const bare = host.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    PRIVATE_SUFFIXES.some((s) => host.endsWith(s)) ||
    isPrivateIpv4(host) ||
    bare === '::1' ||
    bare === '::' ||
    /^f[cd]/.test(bare) ||
    /^fe[89ab]/.test(bare) ||
    // Sin punto no es un sitio de internet (intranet, router).
    (!bare.includes('.') && !bare.includes(':'))
  ) {
    return 'Esa dirección es de tu red privada, no un sitio de internet. Cortex no trabaja ahí.';
  }
  if (/^\d+$/.test(host.replace(/\./g, '')) && !IPV4.test(host)) {
    return 'Esa dirección numérica no es válida.';
  }
  const site = siteOf(host);
  if (site && protectedSites.some((p) => hostInSite(host, p))) {
    return 'Esa es la página de Cortex. No la manejo desde tu Chrome: ahí decides tú.';
  }
  return null;
}

/** ¿Es una regla que se pueda guardar? (sitio bien formado, no un sufijo público) */
export function validSite(site: string): boolean {
  const s = site.toLowerCase();
  return siteOf(s) === s;
}
