import { describe, expect, it } from 'vitest';
import { CHAT_MODEL, FAST_MODEL, HEAVY_MODEL } from '../model';
import {
  DEFAULT_HAIKU_SHARE,
  HAIKU_TOOL_ERROR_LIMIT,
  assignArm,
  conversationBucket,
  decideTurnModel,
  needsHistory,
  parseHaikuShare,
} from '../model-experiment';

const ids = Array.from(
  { length: 2000 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);

describe('parseHaikuShare', () => {
  it('15 por defecto y acota a 0..100', () => {
    expect(parseHaikuShare(undefined)).toBe(DEFAULT_HAIKU_SHARE);
    expect(parseHaikuShare('')).toBe(15);
    expect(parseHaikuShare('abc')).toBe(15);
    expect(parseHaikuShare('0')).toBe(0);
    expect(parseHaikuShare('40')).toBe(40);
    expect(parseHaikuShare('250')).toBe(100);
    expect(parseHaikuShare('-3')).toBe(0);
  });
});

describe('asignación estable por conversación', () => {
  it('la misma conversación cae siempre en el mismo brazo', () => {
    for (const id of ids.slice(0, 50)) {
      expect(assignArm(id, 15)).toBe(assignArm(id, 15));
      expect(conversationBucket(id)).toBe(conversationBucket(id));
    }
  });

  it('el reparto se acerca al porcentaje pedido', () => {
    const share = (pct: number) =>
      ids.filter((id) => assignArm(id, pct) === 'haiku').length / ids.length;
    expect(share(15)).toBeGreaterThan(0.11);
    expect(share(15)).toBeLessThan(0.19);
    expect(share(0)).toBe(0);
    expect(share(100)).toBe(1);
  });

  it('subir el porcentaje sólo suma conversaciones, no mueve las que ya estaban', () => {
    for (const id of ids.slice(0, 300)) {
      if (assignArm(id, 15) === 'haiku') expect(assignArm(id, 30)).toBe('haiku');
    }
  });
});

describe('decideTurnModel', () => {
  const haikuId = ids.find((id) => assignArm(id, 15) === 'haiku') as string;
  const sonnetId = ids.find((id) => assignArm(id, 15) === 'sonnet') as string;
  const cfg = { configuredModel: 'claude-sonnet-5', haikuShare: 15 };

  it('conversación del brazo Haiku corre en Haiku 5.5', () => {
    expect(decideTurnModel({ conversationId: haikuId, ...cfg })).toEqual({
      model: FAST_MODEL,
      arm: 'haiku',
      fellBack: false,
    });
  });

  it('conversación del brazo Sonnet corre en Sonnet 5.5', () => {
    const d = decideTurnModel({ conversationId: sonnetId, ...cfg });
    expect(d).toMatchObject({ model: CHAT_MODEL, arm: 'sonnet', fellBack: false });
  });

  it('dos fallos de herramienta sacan a la conversación de Haiku, y ya no vuelve', () => {
    const one = decideTurnModel({
      conversationId: haikuId,
      ...cfg,
      history: { toolErrors: HAIKU_TOOL_ERROR_LIMIT - 1, refusals: 0 },
    });
    expect(one.model).toBe(FAST_MODEL);
    const two = decideTurnModel({
      conversationId: haikuId,
      ...cfg,
      history: { toolErrors: HAIKU_TOOL_ERROR_LIMIT, refusals: 0 },
    });
    expect(two).toEqual({ model: CHAT_MODEL, arm: 'haiku', fellBack: true, reason: 'tool_errors' });
  });

  it('un refusal basta, y gana sobre los fallos de herramienta', () => {
    const d = decideTurnModel({
      conversationId: haikuId,
      ...cfg,
      history: { toolErrors: 5, refusals: 1 },
    });
    expect(d).toMatchObject({ model: CHAT_MODEL, fellBack: true, reason: 'refusal' });
  });

  it('el historial no mueve a las conversaciones de Sonnet', () => {
    const d = decideTurnModel({
      conversationId: sonnetId,
      ...cfg,
      history: { toolErrors: 9, refusals: 9 },
    });
    expect(d).toMatchObject({ model: CHAT_MODEL, arm: 'sonnet', fellBack: false });
  });

  it('un agente apuntado a Opus no entra al experimento', () => {
    const d = decideTurnModel({
      conversationId: haikuId,
      configuredModel: 'claude-opus-5',
      haikuShare: 100,
    });
    expect(d).toEqual({ model: HEAVY_MODEL, arm: null, fellBack: false });
  });

  it('con 0 % nadie va a Haiku', () => {
    expect(decideTurnModel({ conversationId: haikuId, ...cfg, haikuShare: 0 })).toMatchObject({
      model: CHAT_MODEL,
      arm: null,
    });
  });

  it('sólo las conversaciones de Haiku piden el historial', () => {
    expect(needsHistory({ conversationId: haikuId, ...cfg })).toBe(true);
    expect(needsHistory({ conversationId: sonnetId, ...cfg })).toBe(false);
  });
});
