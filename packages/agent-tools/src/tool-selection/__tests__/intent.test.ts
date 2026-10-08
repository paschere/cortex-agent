import { describe, expect, it } from 'vitest';
import { intentFamilies } from '../intent';
import { type SelectableTool, rankTools } from '../rank';

const FLOW = ['feed', 'trackers', 'gdrive', 'gsheets', 'apps', 'views'];

describe('reglas de intención', () => {
  it('un enlace de Sheets trae las familias del flujo', () => {
    const f = intentFamilies('mira https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit');
    for (const family of FLOW) expect(f).toContain(family);
  });
  it('un enlace de Drive también', () => {
    const f = intentFamilies('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp');
    for (const family of FLOW) expect(f).toContain(family);
  });
  it('palabras de hoja, pestaña, carpeta, tabla, aplicación o vista', () => {
    for (const w of ['la pestaña Ventas', 'esta carpeta', 'crea una aplicación', 'una vista'])
      expect(intentFamilies(w)).toContain('trackers');
  });
  it('una frase sin relación no fuerza nada', () => {
    expect(intentFamilies('¿qué hora es en Bogotá?')).toEqual([]);
  });
  it('rankTools conserva esas familias aunque puntúen cero', () => {
    const tools: SelectableTool[] = Array.from({ length: 60 }, (_, i) => ({
      id: `${i < 5 ? 'trackers' : `fam${i}`}.t${i}`,
      description: 'x',
    }));
    const vectors = new Map(tools.map((t) => [t.id, [0, 1]]));
    const ranked = rankTools({
      tools,
      queryVector: [1, 0],
      vectors,
      alwaysFamilies: new Set(['kb', ...intentFamilies('docs.google.com/spreadsheets/d/abc')]),
    });
    expect(ranked.tools.some((t) => t.id.startsWith('trackers.'))).toBe(true);
  });
});
