import { describe, expect, it } from 'vitest';
import {
  invitationIdFromNext,
  justCreated,
  landingAction,
  landingState,
  sameEmail,
} from './invitation-landing-shape';

const NOW = new Date('2026-10-03T12:00:00Z');
const row = (over: Partial<{ status: string; expiresAt: string }> = {}) => ({
  id: 'inv1',
  email: 'ana@x.co',
  role: 'member',
  status: 'pending',
  expiresAt: '2026-10-08T12:00:00Z',
  ...over,
});

describe('el estado del enlace de invitación', () => {
  it('distingue viva, vencida, aceptada, cerrada y desconocida', () => {
    expect(landingState(row(), NOW)).toBe('valid');
    expect(landingState(row({ expiresAt: '2026-10-01T00:00:00Z' }), NOW)).toBe('expired');
    expect(landingState(row({ status: 'accepted' }), NOW)).toBe('accepted');
    expect(landingState(row({ status: 'canceled' }), NOW)).toBe('closed');
    expect(landingState(row({ status: 'rejected' }), NOW)).toBe('closed');
    expect(landingState(null, NOW)).toBe('not_found');
  });

  it('una aceptada no se vuelve «vencida» por la fecha', () => {
    expect(landingState(row({ status: 'accepted', expiresAt: '2020-01-01T00:00:00Z' }), NOW)).toBe(
      'accepted',
    );
  });
});

describe('qué botones salen', () => {
  const anon = { kind: 'anonymous' } as const;
  it('sin sesión: crear cuenta o entrar', () => {
    expect(landingAction('valid', anon, 'ana@x.co')).toBe('signup-or-login');
  });
  it('con la cuenta correcta (sin importar mayúsculas): aceptar o rechazar', () => {
    expect(landingAction('valid', { kind: 'signed-in', email: 'ANA@x.co' }, 'ana@x.co')).toBe(
      'respond',
    );
  });
  it('con otra cuenta: nunca se ofrece aceptar', () => {
    expect(landingAction('valid', { kind: 'signed-in', email: 'otra@x.co' }, 'ana@x.co')).toBe(
      'switch-account',
    );
  });
  it('un enlace muerto no ofrece nada', () => {
    for (const state of ['expired', 'closed', 'not_found'] as const) {
      expect(landingAction(state, anon, 'ana@x.co')).toBe('none');
    }
  });
  it('aceptada: entrar a Cortex sólo para quien es', () => {
    expect(landingAction('accepted', { kind: 'signed-in', email: 'ana@x.co' }, 'ana@x.co')).toBe(
      'open-app',
    );
    expect(landingAction('accepted', { kind: 'signed-in', email: 'b@x.co' }, 'ana@x.co')).toBe(
      'none',
    );
    expect(landingAction('accepted', anon, 'ana@x.co')).toBe('login-only');
  });
  it('sameEmail ignora mayúsculas y espacios', () => {
    expect(sameEmail(' Ana@X.co ', 'ana@x.co')).toBe(true);
  });
});

describe('invitationIdFromNext', () => {
  it('saca el id de un destino interno', () => {
    expect(invitationIdFromNext('/accept-invitation/abc_123-X')).toBe('abc_123-X');
    expect(invitationIdFromNext('/accept-invitation/abc?auto=1')).toBe('abc');
  });
  it('rechaza lo que no es una invitación o es una redirección abierta', () => {
    expect(invitationIdFromNext('/chat')).toBeNull();
    expect(invitationIdFromNext('//evil.com/accept-invitation/abc')).toBeNull();
    expect(invitationIdFromNext('https://evil.com/accept-invitation/abc')).toBeNull();
    expect(invitationIdFromNext(null)).toBeNull();
  });
});

describe('justCreated', () => {
  it('sólo cuenta una cuenta de hace minutos', () => {
    expect(justCreated('2026-10-03T11:50:00Z', NOW)).toBe(true);
    expect(justCreated('2026-10-01T11:50:00Z', NOW)).toBe(false);
    expect(justCreated(null, NOW)).toBe(false);
  });
});
