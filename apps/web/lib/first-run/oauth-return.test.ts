import { describe, expect, it } from 'vitest';
import { cameFromOnboarding, connectedPath, failedPath, googleKickoffJobs } from './oauth-return';

describe('retorno de OAuth', () => {
  it('vuelve al recorrido sólo si la marca es la esperada', () => {
    expect(cameFromOnboarding('onboarding')).toBe(true);
    expect(cameFromOnboarding('otra')).toBe(false);
    expect(cameFromOnboarding(undefined)).toBe(false);
  });

  it('conectado: onboarding vs integraciones', () => {
    expect(connectedPath('google', true)).toBe('/onboarding?paso=fuentes&connected=google');
    expect(connectedPath('google', false)).toBe('/integrations?connected=google');
    expect(connectedPath('quickbooks', false)).toBe(
      '/integrations?connected=quickbooks#programas-contables',
    );
  });

  it('error: mismo destino que la conexión', () => {
    expect(failedPath('google', 'state', true)).toBe('/onboarding?paso=fuentes&error=state');
    expect(failedPath('google', 'state', false)).toBe('/integrations?error=state');
  });
});

describe('googleKickoffJobs', () => {
  const base = { userId: 'u1', organizationId: 'o1' };
  it('sin opt-in previo del correo no encola nada', () => {
    expect(googleKickoffJobs({ ...base, gmail: null })).toEqual([]);
  });
  it('pausado o ya terminado: nada', () => {
    expect(googleKickoffJobs({ ...base, gmail: { paused: true, backfillDoneAt: null } })).toEqual(
      [],
    );
    expect(
      googleKickoffJobs({ ...base, gmail: { paused: false, backfillDoneAt: '2026-01-01' } }),
    ).toEqual([]);
  });
  it('carga encendida e inconclusa: retoma', () => {
    expect(googleKickoffJobs({ ...base, gmail: { paused: false, backfillDoneAt: null } })).toEqual([
      { name: 'gmail/backfill.user', data: { userId: 'u1', organizationId: 'o1' } },
    ]);
  });
});
