/**
 * Micrófono de Google Meet — encontrar el botón y dejarlo como Cortex lo
 * necesita (encendido para hablar, apagado si solo escucha).
 *
 * El aria-label describe la ACCIÓN, no el estado: «Turn on microphone» /
 * «Activar micrófono» significa que AHORA está apagado. Un selector inglés
 * fijo («Turn on microphone») fallaba en silencio cuando Meet hablaba en
 * español o cuando el primer match era un duplicado oculto: el bot asumía
 * «ya está encendido» y la sala veía a Cortex muteado.
 *
 * locateGoogleMeetMicrophone corre DENTRO de la página (page.evaluate). Es
 * autocontenida: DOM y su argumento, nada de módulos. Los clasificadores de
 * etiqueta se exportan aparte para probarlos sin un navegador.
 */

export type MicLocate = {
  found: boolean;
  on: boolean;
  x: number;
  y: number;
  label: string;
};

export function looksLikeMicLabel(label: string): boolean {
  const l = label.toLowerCase();
  if (!l) return false;
  if (/(c[aá]mara|\bcamera\b|\bvideo\b)/i.test(l) && !/mic/.test(l)) return false;
  return /micr[oó]fono|\bmicrophone\b|\bmic\b|unmute|silenci/.test(l);
}

/**
 * true = el micro está ENCENDIDO (Meet está enviando audio).
 * false = apagado. null = no se puede saber por la etiqueta sola.
 */
export function micCurrentlyOn(
  label: string,
  dataIsMuted: string | null,
  ariaPressed: string | null,
): boolean | null {
  if (dataIsMuted === 'true') return false;
  if (dataIsMuted === 'false') return true;
  const l = label.toLowerCase();
  // «desactivar» contiene «activar»: el apagado va primero.
  if (/turn off|desactivar|mute mic|apagar el mic|micr[oó]fono activado/.test(l) && !/unmute/.test(l)) {
    return true;
  }
  if (/turn on|(?<!des)activar|unmute|encender|est[aá]s silenciad|you.?re muted|micr[oó]fono apagado/.test(l)) {
    return false;
  }
  if (ariaPressed === 'true') return true;
  if (ariaPressed === 'false') return false;
  return null;
}

/** Corre en el browser. Devuelve el centro del botón de micro visible. */
export function locateGoogleMeetMicrophone(): MicLocate {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);

  const looksLike = (label: string): boolean => {
    const l = label.toLowerCase();
    if (!l) return false;
    if (/(c[aá]mara|\bcamera\b|\bvideo\b)/i.test(l) && !/mic/.test(l)) return false;
    return /micr[oó]fono|\bmicrophone\b|\bmic\b|unmute|silenci/.test(l);
  };

  const currentlyOn = (
    label: string,
    dataIsMuted: string | null,
    ariaPressed: string | null,
  ): boolean | null => {
    if (dataIsMuted === 'true') return false;
    if (dataIsMuted === 'false') return true;
    const l = label.toLowerCase();
    if (/turn off|desactivar|mute mic|apagar el mic|micr[oó]fono activado/.test(l) && !/unmute/.test(l)) {
      return true;
    }
    if (/turn on|(?<!des)activar|unmute|encender|est[aá]s silenciad|you.?re muted|micr[oó]fono apagado/.test(l)) {
      return false;
    }
    if (ariaPressed === 'true') return true;
    if (ariaPressed === 'false') return false;
    return null;
  };

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      cs.opacity !== '0'
    );
  };

  const labelOf = (el: Element): string =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('data-tooltip') ||
      (el as HTMLElement).title ||
      ''
    ).trim();

  const nodes = Array.from(
    document.querySelectorAll('button, [role="button"], [data-is-muted]'),
  );
  let best: { el: Element; on: boolean; label: string; area: number } | null = null;
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    const mutedAttr =
      el.getAttribute('data-is-muted') ??
      el.closest('[data-is-muted]')?.getAttribute('data-is-muted') ??
      null;
    if (!looksLike(label) && mutedAttr === null) continue;
    const on = currentlyOn(label, mutedAttr, el.getAttribute('aria-pressed'));
    if (on === null && mutedAttr === null) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (!best || area > best.area) {
      best = { el, on: on ?? mutedAttr === 'false', label, area };
    }
  }
  if (!best) return { found: false, on: false, x: 0, y: 0, label: '' };
  const rect = best.el.getBoundingClientRect();
  return {
    found: true,
    on: best.on,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    label: best.label,
  };
}

/** Snackbar «Estás silenciado» / «You're muted» — un atajo para encender. */
export function locateUnmuteBanner(): { found: boolean; x: number; y: number } {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const needles = /^(unmute|activar mic|dejar de silenciar|encender mic)/i;
  for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
    if (!isVisible(el)) continue;
    const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim();
    if (!needles.test(text) && !/you.?re muted|est[aá]s silenciad/i.test(text)) continue;
    if (/c[aá]mara|camera/i.test(text)) continue;
    const rect = el.getBoundingClientRect();
    return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { found: false, x: 0, y: 0 };
}

/**
 * Lo que la SALA ve: el mosaico propio del bot y su icono de silenciado. El
 * botón de abajo puede decir «Turn off microphone» y aun así el bot aparecer
 * silenciado para los demás (21-08: «nunca se desmutea»). Este es el veredicto
 * que manda; el botón es solo la palanca.
 *   true  = silenciado, false = abierto, null = no se pudo leer.
 */
export function locateSelfMuted(): boolean | null {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const tiles = Array.from(document.querySelectorAll('[data-self-name], [data-participant-id]'));
  const self =
    tiles.find((t) => t.hasAttribute('data-self-name')) ??
    tiles.find((t) => /\b(you|tú|yo)\b/i.test(t.getAttribute('aria-label') || ''));
  if (!self) return null;
  const muted = self.querySelector('[data-is-muted]');
  if (muted) return muted.getAttribute('data-is-muted') === 'true';
  const icons = Array.from(self.querySelectorAll('[aria-label], i, span'));
  for (const el of icons) {
    const txt = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
    if (/mic_off|micr[oó]fono (apagado|desactivado)|is muted|est[aá] silenciad|muted/.test(txt)) return true;
  }
  return false;
}
