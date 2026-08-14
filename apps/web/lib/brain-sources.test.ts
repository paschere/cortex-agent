import { describe, expect, it } from 'vitest';
import {
  MAX_BRAIN_SOURCES,
  brainSourceLabel,
  collectBrainSources,
  parseBrainSources,
} from './brain-sources-shape';

/**
 * Lo que se defiende aquí es LA CIFRA, porque es la única parte de esto que
 * puede estar mal sin que se note. «Del cerebro · 5 documentos» debajo de una
 * respuesta se lee como un hecho, y si en realidad eran cinco trozos del mismo
 * contrato, esa línea acaba de inflar la confianza en la respuesta usando el
 * mecanismo que este producto tiene para lo contrario.
 */

const hit = (over: Record<string, unknown> = {}) => ({
  documentId: 'd1',
  documentTitle: 'Contrato Coltrans 2026',
  relevance: 'strong',
  ...over,
});

describe('las fuentes de una respuesta', () => {
  it('cinco trozos del mismo documento son un documento', () => {
    const out = collectBrainSources([hit(), hit(), hit(), hit(), hit()]);
    expect(out).toHaveLength(1);
    expect(brainSourceLabel(out)).toBe('Contrato Coltrans 2026');
  });

  it('con uno solo dice su nombre; con varios, cuántos son', () => {
    expect(brainSourceLabel(collectBrainSources([hit()]))).toBe('Contrato Coltrans 2026');
    expect(
      brainSourceLabel(collectBrainSources([hit(), hit({ documentId: 'd2', documentTitle: 'B' })])),
    ).toBe('2 documentos');
  });

  it('sin fuentes no hay nada que decir, y se dice devolviendo null', () => {
    // El componente lo lee como «no dibujes». Una cadena vacía se dibujaría.
    expect(brainSourceLabel([])).toBeNull();
    expect(collectBrainSources([])).toEqual([]);
  });

  it('un documento con un trozo bueno es un documento bueno', () => {
    // Al revés sería subestimar la respuesta: marcar de floja una cita que sí
    // tenía un párrafo que respondía de verdad.
    const out = collectBrainSources([hit({ relevance: 'weak' }), hit({ relevance: 'strong' })]);
    expect(out[0]?.relevance).toBe('strong');
  });

  it('la coincidencia floja sobrevive cuando de verdad lo fue', () => {
    const out = collectBrainSources([hit({ relevance: 'weak' })]);
    expect(out[0]?.relevance).toBe('weak');
  });

  it('sin título no es una fuente: sería una fila que dice «algo»', () => {
    expect(collectBrainSources([hit({ documentTitle: '   ' })])).toEqual([]);
    expect(collectBrainSources([hit({ documentTitle: undefined })])).toEqual([]);
    expect(collectBrainSources([hit({ documentId: null })])).toEqual([]);
  });

  it('nunca más de las que la migración deja guardar', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit({ documentId: `d${i}`, documentTitle: `Documento ${i}` }),
    );
    // El CHECK de la migración 0105 rechaza más de 8, así que pasarse aquí no
    // sería una lista larga: sería una respuesta que no se guarda.
    expect(collectBrainSources(many)).toHaveLength(MAX_BRAIN_SOURCES);
  });

  it('un título largo se recorta, pero sólo cuando va solo', () => {
    const largo = 'Contrato marco de prestación de servicios logísticos 2026 con anexos';
    const label = brainSourceLabel(collectBrainSources([hit({ documentTitle: largo })]));
    expect(label).toMatch(/…$/);
    expect((label ?? '').length).toBeLessThanOrEqual(42);
  });

  it('lo que venga de la base no puede tumbar la lectura de un hilo', () => {
    // `brain_sources` es jsonb y lo escribió una versión anterior del código.
    expect(parseBrainSources(null)).toEqual([]);
    expect(parseBrainSources('no soy un array')).toEqual([]);
    expect(parseBrainSources([null, 3, 'x'])).toEqual([]);
    expect(parseBrainSources([hit(), { basura: true }])).toHaveLength(1);
  });

  it('la edad y el minuto viajan cuando existen, y no cuando no', () => {
    const [con] = collectBrainSources([hit({ age: 'de ayer', spokenAt: '12:34' })]);
    expect(con?.age).toBe('de ayer');
    expect(con?.spokenAt).toBe('12:34');

    const [sin] = collectBrainSources([hit({ age: '', spokenAt: null })]);
    // Ausentes, no vacíos: una cadena vacía en la fila dibujaría un hueco donde
    // no hay dato, que es lo mismo que decir que el documento no tiene fecha
    // cuando en realidad no la sabemos.
    expect(sin).not.toHaveProperty('age');
    expect(sin).not.toHaveProperty('spokenAt');
  });
});
