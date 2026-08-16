import { describe, expect, it } from 'vitest';
import { decodeBytea, encodeBytea } from '../store';

/**
 * Los helpers hex son la frontera entre "bytes" y "lo que PostgREST acepta".
 * Si la ida y vuelta pierde un byte, un PDF llega corrupto y nadie ve un error
 * — por eso el test cubre los bytes que suelen romper codificaciones: 0x00,
 * 0xff, y contenido binario arbitrario.
 */
describe('encodeBytea / decodeBytea', () => {
  it('hace la ida y vuelta sin perder un byte', () => {
    const cases: Uint8Array[] = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]),
      new Uint8Array(Buffer.from('hola, Cortex ⚡ — bytes con acentos y emoji', 'utf8')),
      // 4KB de "binario" determinista, cubre los 256 valores.
      new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256)),
    ];
    for (const bytes of cases) {
      const encoded = encodeBytea(bytes);
      expect(encoded.startsWith('\\x')).toBe(true);
      const decoded = decodeBytea(encoded);
      expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('produce el formato hex que Postgres entiende', () => {
    expect(encodeBytea(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('\\xdeadbeef');
  });

  it('rechaza representaciones que no son \\x + hex, en vez de decodificar basura', () => {
    expect(() => decodeBytea('deadbeef')).toThrow(/bytea/);
    expect(() => decodeBytea('\\xzz')).toThrow(/hex/);
    expect(() => decodeBytea('\\xabc')).toThrow(/hex/);
  });
});
