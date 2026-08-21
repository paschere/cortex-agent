/**
 * Cuándo el tap de audio se murió a mitad de llamada — la misma clase de fallo
 * que Vexa midió con ScriptProcessor (#204): el grafo sigue “vivo” (chunks o
 * pistas) pero ya no hay PCM que transcribir.
 *
 * Se evalúa en Node con el snapshot de `__cortexTap.level()`, no dentro de Meet.
 */

export interface CaptureLevel {
  chunks: number;
  live: number;
  recentPeak: number;
  playing: number;
  speaker: string | null;
}

/** El procesador dejó de emitir: mismo contador de chunks entre dos lecturas. */
export function chunksStalled(previousChunks: number, nextChunks: number): boolean {
  return nextChunks <= previousChunks;
}

/**
 * Hay pistas live pero el tap no oye. Si Meet marca a alguien hablando, el
 * cableado está muerto (no es un silencio real de la sala).
 */
export function silentWhileLive(level: Pick<CaptureLevel, 'live' | 'recentPeak'>): boolean {
  return level.live > 0 && level.recentPeak < 0.0005;
}

/** Reiniciar el AudioContext/worklet: 2 lecturas seguidas (~20 s) sin chunks nuevos. */
export function shouldRestartCapture(stallRounds: number): boolean {
  return stallRounds >= 2;
}

/**
 * Re-enganchar pistas: alguien “hablando” en el DOM y pico 0 → 1 ronda (~10 s);
 * pistas live y silencio total → 3 rondas (~30 s, gente callada de verdad).
 */
export function shouldRewireTracks(input: {
  silentRounds: number;
  speaker: string | null;
  live: number;
  recentPeak: number;
}): boolean {
  if (!silentWhileLive(input)) return false;
  if (input.speaker) return input.silentRounds >= 1;
  return input.silentRounds >= 3;
}
