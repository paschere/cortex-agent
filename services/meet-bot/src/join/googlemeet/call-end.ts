/**
 * ¿SIGUE LA LLAMADA, O YA SE ACABÓ?
 *
 * El monitor viejo buscaba `text="Meeting ended"` — copia que Meet casi nunca
 * pinta. La pantalla de despedida dice «You left the meeting», «This meeting
 * has ended», «Rejoin», o lo mismo en español. Y si el anfitrión cuelga y
 * Cortex se queda solo, ni siquiera hay esa pantalla: hay que mirar el roster.
 *
 * Esta función clasifica una FOTO del DOM (textos visibles, botones, tiles,
 * URL). La toma `checkForGoogleRemoval` con page.evaluate; las pruebas la
 * alimentan sin un navegador.
 */

export type CallEndSnapshot = {
  url: string;
  headings: string[];
  buttons: string[];
  dialogs: string[];
  hasParticipantTile: boolean;
  hasLeaveButton: boolean;
};

export type CallEndVerdict = { ended: boolean; reason: string | null };

const ENDED_COPY =
  /this meeting has ended|the meeting has ended|the host ended the meeting|you left the meeting|call ended|thanks for joining|meeting ended|el organizador (finaliz[oó]|termin[oó])|la reuni[oó]n (ha )?(finalizado|terminado)|esta reuni[oó]n ha (terminado|finalizado)|saliste de la reuni[oó]n|la llamada (ha )?(finalizado|terminado)|gracias por (unirte|participar)/i;

const REJOIN = /^(rejoin|volver a unirse|unirse de nuevo)$/i;

function hasCode(url: string): boolean {
  return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);
}

function blob(parts: string[]): string {
  return parts.join('\n');
}

export function callEndedFromSnapshot(snap: CallEndSnapshot): CallEndVerdict {
  const buttons = snap.buttons.map((b) => b.trim());
  if (buttons.some((b) => REJOIN.test(b))) {
    return { ended: true, reason: 'Meet mostró «Volver a unirse»: la llamada ya no está.' };
  }
  const copy = blob([...snap.headings, ...snap.dialogs, ...buttons]);
  if (ENDED_COPY.test(copy)) {
    return { ended: true, reason: 'Meet avisó que la reunión terminó.' };
  }
  if (snap.url.includes('meet.google.com') && !hasCode(snap.url) && !snap.hasParticipantTile) {
    return { ended: true, reason: 'Meet salió de la sala (ya no hay código en la URL).' };
  }
  return { ended: false, reason: null };
}

/** Corre en el browser. Solo DOM; el clasificador vive en Node. */
export function snapshotGoogleMeetCall(): CallEndSnapshot {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);

  const visibleText = (el: Element): string => {
    const cs = getComputedStyle(el as HTMLElement);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') {
      return '';
    }
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .map(visibleText)
    .filter(Boolean);
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map((el) => {
      const label = (el.getAttribute('aria-label') || '').trim();
      return label || visibleText(el);
    })
    .filter(Boolean);
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .map(visibleText)
    .filter(Boolean);

  const hasLeaveButton = buttons.some((b) =>
    /leave (call|meeting)|salir de (la )?(llamada|reuni[oó]n)|colgar/i.test(b),
  );

  return {
    url: location.href,
    headings,
    buttons,
    dialogs,
    hasParticipantTile: Boolean(document.querySelector('[data-participant-id]')),
    hasLeaveButton,
  };
}

export function callLostInCallChrome(snap: CallEndSnapshot): boolean {
  return !snap.hasParticipantTile && !snap.hasLeaveButton;
}
