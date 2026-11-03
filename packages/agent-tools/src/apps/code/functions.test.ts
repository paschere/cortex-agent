import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FN_MAX_INPUT_BYTES,
  assertFunctionName,
  assertSecretName,
  buildRuleInput,
  capLog,
  checkFunctionInput,
  hashHookToken,
  hookTokenMatches,
  mintFnToken,
  newHookToken,
  verifyFnToken,
} from './functions';
import { summarizeResult } from './rule-action';

const claims = {
  org: 'org-1',
  app: '11111111-1111-4111-8111-111111111111',
  actor: { kind: 'member' as const, id: 'u-1', name: 'Ana' },
  role: 'operario',
  attributes: { cliente: 'Andina' },
  readOnly: false,
  fn: 'cobrar',
};

describe('nombres', () => {
  it('función: minúsculas, números y guion bajo', () => {
    expect(() => assertFunctionName('cobrar_tarifa')).not.toThrow();
    for (const bad of ['Cobrar', '1abc', 'a', 'con-guion', 'x'.repeat(49), 'a b'])
      expect(() => assertFunctionName(bad)).toThrow();
  });
  it('secreto: MAYÚSCULAS y guion bajo', () => {
    expect(() => assertSecretName('SIIGO_API_KEY')).not.toThrow();
    for (const bad of ['siigo', 'Siigo_Key', '1KEY', 'A', 'KEY-X'])
      expect(() => assertSecretName(bad)).toThrow();
  });
});

describe('token de la corrida', () => {
  const prev = process.env.JOBS_SECRET;
  beforeEach(() => {
    process.env.JOBS_SECRET = 'secreto-de-prueba';
  });
  afterEach(() => {
    if (prev === undefined) process.env.JOBS_SECRET = undefined as never;
    else process.env.JOBS_SECRET = prev;
  });

  it('firma y verifica, y trae el rol y el actor', () => {
    const t = mintFnToken(claims, 1_000);
    const c = verifyFnToken(t, 2_000);
    expect(c?.role).toBe('operario');
    expect(c?.actor.id).toBe('u-1');
    expect(c?.attributes).toEqual({ cliente: 'Andina' });
    expect(c?.readOnly).toBe(false);
  });
  it('vence a los 5 minutos', () => {
    const t = mintFnToken(claims, 1_000);
    expect(verifyFnToken(t, 1_000 + 5 * 60_000 - 1)).not.toBeNull();
    expect(verifyFnToken(t, 1_000 + 5 * 60_000 + 1)).toBeNull();
  });
  it('un payload alterado (rol distinto) no verifica', () => {
    const t = mintFnToken(claims, 1_000);
    const [payload, sig] = t.split('.') as [string, string];
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.role = 'administrador';
    const bad = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect(verifyFnToken(bad, 2_000)).toBeNull();
  });
  it('basura, vacío y token de otro secreto no verifican', () => {
    expect(verifyFnToken('', 0)).toBeNull();
    expect(verifyFnToken('abc', 0)).toBeNull();
    expect(verifyFnToken('a.b', 0)).toBeNull();
    const t = mintFnToken(claims, 1_000);
    process.env.JOBS_SECRET = 'otro';
    expect(verifyFnToken(t, 2_000)).toBeNull();
  });
  it('sin JOBS_SECRET no firma ni verifica', () => {
    const t = mintFnToken(claims, 1_000);
    process.env.JOBS_SECRET = '';
    expect(() => mintFnToken(claims)).toThrow();
    expect(verifyFnToken(t, 2_000)).toBeNull();
  });
});

describe('token de webhook', () => {
  it('es aleatorio, con prefijo, y se compara por hash', () => {
    const a = newHookToken();
    const b = newHookToken();
    expect(a).toMatch(/^cxh_/);
    expect(a).not.toBe(b);
    const hash = hashHookToken(a);
    expect(hash).not.toContain(a);
    expect(hookTokenMatches(a, hash)).toBe(true);
    expect(hookTokenMatches(b, hash)).toBe(false);
    expect(hookTokenMatches('', hash)).toBe(false);
  });
});

describe('entrada de la función', () => {
  it('lo vacío es {} y lo serializable pasa', () => {
    expect(checkFunctionInput(undefined)).toEqual({});
    expect(checkFunctionInput({ a: 1, b: [1, 2] })).toEqual({ a: 1, b: [1, 2] });
  });
  it('rechaza lo que no es JSON y lo demasiado grande', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => checkFunctionInput(circular)).toThrow();
    expect(() => checkFunctionInput({ x: 'a'.repeat(FN_MAX_INPUT_BYTES + 1) })).toThrow();
  });
  it('la entrada de una regla pinta {{campos}} y suma la fila si se pide', () => {
    const render = (t: string) => t.replace('{{guia}}', 'G-77');
    const input = buildRuleInput({ ref: 'Guía {{guia}}', n: 3, ok: true, nada: null }, render);
    expect(input).toEqual({ ref: 'Guía G-77', n: 3, ok: true, nada: null });
    const withRow = buildRuleInput({ a: 'x' }, render, { id: 'r1', values: { guia: 'G-77' } });
    expect(withRow).toEqual({ a: 'x', row: { guia: 'G-77' }, rowId: 'r1' });
  });
});

describe('logs y resultados', () => {
  it('capLog deja principio y final', () => {
    const log = `${'a'.repeat(30_000)}FIN`;
    const out = capLog(log, 1000);
    expect(out.length).toBeLessThanOrEqual(1050);
    expect(out.endsWith('FIN')).toBe(true);
    expect(out).toContain('recortado');
    expect(capLog('corto')).toBe('corto');
  });
  it('summarizeResult resume en una línea', () => {
    expect(summarizeResult(null)).toBe('');
    expect(summarizeResult({ a: 1 })).toBe('{"a":1}');
    expect(summarizeResult('x'.repeat(300)).length).toBeLessThanOrEqual(160);
  });
});
