/**
 * UN ENLACE LARGO NO TIENE POR QUÉ OCUPAR LA PANTALLA ENTERA.
 *
 * Visto en producción: `https://drive.google.com/drive/folders/12ZKgFFQW5jZ4…`
 * pegado entero en una respuesta se salía de la burbuja. El texto visible se
 * acorta a dominio + inicio de la ruta y el `href` completo se queda intacto
 * (más un `title`), así que lo que se pierde es ruido, nunca el destino.
 */

/** Cuántos caracteres de «dominio/ruta» se enseñan antes de poner «…». */
export const LINK_LABEL_MAX = 44;

/** ¿Este texto es, él mismo, una URL? Sólo entonces se acorta: «ver informe» se queda como está. */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/** `https://www.dominio.com/a/b?x=1` → `dominio.com/a/b?x=1`, recortado con «…». */
export function shortLinkLabel(url: string, max: number = LINK_LABEL_MAX): string {
  let label = url.trim();
  try {
    const parsed = new URL(label);
    const host = parsed.hostname.replace(/^www\./, '');
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
    label = `${host}${rest}`;
  } catch {
    label = label.replace(/^https?:\/\//i, '');
  }
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}
