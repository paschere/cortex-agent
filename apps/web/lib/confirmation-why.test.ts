import { describe, expect, it } from 'vitest';
import { proposalReason } from './confirmation-why';

describe('proposalReason', () => {
  it('une los trozos con espacio y toma sólo dos frases', () => {
    const out = proposalReason([
      'Quedó el diseño completo de la tabla.',
      'Te propongo crearla para llevar las atenciones del día.',
      'Después armo la vista.',
    ]);
    expect(out).toBe(
      'Quedó el diseño completo de la tabla. Te propongo crearla para llevar las atenciones del día.',
    );
  });
  it('separa frases pegadas por el SDK («completo.Corrijo»)', () => {
    const out = proposalReason('Tengo el diseño completo.Propongo crear la tabla de atenciones.');
    expect(out).toBe('Tengo el diseño completo. Propongo crear la tabla de atenciones.');
  });
  it('descarta las notas técnicas del modelo', () => {
    const out = proposalReason(
      'Voy a crear la tabla de atenciones.Corrijo los nombres de los campos porque uno supera el límite de 16 caracteres.El id del campo es nit_cliente.',
    );
    expect(out).toBe('Voy a crear la tabla de atenciones.');
  });
  it('sólo notas técnicas = nada; vacío = nada', () => {
    expect(proposalReason('El id es abc_def.')).toBeUndefined();
    expect(proposalReason('')).toBeUndefined();
    expect(proposalReason(undefined)).toBeUndefined();
  });
  it('acorta lo muy largo', () => {
    const out = proposalReason(`${'palabra '.repeat(80)}fin.`);
    expect((out ?? '').length).toBeLessThanOrEqual(240);
  });
});
