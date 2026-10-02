import { describe, expect, it } from 'vitest';
import { authErrorMessage } from './auth-error-message';

const FALLBACK = 'No se pudo. Inténtalo de nuevo.';

describe('authErrorMessage', () => {
  it('traduce por código', () => {
    expect(
      authErrorMessage({ code: 'USER_ALREADY_EXISTS', message: 'User already exists' }, FALLBACK),
    ).toMatch(/Ya hay una cuenta/);
  });

  it('traduce por texto cuando no hay código', () => {
    expect(authErrorMessage({ message: 'Invalid email or password' }, FALLBACK)).toMatch(
      /no coinciden/,
    );
    expect(authErrorMessage(new Error('Failed to fetch'), FALLBACK)).toMatch(/conexión/);
  });

  it('respeta un mensaje que ya viene en español', () => {
    const own = 'Cortex está en acceso por invitación. Necesitas un código para crear la cuenta.';
    expect(authErrorMessage({ message: own }, FALLBACK)).toBe(own);
  });

  it('nunca muestra inglés desconocido: cae en el respaldo', () => {
    expect(authErrorMessage({ message: 'Something odd happened' }, FALLBACK)).toBe(FALLBACK);
    expect(authErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(authErrorMessage({}, FALLBACK)).toBe(FALLBACK);
  });
});
