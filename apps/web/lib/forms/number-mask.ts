/**
 * LA MÁSCARA DE UN NÚMERO MIENTRAS SE ESCRIBE, EN COLOMBIANO.
 *
 * El campo guarda siempre el número «de máquina» (`1250000.5`); la persona ve y
 * escribe «1.250.000,5»: punto para los miles, coma para los decimales. Tres
 * funciones puras, probadas sin navegador:
 *
 *   maskTyping(texto)   lo que se muestra al teclear: sólo dígitos, una coma,
 *                       miles con punto. Conserva la coma del final («12,») para
 *                       que se pueda seguir escribiendo.
 *   canonicalOf(texto)  el valor de máquina que sale de lo mostrado.
 *   displayOf(valor)    el valor de máquina, mostrado con la máscara.
 *
 * Un punto tecleado no cuenta como decimal: en el teclado numérico de un
 * teléfono en español la coma es la tecla del decimal, y el punto que alguien
 * escribe casi siempre es un miles.
 */

export interface MaskOptions {
  /** Decimales permitidos; 0 = sólo enteros (pesos completos). */
  decimals: number;
  /** Permite números negativos. */
  negative?: boolean;
}

export function maskTyping(text: string, opts: MaskOptions): string {
  const negative = Boolean(opts.negative) && text.trimStart().startsWith('-');
  let intPart = '';
  let decPart = '';
  let comma = false;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      if (comma) {
        if (decPart.length < opts.decimals) decPart += ch;
      } else intPart += ch;
    } else if (ch === ',') comma = true;
  }
  intPart = intPart.replace(/^0+(?=\d)/, '');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const showComma = comma && opts.decimals > 0;
  if (!grouped && !showComma && !decPart) return negative ? '-' : '';
  return `${negative ? '-' : ''}${grouped || '0'}${showComma ? `,${decPart}` : ''}`;
}

/** El valor de máquina de lo que se ve: «1.250.000,5» → «1250000.5»; vacío si no hay número. */
export function canonicalOf(shown: string): string {
  const t = shown.trim();
  if (!t || t === '-') return '';
  const neg = t.startsWith('-');
  const [i = '', d = ''] = t.replace(/^-/, '').split(',');
  const int = i.replace(/\./g, '');
  if (!int && !d) return '';
  return `${neg ? '-' : ''}${int || '0'}${d ? `.${d}` : ''}`;
}

/** Cómo se muestra un valor de máquina («1250000.5» → «1.250.000,5»). */
export function displayOf(value: string, opts: MaskOptions): string {
  const t = value.trim();
  if (!t) return '';
  const n = Number(t);
  if (!Number.isFinite(n)) return '';
  const [i = '', d = ''] = t.replace(/^-/, '').split('.');
  return maskTyping(`${n < 0 ? '-' : ''}${i}${d ? `,${d}` : ''}`, {
    ...opts,
    decimals: Math.max(opts.decimals, Math.min(d.length, 6)),
  });
}
