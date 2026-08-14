import { describe, expect, it } from 'vitest';
import {
  COMPANY_FACTS_BUDGET,
  COMPANY_SECTIONS,
  COMPANY_SECTION_KEYS,
  type CompanyFact,
  UnknownCompanySectionError,
  companyFactsBudget,
  companySectionByKey,
  renderCompanyFactsBlock,
  weighCompanyFacts,
} from '../shape';

/**
 * La ficha de la empresa, probada donde de verdad puede fallar.
 *
 * Las tres cosas que este archivo defiende, y ninguna es de formato:
 *
 *   Un espacio SIN hechos no mete un bloque vacío en el prompt. Es el fallo que
 *   nadie ve —un `<about_this_company>` con las cinco secciones en blanco pasa
 *   desapercibido en una revisión y se cobra en cada turno de cada persona para
 *   siempre.
 *   El presupuesto cuenta lo que de verdad se envía, no una aproximación.
 *   El renderizador NO TRUNCA. Pasarse se enseña; recortar en silencio, jamás.
 */

const fact = (section: string, label: string, value: string): CompanyFact => ({
  section,
  label,
  value,
});

describe('un espacio sin hechos no mete nada en el prompt', () => {
  it('sin hechos devuelve cadena vacía, no un bloque en blanco', () => {
    expect(renderCompanyFactsBlock([])).toBe('');
  });

  it('con hechos cuya sección nadie reconoce tampoco dibuja nada', () => {
    // Una fila con un slug fuera del registro es un error de datos, no una
    // sección nueva: no se inventa un encabezado con el slug crudo.
    expect(renderCompanyFactsBlock([fact('inventada', 'Algo', 'lo que sea')])).toBe('');
  });

  it('con hechos en blanco tampoco: un valor vacío no es un hecho', () => {
    expect(renderCompanyFactsBlock([fact('identidad', 'NIT', '   ')])).toBe('');
  });

  it('sin hechos el presupuesto está a cero y no en negativo', () => {
    const budget = companyFactsBudget([]);
    expect(budget.used).toBe(0);
    expect(budget.share).toBe(0);
    expect(budget.over).toBe(false);
    expect(budget.remaining).toBe(COMPANY_FACTS_BUDGET);
  });
});

describe('el bloque', () => {
  const facts = [
    fact('limites', 'Qué no debe hacer sin permiso', 'Prometer descuentos.'),
    fact('identidad', 'NIT', '901.234.567-8'),
    fact('identidad', 'Razón social', 'Transportes del Norte SAS'),
  ];

  it('respeta el orden del registro y no el de las filas', () => {
    const block = renderCompanyFactsBlock(facts);
    expect(block.indexOf('## Identidad')).toBeLessThan(block.indexOf('## Lo que no'));
  });

  it('pone «Lo que no» de último, que es donde una restricción pesa más', () => {
    expect(COMPANY_SECTIONS[COMPANY_SECTIONS.length - 1]?.key).toBe('limites');
  });

  it('no dibuja las secciones que no tienen hechos', () => {
    expect(renderCompanyFactsBlock(facts)).not.toContain('## Quién es quién');
  });

  it('escribe cada hecho como una línea legible y recortada', () => {
    expect(renderCompanyFactsBlock([fact('identidad', '  NIT  ', '  901.234.567-8  ')])).toContain(
      '- NIT: 901.234.567-8',
    );
  });

  it('permite citar la ficha, al revés que las memorias personales', () => {
    // La regla de discreción de `renderMemoryBlock` («never read them back») no
    // se copia aquí a propósito: negarse a decir el propio NIT al propio dueño
    // sería el resultado de copiarla sin pensar.
    const block = renderCompanyFactsBlock(facts);
    expect(block).toMatch(/you may quote any of it back/i);
    expect(block).not.toMatch(/never read them back/i);
  });

  it('le prohíbe inventarse lo que no está escrito', () => {
    expect(renderCompanyFactsBlock(facts)).toMatch(/never invent a NIT/i);
  });
});

describe('el presupuesto', () => {
  it('mide la línea que de verdad se envía, formato incluido', () => {
    // '- NIT: 900\n' son 11 caracteres, más '\n## Identidad\n' que son 14.
    expect(weighCompanyFacts([fact('identidad', 'NIT', '900')])).toBe(11 + 14);
  });

  it('cobra el encabezado de una sección UNA vez, no una por hecho', () => {
    const uno = weighCompanyFacts([fact('identidad', 'NIT', '900')]);
    const dos = weighCompanyFacts([
      fact('identidad', 'NIT', '900'),
      fact('identidad', 'Razón social', 'Acme'),
    ]);
    expect(dos - uno).toBe('- Razón social: Acme\n'.length);
  });

  it('cuenta lo que se envía y no lo que se escribió: los espacios sobran', () => {
    expect(weighCompanyFacts([fact('identidad', '  NIT  ', '  900  ')])).toBe(
      weighCompanyFacts([fact('identidad', 'NIT', '900')]),
    );
  });

  it('el peso del bloque nunca es menor que lo que dice el medidor', () => {
    // El medidor excluye a propósito el marco fijo (etiqueta XML y reglas), que
    // nadie puede acortar. Lo que no puede pasar es que mida de MÁS: sería un
    // presupuesto que rechaza datos que sí cabían.
    const facts = [
      fact('identidad', 'NIT', '901.234.567-8'),
      fact('ingresos', 'Plazo de pago', 'A 30 días.'),
    ];
    expect(weighCompanyFacts(facts)).toBeLessThan(renderCompanyFactsBlock(facts).length);
  });

  it('pasarse se enseña, no se esconde', () => {
    const gordos = Array.from({ length: 30 }, (_, i) =>
      fact('operacion', `Regla ${i}`, 'x'.repeat(280)),
    );
    const budget = companyFactsBudget(gordos);
    expect(budget.over).toBe(true);
    expect(budget.share).toBeGreaterThan(1);
    expect(budget.remaining).toBeLessThan(0);
  });

  it('NUNCA trunca: pasado el tope, el bloque sigue llevándolo todo', () => {
    // Es la garantía del módulo. Recortar aquí haría desaparecer una línea de
    // «Lo que no» del prompt sin que nadie pudiera verlo.
    const gordos = Array.from({ length: 30 }, (_, i) =>
      fact('operacion', `Regla ${i}`, 'x'.repeat(280)),
    );
    const block = renderCompanyFactsBlock(gordos);
    expect(block.length).toBeGreaterThan(COMPANY_FACTS_BUDGET);
    for (let i = 0; i < 30; i++) expect(block).toContain(`- Regla ${i}: `);
  });

  it('el tope deja sitio a una ficha real de las cinco secciones', () => {
    // Ocho hechos por sección a ~90 caracteres es la ficha que este módulo
    // existe para que quepa. Si alguien baja el tope, esta prueba lo dice.
    const real = COMPANY_SECTIONS.flatMap((s) =>
      Array.from({ length: 8 }, (_, i) => fact(s.key, `Dato ${i}`, 'x'.repeat(72))),
    );
    expect(companyFactsBudget(real).over).toBe(false);
  });
});

describe('el registro de secciones', () => {
  it('tiene slugs que pasan el CHECK de forma de la 0104', () => {
    for (const key of COMPANY_SECTION_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]{2,39}$/);
  });

  it('no repite slugs', () => {
    expect(new Set(COMPANY_SECTION_KEYS).size).toBe(COMPANY_SECTION_KEYS.length);
  });

  it('cada sección sugiere algo: una sección sin campos no se sabe llenar', () => {
    for (const section of COMPANY_SECTIONS) {
      expect(section.suggested.length).toBeGreaterThan(0);
      expect(section.blurb.length).toBeGreaterThan(20);
      for (const s of section.suggested) expect(s.length).toBeLessThanOrEqual(60);
    }
  });

  it('rechaza una sección que no existe, con la lista de las que sí', () => {
    expect(() => companySectionByKey('clientes')).toThrow(UnknownCompanySectionError);
    expect(() => companySectionByKey('clientes')).toThrow(/identidad/);
  });
});
