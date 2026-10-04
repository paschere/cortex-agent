import { describe, expect, it } from 'vitest';
import { FRESH_SESSION_MS, stepUpRequirement } from './step-up-rules';

describe('qué se pide para confirmar un cambio de fundadores', () => {
  const base = { twoFactorEnabled: false, hasPassword: true, sessionAgeMs: 0 };

  it('con dos pasos se pide el código, sea cual sea la edad de la sesión', () => {
    expect(stepUpRequirement({ ...base, twoFactorEnabled: true })).toBe('totp');
    expect(stepUpRequirement({ ...base, twoFactorEnabled: true, sessionAgeMs: 1 })).toBe('totp');
  });

  it('con contraseña se pide la contraseña aunque la sesión sea de hace un minuto', () => {
    expect(stepUpRequirement({ ...base, sessionAgeMs: 60_000 })).toBe('password');
  });

  it('sin contraseña (sólo Google) basta una sesión de menos de 10 minutos', () => {
    const google = { twoFactorEnabled: false, hasPassword: false };
    expect(stepUpRequirement({ ...google, sessionAgeMs: FRESH_SESSION_MS })).toBe('fresh_session');
    expect(stepUpRequirement({ ...google, sessionAgeMs: FRESH_SESSION_MS + 1 })).toBe(
      'sign_in_again',
    );
  });
});
