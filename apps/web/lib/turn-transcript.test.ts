import { describe, expect, it } from 'vitest';
import {
  INTERRUPTION_NOTES,
  TurnTranscript,
  buildAssistantRecord,
  digestToolWork,
  formatNote,
  isInterruptedContent,
  withoutNotes,
} from './turn-transcript';

function transcriptWithTool(withResult: boolean) {
  const t = new TurnTranscript();
  t.onChunk({ type: 'reasoning', textDelta: 'pienso' });
  t.onChunk({ type: 'text-delta', textDelta: 'Leo la hoja.' });
  t.onChunk({ type: 'tool-call', toolCallId: 'c1', toolName: 'gsheets_read', args: { id: 'x' } });
  if (withResult)
    t.onChunk({
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'gsheets_read',
      result: { rows: 40 },
    });
  return t;
}

describe('lo producido, anotado mientras pasa', () => {
  it('un paso abierto cuenta aunque nunca haya terminado (abort a mitad)', () => {
    const t = transcriptWithTool(false);
    const steps = t.steps();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.toolCalls).toHaveLength(1);
    expect(steps[0]?.toolResults).toHaveLength(0);
  });

  it('onStepFinish dice si el paso ejecutó herramientas', () => {
    const t = transcriptWithTool(true);
    expect(t.onStepFinish()).toBe(true);
    t.onChunk({ type: 'text-delta', textDelta: 'Son 40.' });
    expect(t.onStepFinish()).toBe(false);
    expect(t.steps()).toHaveLength(2);
  });
});

describe('la fila que se guarda', () => {
  it('NUNCA un mensaje vacío: sin texto ni herramientas no hay fila', () => {
    expect(buildAssistantRecord([], 'error')).toBeNull();
    expect(buildAssistantRecord([{ text: '  ' }], 'deadline')).toBeNull();
  });

  it('un turno cortado lleva su nota en content y en parts, con la herramienta a medias', () => {
    const rec = buildAssistantRecord(transcriptWithTool(false).steps(), 'deadline');
    expect(rec?.content).toBe(`Leo la hoja.\n\n${formatNote(INTERRUPTION_NOTES.deadline)}`);
    const last = rec?.parts?.[rec.parts.length - 1];
    expect(last).toEqual({ type: 'text', text: formatNote(INTERRUPTION_NOTES.deadline) });
    expect(JSON.stringify(rec?.parts)).toContain('"state":"call"');
  });

  it('sólo herramientas y cortado: content es la nota, nunca vacío', () => {
    const t = new TurnTranscript();
    t.onChunk({ type: 'tool-call', toolCallId: 'c1', toolName: 'x', args: {} });
    const rec = buildAssistantRecord(t.steps(), 'error');
    expect(rec?.content).toBe(formatNote(INTERRUPTION_NOTES.error));
  });

  it('un turno completo se guarda sin nota', () => {
    const rec = buildAssistantRecord([{ text: 'Listo.' }], 'complete');
    expect(rec).toEqual({ content: 'Listo.', toolCalls: [], toolResults: [], parts: null });
  });

  it('las notas se reconocen y se quitan para comparar', () => {
    const c = `Hola\n\n${formatNote(INTERRUPTION_NOTES.pending)}`;
    expect(isInterruptedContent(c)).toBe(true);
    expect(isInterruptedContent('Hola')).toBe(false);
    expect(withoutNotes(c)).toBe('Hola');
  });
});

describe('el trabajo ya hecho, para que «sigue» no lo repita', () => {
  it('resume resultados y llamadas cortadas, recortado', () => {
    const t = transcriptWithTool(true);
    t.onChunk({ type: 'tool-call', toolCallId: 'c2', toolName: 'apps_design', args: {} });
    const rec = buildAssistantRecord(t.steps(), 'deadline');
    const digest = digestToolWork(rec?.parts);
    expect(digest).toContain('gsheets_read({"id":"x"}) → {"rows":40}');
    expect(digest).toContain('apps_design({}) → sin resultado');
    expect(digest).toContain('no repitas');
  });
  it('sin herramientas no hay resumen', () => {
    expect(digestToolWork(null)).toBe('');
    expect(digestToolWork([{ type: 'text', text: 'x' }])).toBe('');
  });
});
