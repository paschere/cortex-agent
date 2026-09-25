import { describe, expect, it } from 'vitest';
import { ragQueryFor } from './rag-query';

const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

describe('qué se le pregunta a Brain Knowledge', () => {
  it('las preguntas cortas de un gerente SÍ buscan (antes se saltaban)', () => {
    expect(ragQueryFor([u('¿cómo va Coltrans?')])).toEqual({
      run: true,
      query: '¿cómo va Coltrans?',
      widened: false,
    });
    expect(ragQueryFor([u('cuanto nos paga nexa al mes')]).run).toBe(true);
  });

  it('una pregunta corta de seguimiento lleva el sujeto de antes', () => {
    const decision = ragQueryFor([
      u('¿Qué condiciones tenemos con Nexa Logística?'),
      a('Con Nexa tienen un contrato de transporte… (respuesta larga)'),
      u('y la tarifa?'),
    ]);
    expect(decision).toMatchObject({ run: true, widened: true });
    expect(decision.run && decision.query).toContain('Nexa Logística');
    expect(decision.run && decision.query.endsWith('y la tarifa?')).toBe(true);
    // La respuesta del asistente no entra en la búsqueda.
    expect(decision.run && decision.query).not.toContain('respuesta larga');
  });

  it('acuses y saludos no gastan una búsqueda', () => {
    for (const text of ['ok', 'Gracias!', 'dale', 'listo', 'hola', 'Buenos días Cortex', 'sí'])
      expect(ragQueryFor([u(text)]).run).toBe(false);
  });

  it('un mensaje largo se busca tal cual, sin mezclar lo anterior', () => {
    const long =
      'necesito saber qué dijo el cliente sobre la entrega del contenedor la semana pasada';
    expect(ragQueryFor([u('otra cosa'), u(long)])).toEqual({
      run: true,
      query: long,
      widened: false,
    });
  });
});
