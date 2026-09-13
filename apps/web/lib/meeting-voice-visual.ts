export const MAX_MEETING_VOICE_VISUAL_BYTES = 1_572_864;
export const MAX_MEETING_VOICE_VISUAL_AGE_MS = 30_000;
export const MAX_MEETING_VOICE_VISUAL_FUTURE_MS = 5_000;

export interface MeetingVoiceVisual {
  imageBase64: string;
  capturedAt: number;
  scope: 'meeting-viewport';
}

export type MeetingVoiceVisualValidation =
  | { ok: true; value: MeetingVoiceVisual }
  | { ok: false; error: string };

/** Validates the one ephemeral image shape accepted by the meeting voice route. */
export function validateMeetingVoiceVisual(
  input: unknown,
  now = Date.now(),
): MeetingVoiceVisualValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'visual must be an object' };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'capturedAt,imageBase64,scope') {
    return { ok: false, error: 'visual has an invalid schema' };
  }
  if (record.scope !== 'meeting-viewport') {
    return { ok: false, error: 'visual has an invalid scope' };
  }
  if (!Number.isInteger(record.capturedAt)) {
    return { ok: false, error: 'visual has an invalid timestamp' };
  }
  const capturedAt = record.capturedAt as number;
  if (capturedAt < now - MAX_MEETING_VOICE_VISUAL_AGE_MS) {
    return { ok: false, error: 'visual is stale' };
  }
  if (capturedAt > now + MAX_MEETING_VOICE_VISUAL_FUTURE_MS) {
    return { ok: false, error: 'visual timestamp is in the future' };
  }
  if (typeof record.imageBase64 !== 'string') {
    return { ok: false, error: 'visual image must be base64' };
  }
  const imageBase64 = record.imageBase64;
  const maxEncodedLength = Math.ceil(MAX_MEETING_VOICE_VISUAL_BYTES / 3) * 4;
  if (
    imageBase64.length < 4 ||
    imageBase64.length > maxEncodedLength ||
    imageBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
  ) {
    return { ok: false, error: 'visual image has invalid base64' };
  }
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.toString('base64') !== imageBase64) {
    return { ok: false, error: 'visual image has non-canonical base64' };
  }
  if (bytes.length > MAX_MEETING_VOICE_VISUAL_BYTES) {
    return { ok: false, error: 'visual image is too large' };
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return { ok: false, error: 'visual image is not a JPEG' };
  }
  return {
    ok: true,
    value: { imageBase64, capturedAt, scope: 'meeting-viewport' },
  };
}
