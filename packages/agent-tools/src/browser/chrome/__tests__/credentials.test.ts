import { describe, expect, it } from 'vitest';
import {
  bearerOf,
  deviceOnline,
  deviceUsable,
  generateDeviceToken,
  generatePairingCode,
  hashSecret,
  looksLikeDeviceToken,
  normalizePairingCode,
  sameHash,
} from '../credentials';

describe('código de emparejamiento', () => {
  it('tiene la forma XXXX-XXXX con el alfabeto sin confusiones', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = generatePairingCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });
  it('no se repite (entropía básica)', () => {
    const s = new Set(Array.from({ length: 500 }, () => generatePairingCode()));
    expect(s.size).toBe(500);
  });
  it('normaliza lo que la persona escribe y rechaza lo que no puede ser un código', () => {
    expect(normalizePairingCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(normalizePairingCode(' abcd-efgh ')).toBe('ABCD-EFGH');
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFG0')).toBeNull(); // 0 no existe en el alfabeto
    expect(normalizePairingCode('ABCD-EFGO')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });
});

describe('token de dispositivo', () => {
  it('lleva prefijo, no es predecible y solo se guarda su hash', () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a.token).not.toBe(b.token);
    expect(looksLikeDeviceToken(a.token)).toBe(true);
    expect(a.hash).toBe(hashSecret(a.token));
    expect(a.hash).not.toContain(a.token);
    expect(a.prefix).toBe(a.token.slice(0, 10));
    expect(sameHash(a.hash, hashSecret(a.token))).toBe(true);
    expect(sameHash(a.hash, b.hash)).toBe(false);
  });
  it('rechaza formas que no son un token antes de tocar la base', () => {
    expect(looksLikeDeviceToken('cbd_corto')).toBe(false);
    expect(looksLikeDeviceToken(`zda_${'a'.repeat(43)}`)).toBe(false);
    expect(looksLikeDeviceToken(`cbd_${'a'.repeat(43)}'; drop`)).toBe(false);
  });
  it('sameHash no revienta con largos distintos o basura', () => {
    expect(sameHash('abcd', 'abcdef')).toBe(false);
    expect(sameHash('', '')).toBe(false);
    expect(sameHash('zz', 'zz')).toBe(false);
  });
});

describe('encabezado Authorization', () => {
  it('extrae el bearer', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('bearer abc')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer a b')).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });
});

describe('vigencia del dispositivo', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('un dispositivo revocado o vencido no sirve', () => {
    expect(deviceUsable({ revoked_at: null, expires_at: '2026-12-01T00:00:00Z' }, now)).toBe(true);
    expect(
      deviceUsable({ revoked_at: '2026-10-12T11:00:00Z', expires_at: '2026-12-01T00:00:00Z' }, now),
    ).toBe(false);
    expect(deviceUsable({ revoked_at: null, expires_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
  });
  it('está conectado si habló hace menos de 75 s', () => {
    expect(deviceOnline('2026-10-12T11:59:00Z', now)).toBe(true);
    expect(deviceOnline('2026-10-12T11:50:00Z', now)).toBe(false);
    expect(deviceOnline(null, now)).toBe(false);
  });
});
