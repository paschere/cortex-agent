/**
 * Parámetros con los que se abrió la pantalla (p. ej. `nav.go({screen:'vuelo', prefill:{vuelo:id}})`).
 * Se leen de la dirección del marco o de `window.cortexPrefill` si el host lo deja ahí.
 * Si no llega nada, la pantalla ofrece elegir el registro.
 */
export function parametro(nombre: string): string {
  try {
    const w = window as unknown as { cortexPrefill?: Record<string, unknown> };
    const p = w.cortexPrefill?.[nombre];
    if (typeof p === 'string' || typeof p === 'number') return String(p);
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return q.get(nombre) ?? h.get(nombre) ?? '';
  } catch {
    return '';
  }
}
