/**
 * La línea de tiempo de una llamada: no el transcript, sino lo que PASÓ
 * alrededor — quién entró, quién compartió, un fotograma de la sala.
 *
 * `at` es segundos desde que Cortex (o el archivo) empezó a oír. Es la misma
 * unidad que `live_calls.transcript[].at`, para que un clic en un minuto
 * lleve a la frase de ese minuto.
 */

export const LIVE_CALLS_BUCKET = 'live-calls';

export const CALL_EVENT_KINDS = [
  'joined',
  'left',
  'presenting',
  'presenting-end',
  'frame',
] as const;

export type CallEventKind = (typeof CALL_EVENT_KINDS)[number];

export interface CallEvent {
  at: number;
  kind: CallEventKind;
  label: string;
  speaker?: string | null;
  path?: string | null;
  caption?: string | null;
}

export interface RosterPerson {
  id: string;
  name: string;
  speaking?: boolean;
  self?: boolean;
  presenting?: boolean;
}

const PRESENTING_RE =
  /\b(presenting|presentando|compartiendo|sharing (the )?screen|sharing a window)\b/i;

export function looksLikePresenting(raw: string | null | undefined): boolean {
  return Boolean(raw && PRESENTING_RE.test(raw));
}

export function clockAt(at: number): string {
  const sec = at > 1e12 ? Math.floor(at / 1000) : Math.max(0, Math.floor(at));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function isCallEvent(value: unknown): value is CallEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as CallEvent;
  return (
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    typeof e.label === 'string' &&
    (CALL_EVENT_KINDS as readonly string[]).includes(e.kind)
  );
}

export function normalizeTimeline(raw: unknown): CallEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CallEvent[] = [];
  for (const item of raw) {
    if (!isCallEvent(item)) continue;
    out.push({
      at: Math.max(0, item.at),
      kind: item.kind,
      label: item.label.slice(0, 240),
      speaker: item.speaker ?? null,
      path: item.path ?? null,
      caption: item.caption ?? null,
    });
    if (out.length >= 400) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

export function rosterDiff(
  previous: RosterPerson[],
  next: RosterPerson[],
  at: number,
): CallEvent[] {
  const prev = new Map(previous.filter((p) => !p.self).map((p) => [p.id || p.name, p]));
  const curr = new Map(next.filter((p) => !p.self).map((p) => [p.id || p.name, p]));
  const events: CallEvent[] = [];

  for (const [id, person] of curr) {
    if (!prev.has(id)) {
      events.push({
        at,
        kind: 'joined',
        label: `${person.name} entró`,
        speaker: person.name,
      });
    }
  }
  for (const [id, person] of prev) {
    if (!curr.has(id)) {
      events.push({
        at,
        kind: 'left',
        label: `${person.name} salió`,
        speaker: person.name,
      });
    }
  }

  const wasPresenting = previous.find((p) => p.presenting && !p.self)?.name ?? null;
  const isPresenting = next.find((p) => p.presenting && !p.self)?.name ?? null;
  if (wasPresenting !== isPresenting) {
    if (wasPresenting) {
      events.push({
        at,
        kind: 'presenting-end',
        label: `${wasPresenting} dejó de compartir`,
        speaker: wasPresenting,
      });
    }
    if (isPresenting) {
      events.push({
        at,
        kind: 'presenting',
        label: `${isPresenting} está compartiendo pantalla`,
        speaker: isPresenting,
      });
    }
  }
  return events;
}

/**
 * ¿Toca un fotograma ahora? Siempre al cambiar el compartir; si alguien
 * comparte, cada ~20 s; si no, cada ~75 s — y un techo para no llenar
 * app_files con una hora de mosaico vacío.
 */
export function shouldTakeFrame(input: {
  presentingChanged: boolean;
  presenting: boolean;
  secondsSinceFrame: number;
  framesTaken: number;
  maxFrames?: number;
}): boolean {
  const max = input.maxFrames ?? 80;
  if (input.framesTaken >= max) return false;
  if (input.presentingChanged) return true;
  const gap = input.presenting ? 20 : 75;
  return input.secondsSinceFrame >= gap;
}

export function formatTimelineForPrompt(events: CallEvent[]): string {
  if (events.length === 0) return '(no hubo eventos de sala ni capturas)';
  return events
    .map((e) => {
      const who = e.speaker ? ` · ${e.speaker}` : '';
      const seen = e.caption ? ` — ${e.caption}` : '';
      return `[${clockAt(e.at)}] ${e.kind}${who}: ${e.label}${seen}`;
    })
    .join('\n');
}

export function presentingFrames(events: CallEvent[], limit = 6): CallEvent[] {
  const hits = events.filter(
    (e) => e.path && (e.kind === 'presenting' || e.kind === 'frame') && e.speaker,
  );
  const starts = events.filter((e) => e.kind === 'presenting' && e.path);
  const picked = starts.length > 0 ? starts : hits;
  if (picked.length <= limit) return picked;
  const step = Math.ceil(picked.length / limit);
  return picked.filter((_, i) => i % step === 0).slice(0, limit);
}

export function liveCallObjectPath(owner: string, sessionId: string, name: string): string {
  const safeOwner = owner.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safeOwner}/${safeSession}/${safeName}`;
}
