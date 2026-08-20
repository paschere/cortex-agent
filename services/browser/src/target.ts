/**
 * El piso: a dónde este navegador se niega a ir, bajo toda configuración.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Este proceso vive DENTRO de la infraestructura: comparte red privada con la
 * base de datos, con el bridge de WhatsApp y con el metadata endpoint del
 * cloud. Y navega a URLs que, con la navegación libre, ya no escribe un
 * administrador enseñando un trámite sino un modelo componiendo una petición.
 * «Ábreme http://169.254.169.254/latest/meta-data» no es una diligencia: es
 * el SSRF de manual, y la respuesta correcta no es una política configurable
 * sino un piso que aguanta aunque toda la configuración esté mal.
 *
 * ===========================================================================
 * DELIBERADAMENTE TONTO, Y DICHO EN VOZ ALTA
 * ===========================================================================
 * No resuelve DNS y no sigue redirects — juzga el texto de la URL y nada más.
 * Eso deja dos huecos conocidos: un dominio público apuntado a una IP privada
 * (DNS rebinding), y una página permitida que redirige adentro. Cerrarlos de
 * verdad exige interceptar cada request post-DNS, que es otro proyecto y otro
 * costo por página. Un guard tonto que se entiende entero gana a uno listo
 * que nadie puede razonar: lo que sí promete, lo promete siempre.
 *
 * Dos niveles, como en OpenBot, de donde tomamos la forma:
 *
 *   * PRIVADO (loopback, RFC1918, link-local, *.internal): bloqueado por
 *     defecto, abrible con BROWSER_ALLOW_PRIVATE_HOSTS=true para el caso
 *     legítimo (un portal en la intranet del cliente, algún día).
 *   * METADATA (169.254.169.254, metadata.google.internal y compañía):
 *     bloqueado BAJO TODA CONFIGURACIÓN. No hay variable que lo abra, porque
 *     no existe el trámite legítimo que lo necesite y sí existe el atacante.
 */

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  '100.100.100.200', // Alibaba Cloud; barato de incluir, caro de lamentar.
]);

/** *.internal cubre a Railway (postgres.railway.internal) y a GCP. */
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
  // La URL trae IPv6 entre corchetes; el host de `new URL` los conserva.
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === '::1' || bare === '::') return true;
  // fc00::/7 (ULA) y fe80::/10 (link-local).
  return (
    /^f[cd]/.test(bare) ||
    bare.startsWith('fe8') ||
    bare.startsWith('fe9') ||
    bare.startsWith('fea') ||
    bare.startsWith('feb')
  );
}

/**
 * Null si se puede navegar; la razón, en una frase para el que pidió, si no.
 * La frase no revela topología: dice «privado», nunca qué hay ahí.
 */
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

  // El techo del piso: metadata no se abre con ninguna variable.
  if (METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) {
    return 'Esa dirección no es un sitio web y este navegador no va a ir ahí.';
  }

  const allowPrivate = process.env.BROWSER_ALLOW_PRIVATE_HOSTS === 'true';
  if (allowPrivate) return null;

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

export class ForbiddenTarget extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ForbiddenTarget';
  }
}

export function assertNavigable(rawUrl: string): void {
  const reason = forbiddenTargetReason(rawUrl);
  if (reason) throw new ForbiddenTarget(reason);
}
