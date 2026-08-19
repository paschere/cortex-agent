import { describe, expect, it } from 'vitest';
import type { BrainStats, DigestingDoc, IntakeKey, SourceStats } from '../_components/types';
import {
  MAX_SCALE,
  MIN_SCALE,
  arrivedInMemory,
  centreOn,
  clampView,
  countBySource,
  fitView,
  focusStats,
  litSet,
  livingSubtitle,
  neighbourMap,
  panBy,
  scaleOf,
  zoomAt,
} from './view';

const SIZE = 420;

function slice(over: Partial<SourceStats> = {}): SourceStats {
  return {
    stages: { waiting: 0, digesting: 0, memory: 0, stuck: 0 },
    growth: [{ start: '2026-01-05T00:00:00.000Z', added: 0 }],
    spokenSeconds: 0,
    namedVoices: 0,
    unnamedRecordings: 0,
    lastAddedAt: null,
    digesting: [],
    ...over,
  };
}

function stats(over: Partial<BrainStats> = {}): BrainStats {
  return {
    stages: { waiting: 1, digesting: 2, memory: 30, stuck: 1 },
    intake: { upload: 10, record: 4, meeting: 2, drive: 1 },
    indexed: { upload: 9, record: 3, meeting: 2, drive: 1 },
    growth: [{ start: '2026-01-05T00:00:00.000Z', added: 17 }],
    chunks: 1200,
    spokenSeconds: 7200,
    namedVoices: 6,
    unnamedRecordings: 2,
    lastAddedAt: '2026-01-09T00:00:00.000Z',
    digesting: [],
    bySource: {
      upload: slice(),
      record: slice({
        stages: { waiting: 1, digesting: 0, memory: 3, stuck: 0 },
        spokenSeconds: 5400,
        namedVoices: 4,
        lastAddedAt: '2026-01-08T00:00:00.000Z',
      }),
      meeting: slice(),
      drive: slice(),
    },
    ...over,
  };
}

describe('focusStats', () => {
  it('hands back the whole reading when no lobe is chosen', () => {
    const whole = stats();
    expect(focusStats(whole, null)).toBe(whole);
  });

  it('replaces every figure below the plate with the chosen source', () => {
    const view = focusStats(stats(), 'record');
    expect(view.stages).toEqual({ waiting: 1, digesting: 0, memory: 3, stuck: 0 });
    expect(view.spokenSeconds).toBe(5400);
    expect(view.namedVoices).toBe(4);
    expect(view.lastAddedAt).toBe('2026-01-08T00:00:00.000Z');
  });

  it('drops the fragment count rather than invent a per-source one', () => {
    // Fragments are counted with a join on spaces, not on sources: there is no
    // honest figure, so the panel is given a null it already knows to omit.
    expect(focusStats(stats(), 'record').chunks).toBeNull();
  });

  it('leaves the plate and the four mouths whole, because they are the control', () => {
    const view = focusStats(stats(), 'record');
    expect(view.indexed).toEqual({ upload: 9, record: 3, meeting: 2, drive: 1 });
    expect(view.intake).toEqual({ upload: 10, record: 4, meeting: 2, drive: 1 });
  });
});

describe('arrivedInMemory', () => {
  const doc = (id: string): DigestingDoc => ({
    id,
    title: id,
    spaceName: 'Espacio',
    stage: 'digesting',
    transcribing: false,
  });

  it('names what left the belt while the remembered count rose', () => {
    const done = arrivedInMemory([doc('a'), doc('b')], [doc('b')], 1);
    expect(done.map((d) => d.id)).toEqual(['a']);
  });

  it('says nothing when the count did not move — that document broke', () => {
    expect(arrivedInMemory([doc('a')], [], 0)).toEqual([]);
  });

  it('never claims more arrivals than the count allows', () => {
    // One was indexed and one failed: only one may be announced.
    const done = arrivedInMemory([doc('a'), doc('b')], [], 1);
    expect(done).toHaveLength(1);
  });

  it('is quiet while nothing has changed', () => {
    expect(arrivedInMemory([doc('a')], [doc('a')], 1)).toEqual([]);
  });
});

describe('neighbourMap and litSet', () => {
  const semantic = [
    { a: 'x', b: 'y' },
    { a: 'y', b: 'z' },
  ];
  const people = [{ a: 'x', b: 'w' }];

  it('joins both ends of every edge, from both kinds', () => {
    const map = neighbourMap(semantic, people);
    expect([...(map.get('x') ?? [])].sort()).toEqual(['w', 'y']);
    expect([...(map.get('y') ?? [])].sort()).toEqual(['x', 'z']);
  });

  it('lights a node and its neighbours, and nothing else', () => {
    const lit = litSet('x', neighbourMap(semantic, people));
    expect(lit).toEqual(new Set(['x', 'w', 'y']));
    expect(lit?.has('z')).toBe(false);
  });

  it('lights nothing when nothing is pointed at', () => {
    expect(litSet(null, neighbourMap(semantic))).toBeNull();
  });
});

describe('the viewBox', () => {
  it('starts fitting the drawing exactly', () => {
    expect(scaleOf(fitView(SIZE), SIZE)).toBe(1);
  });

  it('keeps the point under the pointer where it was', () => {
    const zoomed = zoomAt(fitView(SIZE), SIZE, 2, 100, 100);
    // Halving the window about (100,100) leaves that point at the same
    // fraction across it — a quarter in, since it was a quarter in before.
    expect((100 - zoomed.x) / zoomed.w).toBeCloseTo(100 / SIZE, 5);
  });

  it('will not be pushed past its own limits', () => {
    let view = fitView(SIZE);
    for (let i = 0; i < 40; i += 1) view = zoomAt(view, SIZE, 2, 210, 210);
    expect(scaleOf(view, SIZE)).toBeCloseTo(MAX_SCALE, 5);
    for (let i = 0; i < 40; i += 1) view = zoomAt(view, SIZE, 0.5, 210, 210);
    expect(scaleOf(view, SIZE)).toBeCloseTo(MIN_SCALE, 5);
  });

  it('does not let the drawing be flicked off into empty space', () => {
    const far = panBy(fitView(SIZE), 5000, 5000, SIZE);
    const clamped = clampView(far, SIZE);
    expect(clamped).toEqual(far);
    expect(far.x).toBeGreaterThanOrEqual(-SIZE);
    expect(far.x).toBeLessThanOrEqual(SIZE);
  });

  it('centres a node when one is opened', () => {
    const zoomed = zoomAt(fitView(SIZE), SIZE, 3, 210, 210);
    const centred = centreOn(zoomed, SIZE, 210, 60);
    expect(centred.x + centred.w / 2).toBeCloseTo(210, 5);
    // The rim is inside the overscroll allowance, so it really does centre.
    expect(centred.y + centred.h / 2).toBeCloseTo(60, 5);
  });
});

describe('livingSubtitle', () => {
  it('invites feeding when there is nothing to walk yet', () => {
    expect(livingSubtitle({ chunks: 0, spaces: 0, lastAdded: null })).toContain(
      'Todavía no guarda nada',
    );
    expect(livingSubtitle({ chunks: 0, spaces: 0, lastAdded: null })).toContain(
      'suelta un archivo y pídele que lo recuerde',
    );
  });

  it('does not ask for a space when the shelves are already there', () => {
    const line = livingSubtitle({ chunks: 0, spaces: 2, lastAdded: null });
    expect(line).toContain('Los espacios ya están');
    expect(line).not.toContain('Crea un espacio');
    expect(line).toContain('suelta un archivo');
  });

  it('names the fragments and still invites feeding while the corpus is thin', () => {
    const line = livingSubtitle({ chunks: 8, spaces: 2, lastAdded: 'hace 3 h' });
    expect(line).toContain('8 fragmentos');
    expect(line).toContain('2 espacios');
    expect(line).toContain('Todavía cabe más');
    expect(line).toContain('suelta un archivo');
  });

  it('reads as a living memory once there is something to review', () => {
    const line = livingSubtitle({ chunks: 1284, spaces: 4, lastAdded: 'hace 2 h' });
    expect(line).toContain('1.284 fragmentos');
    expect(line).toContain('4 espacios');
    expect(line).toContain('hace 2 h');
    expect(line).toContain('Recorre las zonas');
    expect(line).toContain('el chat también alimenta');
  });

  it('does not invent a fragment count when the reading came back null', () => {
    const line = livingSubtitle({ chunks: null, spaces: 3, lastAdded: null });
    expect(line).not.toMatch(/\d+\s+fragmentos/);
    expect(line).toContain('3 espacios');
  });
});

describe('countBySource', () => {
  it('counts the hits per mouth, and zero is a real answer', () => {
    const hits: Array<{ source: IntakeKey }> = [
      { source: 'record' },
      { source: 'record' },
      { source: 'upload' },
    ];
    expect(countBySource(hits)).toEqual({ upload: 1, record: 2, meeting: 0, drive: 0 });
  });
});
