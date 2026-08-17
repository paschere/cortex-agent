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
    expect(brainSourceLabel(out)).toBe('1 fuente');
  });

  it('la fila colapsada cuenta, no titula: «N fuentes», con su singular', () => {
    // Decía el título cuando la fuente era una, y el dueño leyó «Del cerebro ·
    // Contrato Coltrans…» sin entender qué era la fila. Un conteo dice qué es
    // Y cuántas hay; los títulos completos viven en la lista expandida.
    expect(brainSourceLabel(collectBrainSources([hit()]))).toBe('1 fuente');
    expect(
      brainSourceLabel(collectBrainSources([hit(), hit({ documentId: 'd2', documentTitle: 'B' })])),
    ).toBe('2 fuentes');
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

  it('un título kilométrico no toca la fila colapsada: la etiqueta es el conteo', () => {
    // El título completo se enseña en la lista expandida, donde tiene el ancho
    // de la respuesta; la fila de una línea no carga con él.
    const largo = 'Contrato marco de prestación de servicios logísticos 2026 con anexos';
    expect(brainSourceLabel(collectBrainSources([hit({ documentTitle: largo })]))).toBe('1 fuente');
  });

  it('lo que venga de la base no puede tumbar la lectura de un hilo', () => {
    // `brain_sources` es jsonb y lo escribió una versión anterior del código.
    expect(parseBrainSources(null)).toEqual([]);
    expect(parseBrainSources('no soy un array')).toEqual([]);
    expect(parseBrainSources([null, 3, 'x'])).toEqual([]);
    expect(parseBrainSources([fila(), { basura: true }])).toHaveLength(1);
  });

  /**
   * LO QUE SE GUARDA NO TIENE LA FORMA DE LO QUE SE BUSCA, Y AQUÍ ESTABA EL
   * FALLO.
   *
   * Un `hit` de `kb.search` trae `documentTitle`; una fila guardada trae
   * `title`. `parseBrainSources` delegaba en `collectBrainSources`, que busca
   * `documentTitle`, no lo encontraba en ninguna fila y las descartaba TODAS por
   * su propia regla. O sea: cada conversación reabierta salía sin una sola
   * fuente. Y como no tener fuentes no dibuja nada a propósito, no había nada
   * roto que mirar en pantalla.
   *
   * Esta prueba usa la forma que de verdad hay en la base — la que produce
   * `collectBrainSources` y escribe `/api/chat` — y por eso el ida y vuelta de
   * abajo es la parte que importa: es lo único que puede volver a separarse.
   */
  const fila = (over: Record<string, unknown> = {}) => ({
    documentId: 'd1',
    title: 'Contrato Coltrans 2026',
    relevance: 'strong',
    ...over,
  });

  it('una fila guardada se vuelve a leer entera', () => {
    const [leida] = parseBrainSources([fila({ age: 'de ayer', spokenAt: '12:34' })]);
    expect(leida?.title).toBe('Contrato Coltrans 2026');
    expect(leida?.age).toBe('de ayer');
    expect(leida?.spokenAt).toBe('12:34');
  });

  it('lo que se escribe es exactamente lo que se vuelve a leer', () => {
    const escrito = collectBrainSources([
      hit({ age: 'de ayer' }),
      hit({ documentId: 'd2', documentTitle: 'Acta', relevance: 'weak' }),
    ]);
    // El viaje de verdad: se serializa a jsonb y vuelve.
    expect(parseBrainSources(JSON.parse(JSON.stringify(escrito)))).toEqual(escrito);
  });

  it('sin título tampoco es una fuente al leerla', () => {
    expect(parseBrainSources([fila({ title: '  ' })])).toEqual([]);
    expect(parseBrainSources([fila({ documentId: null })])).toEqual([]);
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
