/**
 * El mismo piso SSRF que services/browser/src/target.ts, DUPLICADO a propósito.
 *
 * Los dos procesos se despliegan por separado y ninguno importa del otro — la
 * misma razón por la que types.ts duplica los tipos del servicio en vez de
 * compartir un paquete. Este lado existe para que el modelo reciba la frase
 * («esa dirección es privada») en el turno, sin gastar un viaje al servicio;
 * el del servicio existe para que la regla aguante aunque este lado no la
 * aplique. Si tocas uno, toca el otro: el test de este archivo fija las
 * respuestas para que una deriva se note en CI y no en producción.
 */

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  '100.100.100.200',
]);

const PRIVATE_SUFFIXES = ['.internal', '.local', '.localhost'];

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === '::1' || bare === '::') return true;
  return (
    /^f[cd]/.test(bare) ||
    bare.startsWith('fe8') ||
    bare.startsWith('fe9') ||
    bare.startsWith('fea') ||
    bare.startsWith('feb')
  );
}

/** Null si se puede navegar; la razón en una frase si no. */
export function forbiddenTargetReason(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Esa no es una dirección válida.';
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Solo se navega a direcciones http o https.';
  }

  const host = url.hostname.toLowerCase();

  if (METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) {
    return 'Esa dirección no es un sitio web y este navegador no va a ir ahí.';
  }

  if (process.env.BROWSER_ALLOW_PRIVATE_HOSTS === 'true') return null;

  if (
    host === 'localhost' ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host) ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return 'Esa dirección es privada, no un sitio de internet. Este navegador solo visita sitios públicos.';
  }

  return null;
}
