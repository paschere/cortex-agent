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
  mutedAttr: string | null;
  area: number;
};

export type MicButtonHint = {
  label: string;
  mutedAttr: string | null;
  area: number;
  /** 0 = top of the viewport, 1 = bottom. */
  yRatio: number;
  tag: string;
};

/**
 * El control del micro es un BOTÓN chico de la barra, no un mosaico con
 * `data-is-muted`. Elegir el nodo de mayor área hacía que el click cayera
 * en un tile y Meet nunca se enterara.
 */
export function scoreMicButton(hint: MicButtonHint): number | null {
  const tag = hint.tag.toLowerCase();
  if (tag !== 'button') return null;
  if (hint.area < 80 || hint.area > 16_000) return null;
  if (!looksLikeMicLabel(hint.label)) return null;
  let score = 10;
  if (hint.yRatio >= 0.65) score += 8;
  else if (hint.yRatio >= 0.35) score += 2;
  if (hint.mutedAttr !== null) score += 3;
  if (hint.area >= 400 && hint.area <= 8_000) score += 2;
  return score;
}

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

/** Corre en el browser. Devuelve el centro del botón de micro de la BARRA. */
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

  const vh = Math.max(1, window.innerHeight);
  const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
  let best: {
    el: Element;
    on: boolean;
    label: string;
    mutedAttr: string | null;
    area: number;
    score: number;
  } | null = null;
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const tag = el.tagName || '';
    if (tag.toLowerCase() !== 'button') continue;
    const label = labelOf(el);
    const mutedAttr =
      el.getAttribute('data-is-muted') ??
      el.closest('[data-is-muted]')?.getAttribute('data-is-muted') ??
      null;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const yRatio = rect.top / vh;
    const labeled = looksLike(label);
    if (!labeled) continue;
    if (area < 80 || area > 16_000) continue;
    let score = 10;
    if (yRatio >= 0.65) score += 8;
    else if (yRatio >= 0.35) score += 2;
    if (mutedAttr !== null) score += 3;
    if (area >= 400 && area <= 8_000) score += 2;
    const on = currentlyOn(label, mutedAttr, el.getAttribute('aria-pressed'));
    if (on === null && mutedAttr === null) continue;
    if (!best || score > best.score || (score === best.score && area < best.area)) {
      best = { el, on: on ?? mutedAttr === 'false', label, mutedAttr, area, score };
    }
  }
  if (!best) return { found: false, on: false, x: 0, y: 0, label: '', mutedAttr: null, area: 0 };
  const rect = best.el.getBoundingClientRect();
  return {
    found: true,
    on: best.on,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    label: best.label,
    mutedAttr: best.mutedAttr,
    area: best.area,
  };
}

/** El elemento del micro, para un click XTEST (isTrusted=true). */
export function googleMeetMicButtonElement(): HTMLElement | null {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const looksLike = (label: string): boolean => {
    const l = label.toLowerCase();
    if (!l) return false;
    if (/(c[aá]mara|\bcamera\b|\bvideo\b)/i.test(l) && !/mic/.test(l)) return false;
    return /micr[oó]fono|\bmicrophone\b|\bmic\b|unmute|silenci/.test(l);
  };
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const labelOf = (el: Element): string =>
    (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || (el as HTMLElement).title || '').trim();
  const vh = Math.max(1, window.innerHeight);
  let best: { el: HTMLElement; score: number; area: number } | null = null;
  for (const raw of Array.from(document.querySelectorAll('button'))) {
    const el = raw as HTMLElement;
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    if (!looksLike(label)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < 80 || area > 16_000) continue;
    const mutedAttr = el.getAttribute('data-is-muted');
    const yRatio = rect.top / vh;
    let score = 10;
    if (yRatio >= 0.65) score += 8;
    else if (yRatio >= 0.35) score += 2;
    if (mutedAttr !== null) score += 3;
    if (area >= 400 && area <= 8_000) score += 2;
    if (!best || score > best.score || (score === best.score && area < best.area)) {
      best = { el, score, area };
    }
  }
  return best?.el ?? null;
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
export function tileLooksLikeSelf(
  aria: string,
  hasSelfNameAttr: boolean,
  selfName: string | null,
): boolean {
  if (hasSelfNameAttr) return true;
  if (/\b(you|tú|yo)\b/i.test(aria)) return true;
  const needle = selfName?.trim().toLowerCase();
  if (needle && needle.length >= 2 && aria.toLowerCase().includes(needle)) return true;
  return false;
}

export function locateSelfMuted(selfName: string | null = null): boolean | null {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const name = typeof selfName === 'string' ? selfName : null;
  const tiles = Array.from(document.querySelectorAll('[data-self-name], [data-participant-id]'));
  const looksSelf = (t: Element): boolean => {
    const aria = t.getAttribute('aria-label') || '';
    if (t.hasAttribute('data-self-name')) return true;
    if (/\b(you|tú|yo)\b/i.test(aria)) return true;
    const needle = name?.trim().toLowerCase();
    if (needle && needle.length >= 2 && aria.toLowerCase().includes(needle)) return true;
    return false;
  };
  const self = tiles.find(looksSelf);
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
