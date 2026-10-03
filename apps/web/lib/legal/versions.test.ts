import { describe, expect, it } from 'vitest';
import {
  LEGAL_DOCUMENT_VERSIONS,
  REQUIRED_CONSENTS,
  decodeSignupConsent,
  encodeSignupConsent,
  hadPreviousConsent,
  missingConsents,
} from './versions';

const current = (doc: 'tratamiento' | 'terminos') => ({
  document: doc,
  version: LEGAL_DOCUMENT_VERSIONS[doc],
  revoked_at: null,
});

describe('autorización versionada: cuándo se vuelve a pedir', () => {
  it('nadie ha aceptado nada → se piden los dos obligatorios', () => {
    expect(missingConsents([])).toEqual(['tratamiento', 'terminos']);
    expect(REQUIRED_CONSENTS).toEqual(['tratamiento', 'terminos']);
  });

  it('las versiones vigentes aceptadas → no se pide nada', () => {
    expect(missingConsents([current('tratamiento'), current('terminos')])).toEqual([]);
  });

  it('subir la versión de un documento vuelve a pedir SÓLO ese documento', () => {
    const accepted = [current('tratamiento'), current('terminos')];
    const bumped = { ...LEGAL_DOCUMENT_VERSIONS, tratamiento: '2099-01-01' };
    expect(missingConsents(accepted, bumped)).toEqual(['tratamiento']);
  });

  it('una aceptación de una versión vieja no cuenta', () => {
    expect(
      missingConsents([{ document: 'tratamiento', version: '2000-01-01' }, current('terminos')]),
    ).toEqual(['tratamiento']);
  });

  it('una aceptación revocada no cuenta', () => {
    expect(
      missingConsents([
        { ...current('tratamiento'), revoked_at: '2026-10-01T00:00:00Z' },
        current('terminos'),
      ]),
    ).toEqual(['tratamiento']);
  });

  it('la privacidad no es obligatoria por separado (se informa, no se acepta aparte)', () => {
    expect(missingConsents([current('tratamiento'), current('terminos')])).not.toContain(
      'privacidad',
    );
  });

  it('distingue «primera vez» de «actualizamos los documentos»', () => {
    expect(hadPreviousConsent([])).toBe(false);
    expect(hadPreviousConsent([{ document: 'tratamiento', version: '2000-01-01' }])).toBe(true);
  });
});

describe('la casilla del registro viaja en una cookie', () => {
  it('ida y vuelta: lo marcado en el registro cubre las versiones vigentes', () => {
    const decoded = decodeSignupConsent(encodeURIComponent(encodeSignupConsent()));
    expect(missingConsents(decoded)).toEqual([]);
  });

  it('una cookie de una versión anterior ya no cubre la vigente', () => {
    const old = encodeSignupConsent({ ...LEGAL_DOCUMENT_VERSIONS, terminos: '2000-01-01' });
    expect(missingConsents(decodeSignupConsent(old))).toEqual(['terminos']);
  });

  it('descarta basura sin romperse', () => {
    expect(decodeSignupConsent(undefined)).toEqual([]);
    expect(decodeSignupConsent('%E0%A4%A')).toEqual([]);
    expect(decodeSignupConsent('hackeo:1,tratamiento:<script>,terminos')).toEqual([]);
  });
});
