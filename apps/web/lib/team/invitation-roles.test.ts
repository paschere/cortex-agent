import { describe, expect, it } from 'vitest';
import {
  INVITABLE_ROLES,
  expiryCountdown,
  invitationRoleLabel,
  normalizeInvitationRole,
} from './invitation-roles';

describe('los roles de una invitación en palabras', () => {
  it('traduce los tres y baja lo desconocido a Miembro', () => {
    expect(invitationRoleLabel('member')).toBe('Miembro');
    expect(invitationRoleLabel('admin')).toBe('Administrador');
    expect(invitationRoleLabel('owner')).toBe('Cofundador');
    expect(normalizeInvitationRole('root')).toBe('member');
    expect(normalizeInvitationRole(undefined)).toBe('member');
  });
  it('no ofrece owner al invitar desde la pantalla', () => {
    expect(INVITABLE_ROLES.map((r) => r.value)).toEqual(['member', 'admin']);
  });
});

describe('la cuenta regresiva', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  it('días, horas, minutos y vencida', () => {
    expect(expiryCountdown('2026-10-10T12:00:00Z', now)).toBe('vence en 7 días');
    expect(expiryCountdown('2026-10-04T13:00:00Z', now)).toBe('vence en 1 día');
    expect(expiryCountdown('2026-10-03T17:30:00Z', now)).toBe('vence en 5 h');
    expect(expiryCountdown('2026-10-03T12:20:00Z', now)).toBe('vence en 20 min');
    expect(expiryCountdown('2026-10-03T11:00:00Z', now)).toBe('vencida');
    expect(expiryCountdown('basura', now)).toBe('vencida');
  });
});
