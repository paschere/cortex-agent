/** Only explicit visual requests trigger a new screenshot. Source names alone do not. */
export function wantsCurrentMeetingView(text: string): boolean {
  const value = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\b(no mires|no captures|no tomes|sin captura|no veas)\b/.test(value)) return false;
  return /\b(lo que (estoy|estamos) (mirando|viendo|mostrando|compartiendo)|mira (esto|aqui|lo que|mi pantalla|la pantalla)|ves (esto|mi pantalla|la pantalla)|captura (de )?(la |mi )?pantalla|revisa (esto|lo que|la pantalla)|analiza (esto|lo que|la pantalla))\b/.test(
    value,
  );
}
export interface MeetingVoiceSnapshot {
  imageBase64: string;
  capturedAt: number;
  scope: 'meeting-viewport';
}
