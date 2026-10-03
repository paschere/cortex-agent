import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAccessRequest } from './access-request-shape';
import { billingHeadline } from './billing-shape';
import { landingCta, signupMode, signupNeedsCode, trialDays, trialPlanCode } from './config';

/**
 * Los tres modos del registro. La regla que más importa está primero: sin
 * configurar nada, todo sigue como antes de la 0187.
 */

describe('SIGNUP_MODE', () => {
  it('por defecto es invite, y un valor raro también (nunca abre la puerta por error)', () => {
    expect(signupMode({})).toBe('invite');
    expect(signupMode({ SIGNUP_MODE: 'abierto' })).toBe('invite');
    expect(signupMode({ SIGNUP_MODE: ' OPEN ' })).toBe('open');
    expect(signupMode({ SIGNUP_MODE: 'request' })).toBe('request');
  });

  it('invite pide código sólo si hay código compartido; request siempre; open nunca', () => {
    expect(signupNeedsCode('invite', false)).toBe(false);
    expect(signupNeedsCode('invite', true)).toBe(true);
    expect(signupNeedsCode('request', false)).toBe(true);
    expect(signupNeedsCode('open', true)).toBe(false);
  });

  it('TRIAL_DAYS: 14 por defecto, acotado entre 1 y 90', () => {
    expect(trialDays({})).toBe(14);
    expect(trialDays({ TRIAL_DAYS: '30' })).toBe(30);
    expect(trialDays({ TRIAL_DAYS: '0' })).toBe(1);
    expect(trialDays({ TRIAL_DAYS: '400' })).toBe(90);
    expect(trialDays({ TRIAL_DAYS: 'muchos' })).toBe(14);
  });

  it('el plan de prueba: el elegido si se puede probar, si no TRIAL_PLAN, si no Equipo', () => {
    expect(trialPlanCode('business', {})).toBe('business');
    expect(trialPlanCode('enterprise', {})).toBe('team');
    expect(trialPlanCode('gerente', { TRIAL_PLAN: 'business' })).toBe('business');
    expect(trialPlanCode(null, { TRIAL_PLAN: 'free' })).toBe('team');
  });
});

describe('el botón de la landing sigue al modo', () => {
  it('invite sin enlace externo: «Crear mi espacio», igual que antes', () => {
    const cta = landingCta('invite', null);
    expect(cta).toMatchObject({ label: 'Crear mi espacio', href: '/signup' });
    expect(cta.note).toBe('Acceso por invitación: necesitas tu código. Sin tarjeta.');
  });

  it('invite con ACCESS_REQUEST_HREF lo respeta, igual que antes', () => {
    expect(landingCta('invite', 'mailto:hola@cortex.co')).toMatchObject({
      label: 'Pide tu acceso',
      href: 'mailto:hola@cortex.co',
    });
  });

  it('request: «Pide tu acceso» al formulario propio', () => {
    expect(landingCta('request', 'mailto:hola@cortex.co')).toMatchObject({
      label: 'Pide tu acceso',
      href: '/acceso',
      noteLink: { href: '/signup' },
    });
  });

  it('open: «Crear mi espacio» con los días de prueba', () => {
    const cta = landingCta('open', null, 21);
    expect(cta).toMatchObject({ label: 'Crear mi espacio', href: '/signup' });
    expect(cta.note).toContain('21 días');
  });
});

describe('formulario «Pide tu acceso»', () => {
  it('limpia y valida', () => {
    const parsed = parseAccessRequest({
      name: '  Ana   Restrepo ',
      company: 'Transportes del Valle',
      email: 'ANA@TDV.CO ',
      phone: '+57 300 123 4567',
      message: 'Hola',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'Ana Restrepo',
        company: 'Transportes del Valle',
        email: 'ana@tdv.co',
        phone: '+57 300 123 4567',
        message: 'Hola',
      },
    });
  });

  it('dice qué falta, en español', () => {
    expect(parseAccessRequest({ name: 'A', company: 'X', email: 'a@b.co' })).toEqual({
      ok: false,
      error: 'Escribe tu nombre.',
    });
    expect(parseAccessRequest({ name: 'Ana', company: 'Acme', email: 'no-es-correo' })).toEqual({
      ok: false,
      error: 'Revisa el correo: no parece válido.',
    });
  });

  it('la trampa para robots no guarda nada y no avisa', () => {
    expect(
      parseAccessRequest({ name: 'Ana', company: 'Acme', email: 'a@b.co', website: 'spam.biz' }),
    ).toEqual({ ok: 'trap' });
  });
});

describe('la franja del cobro', () => {
  it('sin fila (legacy) o al día lejos del fin no dice nada', () => {
    expect(
      billingHeadline(
        { status: 'legacy', access: 'full', reason: 'legacy', endsAt: null, daysLeft: null },
        'Equipo',
      ),
    ).toBeNull();
    expect(
      billingHeadline(
        { status: 'active', access: 'full', reason: 'paid', endsAt: null, daysLeft: 20 },
        'Equipo',
      ),
    ).toBeNull();
  });

  it('en prueba dice los días; en solo lectura dice que no se borró nada', () => {
    expect(
      billingHeadline(
        { status: 'trialing', access: 'full', reason: 'trial', endsAt: null, daysLeft: 2 },
        'Equipo',
      ),
    ).toMatchObject({ tone: 'amber', text: expect.stringContaining('2 días') });
    expect(
      billingHeadline(
        {
          status: 'grace',
          access: 'read_only',
          reason: 'trial_ended',
          endsAt: null,
          daysLeft: null,
        },
        'Equipo',
      )?.text,
    ).toContain('se sigue leyendo');
  });
});

describe('assertMaySignUp sigue a SIGNUP_MODE (lib/auth.ts)', () => {
  // El gancho de better-auth no se puede invocar sin la base; se fija su forma.
  const src = readFileSync(fileURLToPath(new URL('../auth.ts', import.meta.url)), 'utf8');
  const fn = src.slice(
    src.indexOf('async function assertMaySignUp'),
    src.indexOf('async function consumeAccessCode'),
  );

  it('open no tiene puerta; invite sin código compartido tampoco; request siempre', () => {
    expect(fn).toMatch(/if \(mode === 'open'\) return;/);
    expect(fn).toMatch(/if \(mode === 'invite' && !expected\) return;/);
    expect(fn).not.toMatch(/if \(!expected\) return;/);
  });

  it('acepta el código personal aprobado y si falla, niega', () => {
    expect(fn).toContain('accessCodeIsValid(given)');
    expect(
      fn.trim().endsWith('throw new Error(refusal);\n}') ||
        fn.includes('throw new Error(refusal);\n}'),
    ).toBe(true);
  });

  it('el código personal se marca usado al crear la cuenta', () => {
    expect(src).toContain('await consumeAccessCode(user.id);');
  });
});
