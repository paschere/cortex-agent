import { describe, expect, it } from 'vitest';
import { DRAFT_NOTICE } from '../shape';
import {
  BUILTIN_TEMPLATES,
  type FillContext,
  builtinTemplate,
  fillTemplate,
  missingRequired,
  remainingPlaceholders,
} from '../templates';
import { countInWords, longSpanishDate, numberToSpanish, pesosInWords } from '../text';

const CTX: FillContext = {
  today: '2026-10-03',
  company: {
    nombre: 'Transportes Andinos S.A.S.',
    nit: '900123456-8',
    direccion: 'Calle 10 # 43-12, Medellín',
    ciudad: 'Medellín',
    representante: 'Laura Restrepo',
  },
  counterparty: { nombre: 'Coltrans S.A.S.', id: 'NIT 800765432-1', correo: 'legal@coltrans.co' },
  contract: {
    start_on: '2026-11-01',
    end_on: '2027-10-31',
    value_amount: 12_000_000,
    currency: 'COP',
    notice_days: 30,
  },
};

describe('las cifras como se escriben en un contrato', () => {
  it('escribe enteros en letras con apócope', () => {
    expect(numberToSpanish(1)).toBe('un');
    expect(numberToSpanish(21)).toBe('veintiún');
    expect(numberToSpanish(30)).toBe('treinta');
    expect(numberToSpanish(101)).toBe('ciento un');
    expect(numberToSpanish(100)).toBe('cien');
    expect(numberToSpanish(21_000)).toBe('veintiún mil');
    expect(numberToSpanish(1_000_000)).toBe('un millón');
    expect(numberToSpanish(1_423_500)).toBe('un millón cuatrocientos veintitrés mil quinientos');
    expect(numberToSpanish(2_500_000_000)).toBe('dos mil quinientos millones');
  });

  it('pesos con «de» sólo en millones exactos', () => {
    expect(pesosInWords(12_000_000)).toBe('doce millones de pesos m/cte ($12.000.000)');
    expect(pesosInWords(1_423_500)).toBe(
      'un millón cuatrocientos veintitrés mil quinientos pesos m/cte ($1.423.500)',
    );
    expect(pesosInWords(1)).toBe('un peso m/cte ($1)');
  });

  it('días y fechas', () => {
    expect(countInWords(30, 'día', 'días')).toBe('treinta (30) días');
    expect(longSpanishDate('2026-10-01')).toBe('1 de octubre de 2026');
    expect(longSpanishDate('el lunes')).toBe('el lunes');
  });
});

describe('llenar una plantilla', () => {
  const template = builtinTemplate('prestacion_servicios');
  if (!template) throw new Error('falta la plantilla');

  it('lleva el aviso de borrador arriba, siempre', () => {
    const r = fillTemplate(template, CTX, {});
    expect(r.text.startsWith(DRAFT_NOTICE)).toBe(true);
    expect(r.text).toContain('BORRADOR PARA REVISIÓN DE UN ABOGADO');
  });

  it('toma la empresa y la contraparte de los registros y escribe el valor en letras', () => {
    const r = fillTemplate(template, CTX, { objeto: 'Transporte de carga refrigerada' });
    expect(r.text).toContain('Transportes Andinos S.A.S., identificada con NIT 900123456-8');
    expect(r.text).toContain('Coltrans S.A.S.');
    expect(r.text).toContain('doce millones de pesos m/cte ($12.000.000)');
    expect(r.text).toContain('desde el 1 de noviembre de 2026 hasta el 31 de octubre de 2027');
    expect(r.text).toContain('treinta (30) días de anticipación');
    expect(r.fields.find((f) => f.key === 'objeto')?.origin).toBe('persona');
    expect(r.fields.find((f) => f.key === 'empresa_nit')?.origin).toBe('registro');
  });

  it('lo que dice la persona gana sobre el registro', () => {
    const r = fillTemplate(template, CTX, { contraparte_nombre: 'Coltrans Logística S.A.S.' });
    expect(r.text).toContain('Coltrans Logística S.A.S.');
    expect(r.fields.find((f) => f.key === 'contraparte_nombre')?.origin).toBe('persona');
  });

  it('nunca inventa: lo que nadie sabe queda como marcador visible', () => {
    const r = fillTemplate(template, { today: '2026-10-03' }, {});
    expect(r.text).toContain('[COMPLETAR: Razón social de la empresa]');
    expect(r.text).toContain('[COMPLETAR: Objeto: qué servicio se presta]');
    expect(r.missing).toContain('Valor total u honorarios');
    expect(missingRequired(template, r)).toContain('Cédula o NIT del contratista');
    // La cédula del representante no se saca de ningún lado.
    expect(r.text).toContain('[COMPLETAR: Cédula del representante legal]');
  });

  it('el texto por defecto de una cláusula se usa, pero nunca para datos de personas', () => {
    const nda = builtinTemplate('confidencialidad');
    if (!nda) throw new Error('falta');
    const r = fillTemplate(nda, CTX, { proposito: 'evaluar una alianza' });
    expect(r.text).toContain('dos (2) años contados desde la terminación');
    for (const t of BUILTIN_TEMPLATES) {
      for (const f of t.fields) {
        if (f.default) expect(['text', 'longtext']).toContain(f.kind);
        if (f.default) expect(f.key).not.toMatch(/nombre|_id$|nit|valor|salario|canon|precio/);
      }
    }
  });

  it('cuenta los marcadores que quedan', () => {
    expect(remainingPlaceholders('a [COMPLETAR: x] b [COMPLETAR: y] [COMPLETAR: x]')).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('las plantillas de serie', () => {
  it('están las ocho que se prometieron', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.key).sort()).toEqual(
      [
        'arrendamiento_comercial',
        'compraventa',
        'confidencialidad',
        'laboral_fijo',
        'laboral_indefinido',
        'otrosi',
        'prestacion_servicios',
        'terminacion',
      ].sort(),
    );
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s: cada marcador tiene su campo',
    (_k, t) => {
      const keys = new Set(t.fields.map((f) => f.key));
      const used = [...t.body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1] as string);
      expect(used.filter((k) => !keys.has(k))).toEqual([]);
      expect(t.legalNotes.length).toBeGreaterThan(0);
    },
  );

  it('las laborales llevan la advertencia de la reforma de 2025', () => {
    for (const key of ['laboral_fijo', 'laboral_indefinido']) {
      const t = builtinTemplate(key);
      expect(t?.legalNotes.join(' ')).toMatch(/Ley 2466 de 2025/);
    }
  });
});
