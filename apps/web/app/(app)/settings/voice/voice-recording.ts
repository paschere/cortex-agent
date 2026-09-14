export const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 30;
export const MIN_SAMPLE_SECONDS = 5;

export type RecordingKind = 'consent' | 'sample';

export function recordingDurationError(kind: RecordingKind, seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'No pudimos leer la duración del audio.';
  if (seconds > MAX_RECORDING_SECONDS + 0.25) return 'El audio debe durar 30 segundos o menos.';
  if (kind === 'sample' && seconds < MIN_SAMPLE_SECONDS) {
    return 'La muestra necesita al menos 5 segundos de voz.';
  }
  return null;
}

export function recordingSizeError(bytes: number): string | null {
  return bytes > MAX_RECORDING_BYTES ? 'Cada audio puede pesar máximo 2 MB.' : null;
}

export function formatDuration(seconds: number): string {
  return `0:${String(Math.round(seconds)).padStart(2, '0')}`;
}

export function stopStaleStream(
  stream: Pick<MediaStream, 'getTracks'>,
  mounted: boolean,
  generationMatches: boolean,
): boolean {
  if (mounted && generationMatches) return false;
  for (const track of stream.getTracks()) track.stop();
  return true;
}
