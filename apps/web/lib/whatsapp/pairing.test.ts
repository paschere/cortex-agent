import { describe, expect, it } from 'vitest';
import {
  PAIRING_REQUEST_TTL_MS,
  isPairingRequestAlive,
  pairingReply,
  pairingView,
  parsePairingCommand,
} from './pairing';

const NOW = new Date('2026-10-02T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('una petición de vincular', () => {
  it('vive tres minutos desde la última renovación y ni uno más', () => {
    expect(isPairingRequestAlive(ago(0), NOW)).toBe(true);
    expect(isPairingRequestAlive(ago(PAIRING_REQUEST_TTL_MS - 1), NOW)).toBe(true);
    expect(isPairingRequestAlive(ago(PAIRING_REQUEST_TTL_MS), NOW)).toBe(false);
    expect(isPairingRequestAlive(null, NOW)).toBe(false);
    expect(isPairingRequestAlive('no es una fecha', NOW)).toBe(false);
  });

  it('le dice al puente el número sólo mientras la petición vive', () => {
    expect(
      pairingReply({ pairing_requested_at: ago(60_000), pairing_phone: '573001112233' }, NOW),
    ).toEqual({ pairingRequested: true, pairingPhone: '573001112233' });
    expect(
      pairingReply({ pairing_requested_at: ago(10 * 60_000), pairing_phone: '573001112233' }, NOW),
    ).toEqual({ pairingRequested: false, pairingPhone: null });
    expect(pairingReply(null, NOW)).toEqual({ pairingRequested: false, pairingPhone: null });
  });
});

describe('lo que pide la pantalla', () => {
  it('entiende QR, código, renovar y cancelar', () => {
    expect(parsePairingCommand({ mode: 'qr' })).toEqual({ ok: true, command: { mode: 'qr' } });
    expect(parsePairingCommand({ mode: 'keepalive' })).toEqual({
      ok: true,
      command: { mode: 'keepalive' },
    });
    expect(parsePairingCommand({ mode: 'cancel' })).toEqual({
      ok: true,
      command: { mode: 'cancel' },
    });
  });

  it('normaliza el número igual que el resto de WhatsApp', () => {
    expect(parsePairingCommand({ mode: 'code', phone: '+57 300 111 2233' })).toEqual({
      ok: true,
      command: { mode: 'code', phone: '573001112233' },
    });
  });

  it('rechaza un número que no se entiende y un modo inventado', () => {
    expect(parsePairingCommand({ mode: 'code', phone: '123' }).ok).toBe(false);
    expect(parsePairingCommand({ mode: 'code' }).ok).toBe(false);
    expect(parsePairingCommand({ mode: 'sms' }).ok).toBe(false);
    expect(parsePairingCommand(null).ok).toBe(false);
  });
});

describe('lo que la pantalla muestra', () => {
  it('sin petición no hay modo ni código', () => {
    expect(pairingView(null, NOW)).toEqual({
      requested: false,
      mode: null,
      phone: null,
      code: null,
    });
  });

  it('con número es modo código, y el código sólo mientras no venza', () => {
    const row = {
      pairing_requested_at: ago(30_000),
      pairing_phone: '573001112233',
      pairing_code: 'ABCD1234',
      pairing_code_expires_at: ahead(30_000),
    };
    expect(pairingView(row, NOW)).toEqual({
      requested: true,
      mode: 'code',
      phone: '573001112233',
      code: 'ABCD1234',
    });
    expect(pairingView({ ...row, pairing_code_expires_at: ago(1) }, NOW).code).toBeNull();
  });

  it('sin número es QR, y un código viejo de otro intento no se muestra', () => {
    expect(
      pairingView(
        {
          pairing_requested_at: ago(30_000),
          pairing_phone: null,
          pairing_code: 'ABCD1234',
          pairing_code_expires_at: ahead(30_000),
        },
        NOW,
      ),
    ).toEqual({ requested: true, mode: 'qr', phone: null, code: null });
  });

  it('una petición vencida no muestra nada aunque quede un código', () => {
    expect(
      pairingView(
        {
          pairing_requested_at: ago(PAIRING_REQUEST_TTL_MS + 1),
          pairing_phone: '573001112233',
          pairing_code: 'ABCD1234',
          pairing_code_expires_at: ahead(30_000),
        },
        NOW,
      ),
    ).toEqual({ requested: false, mode: null, phone: null, code: null });
  });
});
