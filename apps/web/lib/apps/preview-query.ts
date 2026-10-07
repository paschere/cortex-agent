/**
 * `?como=<rol>` y, si se mira como un cliente concreto, `&atr=cliente:Andina`
 * (uno por atributo). Es la dirección de «Ver como…»: la pantalla, sus datos y
 * el Excel la repiten para que la simulación no se pierda al navegar.
 */
export function previewQuery(roleKey: string, attributes?: Record<string, string>): string {
  const attrs = Object.entries(attributes ?? {}).map(
    ([k, v]) => `&atr=${encodeURIComponent(`${k}:${v}`)}`,
  );
  return `?como=${encodeURIComponent(roleKey)}${attrs.join('')}`;
}

/**
 * «Ver como… cliente X»: los `atr=clave:valor` de la dirección (uno por
 * atributo) como atributos de quien se simula. Sólo se usan si quien mira es
 * administrador y pidió `como` (lo decide `openMemberApp`); para cualquier otro
 * no valen nada. Acotado: pocas claves, claves y valores cortos.
 */
export function previewAttributesOf(
  raw: string | string[] | null | undefined,
): Record<string, string> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Record<string, string> = {};
  for (const item of list.slice(0, 6)) {
    const at = item.indexOf(':');
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (at > 0 && /^[a-z][a-z0-9_]{0,39}$/.test(key) && value && value.length <= 120)
      out[key] = value;
  }
  return out;
}
