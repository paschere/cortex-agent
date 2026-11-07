/**
 * `ui.print`: saneado del HTML que una app con código manda a imprimir. El HTML viene de código
 * no confiable; se imprime en un iframe sin scripts (`sandbox="allow-same-origin allow-modals"`),
 * pero igual se limpia aquí (defensa en profundidad). Sin DOM: corre en pruebas y en el marco.
 */

export const PRINT_MAX_BYTES = 2 * 1024 * 1024;

const BLOCK_TAGS = ['script', 'iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet'];

function isJavascriptUrl(raw: string): boolean {
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;|&Tab;|&NewLine;/gi, (e) => (e.toLowerCase() === '&colon;' ? ':' : ''));
  let compact = '';
  for (const ch of decoded) {
    const c = ch.charCodeAt(0);
    if (c > 32 && c !== 34 && c !== 39) compact += ch;
  }
  return compact.toLowerCase().startsWith('javascript:');
}

export function sanitizePrintHtml(html: string): string {
  let out = html;
  for (const tag of BLOCK_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  // <meta http-equiv=...> (refresh, CSP, etc.)
  out = out.replace(/<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, '');
  // Atributos on*="..." / on*='...' / on*=valor (con o sin espacio previo, p. ej. tras "/").
  out = out.replace(/[\s/]on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
  // URLs javascript: en atributos de URL (tolera espacios, control y entidades numéricas).
  out = out.replace(
    /(\b(?:href|src|action|formaction|xlink:href|data|poster|background)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, head: string, val: string) => (isJavascriptUrl(val) ? `${head}"#"` : m),
  );
  // url(javascript:...) en CSS.
  out = out.replace(/url\(\s*(["']?)\s*javascript:[^)]*\)/gi, 'url($1$1)');
  return out;
}

/** El documento completo que se pone en `srcdoc` (con título y estilo de impresión mínimo). */
export function buildPrintDoc(html: string, title?: string): string {
  const safeTitle = (title ?? '')
    .replace(/[<>&"]/g, '')
    .trim()
    .slice(0, 120);
  const body = sanitizePrintHtml(html);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body>${body}</body></html>`;
}
