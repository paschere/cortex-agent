import { describe, expect, it } from 'vitest';
import { describeDevice, secretFromTotpUri } from './user-agent';

describe('describeDevice', () => {
  it('reconoce Chrome en Mac, y que Edge no se disfraza de Chrome', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(describeDevice(chrome).label).toBe('Chrome en Mac');
    const edge = `${chrome} Edg/126.0.0.0`;
    expect(describeDevice(edge).browser).toBe('Edge');
  });

  it('distingue Safari de iPhone y marca el móvil', () => {
    const safari =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const device = describeDevice(safari);
    expect(device.label).toBe('Safari en iPhone');
    expect(device.mobile).toBe(true);
  });

  it('no inventa nada cuando no hay User-Agent', () => {
    expect(describeDevice(null).label).toBe('Dispositivo desconocido');
    expect(describeDevice('').mobile).toBe(false);
  });
});

describe('secretFromTotpUri', () => {
  it('saca el secreto y lo agrupa de a cuatro', () => {
    expect(
      secretFromTotpUri('otpauth://totp/Cortex:ana@acme.co?secret=ABCDEFGHIJ&issuer=Cortex'),
    ).toBe('ABCD EFGH IJ');
  });
  it('devuelve null con algo que no es una dirección', () => {
    expect(secretFromTotpUri('esto no es una uri')).toBeNull();
  });
});
