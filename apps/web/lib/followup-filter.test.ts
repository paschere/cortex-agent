import { describe, expect, it } from 'vitest';
import { contentWords, keepIfSpecific, parseSuggestions } from './followup-filter';

/**
 * The follow-up strip's whole value is that everything in it is worth clicking.
 * The model is asked for that and this is what enforces it, so these cases are
 * the specification: if a generic question starts surviving, the strip has
 * quietly become furniture and nothing else in the product will say so.
 */

const ANSWER = [
  'Tres vehículos tienen el SOAT vencido: ABC123 desde el 2 de julio, DEF456 desde el 11 de julio',
  'y GHI789 desde ayer. Sumadas, las pólizas cuestan 2.340.000 pesos al año. La tecnomecánica de',
  'ABC123 también se vence el 30 de agosto.',
].join(' ');

const ASKED = '¿Qué vehículos tienen papeles vencidos?';

describe('follow-up suggestions', () => {
  const words = contentWords(ANSWER);

  it('keeps a question that names something the answer actually said', () => {
    expect(keepIfSpecific('¿Cuánto cuesta renovar el SOAT de ABC123?', words, ASKED)).toBe(true);
    expect(keepIfSpecific('¿Programo la tecnomecánica de ABC123 para agosto?', words, ASKED)).toBe(
      true,
    );
    expect(keepIfSpecific('¿Cuánto suman las pólizas de los tres vehículos?', words, ASKED)).toBe(
      true,
    );
  });

  it('drops the generic ones, which are the whole reason this exists', () => {
    for (const filler of [
      '¿Quieres saber más sobre esto?',
      '¿Te amplío la información?',
      '¿Quieres que profundice en el tema?',
      '¿En qué más te puedo ayudar?',
      '¿Necesitas algo más?',
      '¿Continúo con el análisis?',
    ]) {
      expect(keepIfSpecific(filler, words, ASKED)).toBe(false);
    }
  });

  it('drops a question that shares no substantial word with the answer', () => {
    // Perfectly specific, and about something that was never mentioned — which
    // means the model invented the subject rather than reading it.
    expect(keepIfSpecific('¿Cuándo llega el contenedor de Buenaventura?', words, ASKED)).toBe(
      false,
    );
  });

  it('is not fooled by accents or case', () => {
    expect(keepIfSpecific('¿Que pasa si el soat de DEF456 sigue vencido?', words, ASKED)).toBe(
      true,
    );
  });

  it('refuses to hand back the question that was just asked', () => {
    expect(keepIfSpecific(ASKED, words, ASKED)).toBe(false);
  });

  it('drops fragments too short or too long to be a question', () => {
    expect(keepIfSpecific('¿Y ABC123?', words, ASKED)).toBe(false);
    expect(keepIfSpecific(`¿SOAT ${'x'.repeat(140)}?`, words, ASKED)).toBe(false);
  });

  it('reads the model output whether or not it bulleted it', () => {
    expect(
      parseSuggestions('- ¿Uno?\n2) ¿Dos?\n"¿Tres?"\n\n  \n• ¿Cuatro?'),
    ).toEqual(['¿Uno?', '¿Dos?', '¿Tres?', '¿Cuatro?']);
  });

  it('ignores connective tissue when deciding what the answer was about', () => {
    const stop = contentWords('Para cuando tienen que estar todos estos desde hasta');
    expect(stop.size).toBe(0);
  });
});
