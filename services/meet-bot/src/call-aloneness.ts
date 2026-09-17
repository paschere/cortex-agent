/**
 * Cuándo colgar porque la sala se quedó sola — el criterio de Vexa (#545):
 * no el censo del DOM (un refresh borra los tiles y echa al bot), sino
 * silencio remoto. El roster vacío solo acelera el mismo veredicto.
 */

export const REMOTE_AUDIO_FLOOR = 0.0005;

export function heardRemoteAudio(recentPeak: number, floor = REMOTE_AUDIO_FLOOR): boolean {
  return recentPeak >= floor;
}

/** Gente se fue (roster vacío después de haber visto a alguien) Y la sala está muda. */
export function shouldLeaveEmptyAndSilent(input: {
  sawOthers: boolean;
  othersCount: number;
  emptyMs: number;
  silentMs: number;
  everyoneLeftTimeoutMs: number;
}): boolean {
  if (input.everyoneLeftTimeoutMs <= 0) return false;
  if (!input.sawOthers || input.othersCount > 0) return false;
  return (
    input.emptyMs >= input.everyoneLeftTimeoutMs && input.silentMs >= input.everyoneLeftTimeoutMs
  );
}

/**
 * Nadie habló el rato configurado (default 10 min, como Vexa). Cubre sala
 * vacía y notetakers mudos que el roster sigue contando.
 */
export function shouldLeaveBySilence(input: {
  liveMs: number;
  silentMs: number;
  aloneSilenceMs: number;
  graceMs?: number;
}): boolean {
  if (input.aloneSilenceMs <= 0) return false;
  if (input.liveMs < (input.graceMs ?? 30_000)) return false;
  return input.silentMs >= input.aloneSilenceMs;
}
