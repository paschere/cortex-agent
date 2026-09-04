/**
 * Qué fotograma tomar y qué evento de sala anotar.
 *
 * El contrato (at en segundos, kinds, techos) vive también en
 * packages/agent-tools/src/meetings/timeline.ts — este archivo no puede
 * importarlo: la imagen Docker del bot no incluye ese paquete.
 */

export type CallEventKind = 'joined' | 'left' | 'presenting' | 'presenting-end' | 'frame';

export interface CallEvent {
  at: number;
  kind: CallEventKind;
  label: string;
  speaker?: string | null;
  path?: string | null;
}

export interface RosterPerson {
  id: string;
  name: string;
  speaking?: boolean;
  self?: boolean;
  presenting?: boolean;
}

export function looksLikePresenting(raw: string | null | undefined): boolean {
  return Boolean(
    raw &&
      /\b(presenting|presentando|compartiendo|sharing (the )?screen|sharing a window)\b/i.test(
        raw,
      ),
  );
}

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
  return input.secondsSinceFrame >= (input.presenting ? 20 : 75);
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
      events.push({ at, kind: 'joined', label: `${person.name} entró`, speaker: person.name });
    }
  }
  for (const [id, person] of prev) {
    if (!curr.has(id)) {
      events.push({ at, kind: 'left', label: `${person.name} salió`, speaker: person.name });
    }
  }
  const was = previous.find((p) => p.presenting && !p.self)?.name ?? null;
  const now = next.find((p) => p.presenting && !p.self)?.name ?? null;
  if (was !== now) {
    if (was) {
      events.push({
        at,
        kind: 'presenting-end',
        label: `${was} dejó de compartir`,
        speaker: was,
      });
    }
    if (now) {
      events.push({
        at,
        kind: 'presenting',
        label: `${now} está compartiendo pantalla`,
        speaker: now,
      });
    }
  }
  return events;
}

export async function uploadVisualFrame(input: {
  cortexBaseUrl: string;
  serviceToken: string;
  owner: string;
  sessionId: string;
  at: number;
  kind: CallEventKind;
  label: string;
  speaker?: string | null;
  jpeg: Buffer;
}): Promise<string | null> {
  if (input.jpeg.length < 80 || input.jpeg.length > 1_500_000) return null;
  const url = `${input.cortexBaseUrl.replace(/\/+$/, '')}/api/meetings/live/visual`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.serviceToken}`,
      'content-type': 'image/jpeg',
      'x-cortex-owner': input.owner,
      'x-cortex-session': input.sessionId,
      'x-cortex-at': String(Math.round(input.at * 10) / 10),
      'x-cortex-kind': input.kind,
      'x-cortex-label': encodeURIComponent(input.label.slice(0, 180)),
      'x-cortex-speaker': encodeURIComponent(input.speaker ?? ''),
    },
    body: new Uint8Array(input.jpeg),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[cortex-meet] visual ${input.sessionId} HTTP ${res.status} ${text.slice(0, 160)}`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { path?: string } | null;
  return body?.path ?? null;
}
