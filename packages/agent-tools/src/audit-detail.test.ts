import { describe, expect, it } from 'vitest';
import { REDACTED, buildAuditDetail, captureBefore, sanitizeForAudit } from './audit-detail';

describe('audit-detail', () => {
  it('tapa claves que parecen secretos y recorta cadenas largas', () => {
    const out = sanitizeForAudit({
      to: 'ana@x.com',
      apiKey: 'sk-123',
      password: 'x',
      body: 'a'.repeat(500),
      nested: { authToken: 'zzz', ok: 1 },
      markdown: 'no se guarda',
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).authToken).toBe(REDACTED);
    expect((out.body as string).length).toBeLessThan(200);
    expect(out.markdown).toBeUndefined();
    expect(out.to).toBe('ana@x.com');
  });

  it('las listas largas guardan los primeros y el total', () => {
    expect(sanitizeForAudit({ to: Array.from({ length: 9 }, (_, i) => `a${i}@x.com`) })).toEqual({
      to: { items: ['a0@x.com', 'a1@x.com', 'a2@x.com', 'a3@x.com', 'a4@x.com'], total: 9 },
    });
  });

  it('el estado de antes va entero o no va', () => {
    expect(captureBefore({ estado: 'Abierto', n: 3 })).toEqual({ estado: 'Abierto', n: 3 });
    expect(captureBefore({ nota: 'x'.repeat(600) })).toBeNull();
    expect(captureBefore({ token: 'abc' })).toBeNull();
    expect(captureBefore({ objeto: { a: 1 } })).toBeNull();
    expect(captureBefore(null)).toBeNull();
  });

  it('arma el detalle con entrada, resultado y antes', () => {
    const d = buildAuditDetail({
      input: { tracker: 'vuelos' },
      output: { created: false, row: { id: 'r' } },
      before: { estado: 'A' },
    });
    expect(d).toEqual({
      input: { tracker: 'vuelos' },
      result: { created: false, row: { id: 'r' } },
      before: { estado: 'A' },
    });
  });
});
