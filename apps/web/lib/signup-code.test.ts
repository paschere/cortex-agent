import { describe, expect, it } from 'vitest';
import { normalizeSignupCode, signupCodeMatches } from './signup-code';

/**
 * La puerta del registro se prueba por los dos lados, y el lado que más importa
 * es el que NO debe abrirse. Un fallo aquí no rompe nada visible: el producto
 * sigue funcionando perfectamente para todo el mundo, incluido el que no debía
 * poder entrar.
 */

const CODE = 'CORTEX-2026-K7QM4-XR93P';

describe('normalizeSignupCode', () => {
  it('perdona lo que la gente hace de verdad al pegar un código', () => {
    // Llega por WhatsApp: con espacios delante y detrás, en minúscula desde el
    // teléfono, o partido por un salto de línea al copiarlo de un correo.
    expect(normalizeSignupCode('  cortex-2026-k7qm4-xr93p ')).toBe(CODE);
    expect(normalizeSignupCode('CORTEX-2026-K7QM4\n-XR93P')).toBe(CODE);
    expect(normalizeSignupCode('cortex-2026-k7qm4 -xr93p')).toBe(CODE);
  });

  it('trata la ausencia y el vacío como lo mismo', () => {
    expect(normalizeSignupCode(null)).toBe('');
    expect(normalizeSignupCode(undefined)).toBe('');
    expect(normalizeSignupCode('   ')).toBe('');
  });
});

describe('signupCodeMatches — abre', () => {
  it('con el código exacto', () => {
    expect(signupCodeMatches(CODE, CODE)).toBe(true);
  });

  it('con el código mal escrito de las formas que no son culpa de nadie', () => {
    expect(signupCodeMatches(' cortex-2026-k7qm4-xr93p ', CODE)).toBe(true);
  });
});

describe('signupCodeMatches — NO abre', () => {
  it('sin código', () => {
    expect(signupCodeMatches('', CODE)).toBe(false);
    expect(signupCodeMatches(null, CODE)).toBe(false);
    expect(signupCodeMatches(undefined, CODE)).toBe(false);
  });

  it('con un código parecido, corto o largo', () => {
    expect(signupCodeMatches('CORTEX-2026-K7QM4-XR93Q', CODE)).toBe(false);
    expect(signupCodeMatches('CORTEX-2026-K7QM4', CODE)).toBe(false);
    expect(signupCodeMatches(`${CODE}X`, CODE)).toBe(false);
  });

  /**
   * La guarda que de verdad importa: si `SIGNUP_INVITE_CODE` se despliega vacío
   * por un error de configuración, la comparación NO puede volverse universal.
   * Que el registro quede abierto es decisión de `assertMaySignUp` —que ni
   * siquiera llama aquí cuando no hay código— y nunca un efecto colateral de que
   * dos cadenas vacías se parezcan.
   */
  it('cuando el código esperado está vacío, no valida nada — ni siquiera el vacío', () => {
    expect(signupCodeMatches('', '')).toBe(false);
    expect(signupCodeMatches('lo que sea', '')).toBe(false);
    expect(signupCodeMatches('', '   ')).toBe(false);
  });
});
