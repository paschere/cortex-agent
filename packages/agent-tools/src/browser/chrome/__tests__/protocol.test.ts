import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  capDecision,
  isChromeSessionId,
  looksSensitive,
  parseCommand,
  parseCommandBody,
  parseResult,
  resolveElement,
} from '../protocol';

const ENV = {
  id: '3f2b8c1e-0a4d-4f6e-9b1c-2d7e5a8f9c01',
  sessionId: 'chr_0123456789abcdef',
  issuedAt: 1_000_000,
  cap: 150,
};

describe('parseCommand', () => {
  it('acepta una orden bien formada', () => {
    const r = parseCommand({ ...ENV, op: 'click', ref: 'e12', name: 'Consultar' }, 1_000_500);
    expect(r.ok).toBe(true);
  });

  it('rechaza lo que venció, lo que viene del futuro y los ids raros', () => {
    expect(parseCommand({ ...ENV, op: 'close' }, 1_000_000 + LIMITS.commandTtlMs + 1).ok).toBe(
      false,
    );
    expect(parseCommand({ ...ENV, op: 'close' }, 1_000_000 - 120_000).ok).toBe(false);
    expect(parseCommand({ ...ENV, id: 'x', op: 'close' }, 1_000_000).ok).toBe(false);
    expect(parseCommand({ ...ENV, sessionId: 'chr_zz', op: 'close' }, 1_000_000).ok).toBe(false);
    expect(parseCommand({ ...ENV, cap: 0, op: 'close' }, 1_000_000).ok).toBe(false);
  });

  it('rechaza operaciones desconocidas, refs inválidas y teclas con atajos', () => {
    expect(parseCommandBody({ op: 'eval', code: 'alert(1)' }).ok).toBe(false);
    expect(parseCommandBody({ op: 'click', ref: '#login', name: 'x' }).ok).toBe(false);
    expect(parseCommandBody({ op: 'click', ref: 'e1; drop', name: 'x' }).ok).toBe(false);
    expect(parseCommandBody({ op: 'press', key: 'Control+W' }).ok).toBe(false);
    expect(parseCommandBody({ op: 'press', key: 'Enter' }).ok).toBe(true);
    expect(parseCommandBody({ op: 'scroll', dy: 99999 }).ok).toBe(false);
    expect(parseCommandBody({ op: 'wait', ms: 60000 }).ok).toBe(false);
    expect(parseCommandBody(null).ok).toBe(false);
  });

  it('no deja pasar texto más largo que el tope', () => {
    expect(
      parseCommandBody({ op: 'fill', ref: 'e1', name: 'NIT', text: 'x'.repeat(LIMITS.textMax + 1) })
        .ok,
    ).toBe(false);
  });

  it('descarta los campos de más (no se cuela nada)', () => {
    const r = parseCommandBody({ op: 'click', ref: 'e1', name: 'ok', evil: 'x' });
    expect(r.ok && 'evil' in r.value).toBe(false);
  });
});

describe('parseResult', () => {
  it('quita el valor de un campo sensible aunque la extensión lo mande', () => {
    const r = parseResult({
      ok: true,
      page: {
        url: 'https://x.co',
        title: 't',
        headings: [],
        alerts: [],
        text: '',
        elements: [
          { ref: 'e1', role: 'textbox', name: 'Clave', value: 'hunter2', sensitive: true },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.page?.elements[0]).toEqual({
        ref: 'e1',
        role: 'textbox',
        name: 'Clave',
        sensitive: true,
      });
  });

  it('rechaza resultados mal formados, códigos inventados y fotos que no son base64', () => {
    expect(parseResult({ ok: 'sí' }).ok).toBe(false);
    expect(parseResult({ ok: false, code: 'hacked' }).ok).toBe(false);
    expect(parseResult({ ok: true, shot: '<script>' }).ok).toBe(false);
    expect(parseResult({ ok: true, shot: 'A'.repeat(LIMITS.shotMaxChars + 1) }).ok).toBe(false);
    expect(parseResult({ ok: false, code: 'denied', error: 'no' }).ok).toBe(true);
  });
});

describe('resolveElement', () => {
  const els = [{ ref: 'e1', role: 'button', name: 'Consultar saldo' }];
  it('resuelve cuando el nombre coincide (laxo)', () => {
    expect('el' in resolveElement(els, 'e1', 'consultar')).toBe(true);
  });
  it('exige mirar de nuevo si la página cambió', () => {
    expect('stale' in resolveElement(els, 'e1', 'Transferir')).toBe(true);
    expect('stale' in resolveElement(els, 'e9', 'x')).toBe(true);
  });
});

describe('looksSensitive', () => {
  it('detecta claves, tarjetas y códigos de un solo uso', () => {
    expect(looksSensitive({ type: 'password' })).toBe(true);
    expect(looksSensitive({ autocomplete: 'one-time-code' })).toBe(true);
    expect(looksSensitive({ autocomplete: 'cc-number' })).toBe(true);
    expect(looksSensitive({ name: 'cvv' })).toBe(true);
    expect(looksSensitive({ label: 'Contraseña del portal' })).toBe(true);
    expect(looksSensitive({ label: 'Clave de acceso' })).toBe(true);
  });
  it('no marca un campo cualquiera', () => {
    expect(looksSensitive({ type: 'text', name: 'nit', label: 'NIT' })).toBe(false);
  });
});

describe('capDecision', () => {
  it('deja pasar hasta el tope y corta justo en él', () => {
    expect(capDecision(149, 150, 'click').ok).toBe(true);
    const r = capDecision(150, 150, 'click');
    expect(r.ok).toBe(false);
  });
  it('leer, esperar y cerrar no cuentan, así que se puede cerrar tras el tope', () => {
    expect(capDecision(150, 150, 'read')).toEqual({ ok: true, counts: false });
    expect(capDecision(150, 150, 'close')).toEqual({ ok: true, counts: false });
    expect(capDecision(0, 150, 'fill')).toEqual({ ok: true, counts: true });
  });
});

describe('ids de sesión', () => {
  it('solo reconoce el formato exacto', () => {
    expect(isChromeSessionId('chr_0123456789abcdef')).toBe(true);
    expect(isChromeSessionId('chr_0123456789abcdeg')).toBe(false);
    expect(isChromeSessionId('sess_123')).toBe(false);
  });
});

describe('looksSensitive: llaves y NIP', () => {
  it('marca llaves de API, NIP e IBAN', () => {
    expect(looksSensitive({ name: 'apiKey' })).toBe(true);
    expect(looksSensitive({ label: 'NIP del cajero' })).toBe(true);
    expect(looksSensitive({ label: 'IBAN' })).toBe(true);
    expect(looksSensitive({ label: 'Ninguno' })).toBe(false);
  });
});
