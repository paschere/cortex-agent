import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rerankByMeaning, rerankPassages, rerankerAvailable } from '../reranker';

const PASSAGES = ['uno', 'dos', 'tres', 'cuatro'];

function reply(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

let originalKey: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalKey = process.env.VOYAGE_API_KEY;
  originalFetch = globalThis.fetch;
  process.env.VOYAGE_API_KEY = 'test-key';
  process.env.KB_RERANK = 'on';
});

afterEach(() => {
  if (originalKey === undefined) process.env.VOYAGE_API_KEY = '';
  else process.env.VOYAGE_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  process.env.KB_RERANK = '';
});

describe('rerankerAvailable', () => {
  it('está apagado sin llave, y apagado si alguien lo apaga', () => {
    process.env.VOYAGE_API_KEY = '';
    expect(rerankerAvailable()).toBe(false);
    process.env.VOYAGE_API_KEY = 'k';
    expect(rerankerAvailable()).toBe(true);
    process.env.KB_RERANK = 'off';
    expect(rerankerAvailable()).toBe(false);
  });
});

describe('rerankPassages', () => {
  it('devuelve el orden que dijo el proveedor', async () => {
    globalThis.fetch = reply({ data: [{ index: 2 }, { index: 0 }, { index: 3 }, { index: 1 }] });
    const out = await rerankPassages('¿la tarifa?', PASSAGES);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.order).toEqual([2, 0, 3, 1]);
  });

  it('lo que el proveedor no mencionó se queda detrás, nunca se pierde', async () => {
    // Una permutación incompleta es un resultado plausible y silencioso: sin
    // esto, dos de los cuatro pasajes desaparecerían de la respuesta.
    globalThis.fetch = reply({ data: [{ index: 3 }, { index: 1 }] });
    const out = await rerankPassages('x', PASSAGES);
    expect(out.ok).toBe(true);
    if (out.ok) expect([...out.order].sort()).toEqual([0, 1, 2, 3]);
    if (out.ok) expect(out.order.slice(0, 2)).toEqual([3, 1]);
  });

  it('ignora índices repetidos o fuera de rango', async () => {
    globalThis.fetch = reply({
      data: [{ index: 1 }, { index: 1 }, { index: 99 }, { index: -1 }, { index: 0 }],
    });
    const out = await rerankPassages('x', PASSAGES);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.order).toHaveLength(4);
      expect(new Set(out.order).size).toBe(4);
      expect(out.order.slice(0, 2)).toEqual([1, 0]);
    }
  });

  it('un fallo del proveedor no es una excepción, es un "no corrió"', async () => {
    globalThis.fetch = reply({ error: 'nope' }, 500);
    const out = await rerankPassages('x', PASSAGES);
    expect(out.ok).toBe(false);
  });
});

describe('rerankByMeaning', () => {
  it('reordena los objetos sin cambiar el conjunto', async () => {
    globalThis.fetch = reply({ data: [{ index: 1 }, { index: 0 }] });
    const items = [
      { id: 'a', text: 'uno' },
      { id: 'b', text: 'dos' },
    ];
    const out = await rerankByMeaning('x', items, (i) => i.text);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('sin llave devuelve exactamente lo que recibió, sin llamar a nadie', async () => {
    process.env.VOYAGE_API_KEY = '';
    const called = vi.fn();
    globalThis.fetch = called as unknown as typeof fetch;
    const items = [
      { id: 'a', text: 'uno' },
      { id: 'b', text: 'dos' },
    ];
    const out = await rerankByMeaning('x', items, (i) => i.text);
    expect(out).toEqual(items);
    expect(called).not.toHaveBeenCalled();
  });
});
