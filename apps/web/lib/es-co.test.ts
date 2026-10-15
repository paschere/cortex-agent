import { describe, expect, it } from 'vitest';
import { toTuteo } from './es-co';

describe('toTuteo', () => {
  it('reescribe el voseo común', () => {
    expect(toTuteo('¿Cuándo querés enviarlo?')).toBe('¿Cuándo quieres enviarlo?');
    expect(toTuteo('¿Ya tenés la factura? Vos decidís.')).toBe(
      '¿Ya tienes la factura? Tú decides.',
    );
    expect(toTuteo('Podés revisar')).toBe('Puedes revisar');
    expect(toTuteo('Contame qué pasó')).toBe('Cuéntame qué pasó');
  });
  it('deja el tuteo intacto', () => {
    expect(toTuteo('¿Qué quieres revisar?')).toBe('¿Qué quieres revisar?');
  });
});
