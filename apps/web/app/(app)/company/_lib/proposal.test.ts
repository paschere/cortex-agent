import { COMPANY_FACTS_BUDGET } from '@/lib/company-facts-shape';
import { describe, expect, it } from 'vitest';
import {
  type FactCandidate,
  type ProposalSource,
  type SelectOptions,
  isBulkAcceptable,
  labelKey,
  selectProposal,
  weighSelection,
} from './proposal';

/**
 * LA SELECCIÓN, QUE ES DONDE VIVE LO QUE PUEDE SALIR MAL EN SILENCIO.
 *
 * Un dato equivocado en la ficha de la empresa no arruina una respuesta:
 * arruina todas, durante meses, y nadie lo nota porque ese dato ya no se vuelve
 * a mirar. Así que este archivo no prueba «que la función devuelva algo»:
 * prueba, uno por uno, TODOS LOS CASOS EN QUE NO DEBE DEVOLVER NADA.
 *
 * SIN RED, SIN BASE DE DATOS, SIN MODELO Y SIN RELOJ. `selectProposal` recibe
 * una lista y devuelve otra. Si esta suite pasara a depender de algo de eso, lo
 * que se estaría probando ya no sería la regla.
 */

const SECTIONS: Record<string, string> = {
  identidad: 'Identidad',
  ingresos: 'Cómo entra la plata',
  operacion: 'Cómo se trabaja aquí',
};

const BASE: SelectOptions = {
  written: [],
  sectionNames: SECTIONS,
  sectionOrder: ['identidad', 'ingresos', 'operacion'],
  suggested: {
    identidad: ['Razón social', 'NIT', 'A qué se dedica'],
    ingresos: ['Qué vendemos', 'Plazo de pago', 'Moneda'],
    operacion: ['Horario', 'Herramientas que usamos'],
  },
};

function candidate(over: Partial<FactCandidate> & { label: string }): FactCandidate {
  const kind: ProposalSource = over.provenance?.kind ?? 'document';
  return {
    section: over.section ?? 'identidad',
    label: over.label,
    value: over.value ?? 'un valor',
    provenance: over.provenance ?? { kind, source: 'Contrato Coltrans' },
  };
}

function values(candidates: FactCandidate[], opts: Partial<SelectOptions> = {}) {
  return selectProposal(candidates, { ...BASE, ...opts }).facts.map((f) => `${f.label}=${f.value}`);
}

// ---------------------------------------------------------------------------
// LA LEY 1: lo que no se encontró se queda vacío
// ---------------------------------------------------------------------------

describe('lo que no se encontró se queda vacío', () => {
  it('descarta un candidato con el valor vacío', () => {
    expect(values([candidate({ label: 'NIT', value: '' })])).toEqual([]);
  });

  it('descarta un candidato que sólo trae espacios', () => {
    expect(values([candidate({ label: 'NIT', value: '   \n\t ' })])).toEqual([]);
  });

  it('NO fabrica un hueco como si fuera un valor', () => {
    // Ni «(no encontrado)» ni «—» ni «pendiente». Un campo sin respuesta sale
    // en `unresolved`, que es una lista de preguntas y no de respuestas.
    const p = selectProposal([candidate({ label: 'NIT', value: '' })], BASE);
    expect(p.facts).toEqual([]);
    expect(p.unresolved).toContainEqual({ section: 'identidad', label: 'NIT' });
  });

  it('lista como sin responder TODO lo sugerido cuando no llegó ni un candidato', () => {
    const p = selectProposal([], BASE);
    expect(p.facts).toEqual([]);
    expect(p.unresolved).toHaveLength(8);
    expect(p.unresolved[0]).toEqual({ section: 'identidad', label: 'Razón social' });
  });

  it('no deja en el hueco lo que sí se respondió', () => {
    const p = selectProposal([candidate({ label: 'NIT', value: '900.373.115-3' })], BASE);
    expect(p.unresolved.map((u) => u.label)).not.toContain('NIT');
  });

  it('no deja en el hueco lo que ya estaba escrito', () => {
    const p = selectProposal([], {
      ...BASE,
      written: [{ section: 'identidad', label: 'NIT', value: '900.373.115-3' }],
    });
    expect(p.unresolved.map((u) => u.label)).not.toContain('NIT');
  });

  it('un valor propuesto que llega con espacios se guarda recortado', () => {
    const p = selectProposal([candidate({ label: 'NIT', value: '  900.373.115-3  ' })], BASE);
    expect(p.facts[0]?.value).toBe('900.373.115-3');
  });
});

// ---------------------------------------------------------------------------
// LA LEY 2: sin procedencia no hay chip, y sin chip no hay valor
// ---------------------------------------------------------------------------

describe('un valor sin procedencia no existe', () => {
  it('descarta un candidato cuya fuente viene vacía', () => {
    expect(
      values([
        candidate({
          label: 'NIT',
          value: '900.373.115-3',
          provenance: { kind: 'web', source: '' },
        }),
      ]),
    ).toEqual([]);
  });

  it('descarta un candidato cuya fuente son espacios', () => {
    expect(
      values([
        candidate({
          label: 'NIT',
          value: '900.373.115-3',
          provenance: { kind: 'web', source: '   ' },
        }),
      ]),
    ).toEqual([]);
  });

  it('lo que sobrevive lleva SIEMPRE con qué pintar el chip', () => {
    const p = selectProposal(
      [
        candidate({ label: 'NIT', value: '900.373.115-3' }),
        candidate({ label: 'Moneda', section: 'ingresos', value: 'COP' }),
      ],
      BASE,
    );
    expect(p.facts).toHaveLength(2);
    for (const fact of p.facts) expect(fact.provenance.source.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LA LEY 3: no se pisa lo que una persona escribió
// ---------------------------------------------------------------------------

describe('no se propone encima de lo escrito', () => {
  const written = [{ section: 'identidad', label: 'NIT', value: '900.373.115-3' }];

  it('no propone un campo que ya está respondido', () => {
    expect(values([candidate({ label: 'NIT', value: '800.111.222-1' })], { written })).toEqual([]);
  });

  it('tampoco si la etiqueta viene con otras mayúsculas o sin tildes', () => {
    expect(values([candidate({ label: 'nit', value: '800.111.222-1' })], { written })).toEqual([]);
    expect(
      values([candidate({ label: 'Razon social', value: 'X S.A.S.' })], {
        written: [{ section: 'identidad', label: 'Razón social', value: 'Coltrans S.A.S.' }],
      }),
    ).toEqual([]);
  });

  it('sí propone el mismo nombre en OTRA sección', () => {
    // «Moneda» en identidad y «Moneda» en ingresos son dos filas distintas para
    // la base (el índice único es por sección), así que también aquí.
    expect(
      values([candidate({ label: 'NIT', section: 'ingresos', value: '800.111.222-1' })], {
        written,
      }),
    ).toEqual(['NIT=800.111.222-1']);
  });
});

// ---------------------------------------------------------------------------
// LA LEY 4: nunca se recorta
// ---------------------------------------------------------------------------

describe('nunca se recorta un valor para que quepa', () => {
  it('descarta entero un valor que se pasa del tope de un dato', () => {
    const p = selectProposal(
      [candidate({ label: 'A qué se dedica', value: 'x'.repeat(301) })],
      BASE,
    );
    expect(p.facts).toEqual([]);
  });

  it('acepta el que mide justo el tope', () => {
    const p = selectProposal(
      [candidate({ label: 'A qué se dedica', value: 'x'.repeat(300) })],
      BASE,
    );
    expect(p.facts[0]?.value).toHaveLength(300);
  });

  it('descarta una etiqueta demasiado larga o demasiado corta', () => {
    expect(values([candidate({ label: 'x'.repeat(61), value: 'algo' })])).toEqual([]);
    expect(values([candidate({ label: 'x', value: 'algo' })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// La quinta: la fuente más fiable gana, y la otra no desaparece
// ---------------------------------------------------------------------------

describe('cuando dos fuentes responden a la misma pregunta', () => {
  const web = candidate({
    label: 'Razón social',
    value: 'Coltrans',
    provenance: { kind: 'web', source: 'coltrans.com' },
  });
  const doc = candidate({
    label: 'Razón social',
    value: 'COLTRANS LOGÍSTICA S.A.S.',
    provenance: { kind: 'document', source: 'Contrato Coltrans' },
  });

  it('gana el documento a la web, llegue en el orden que llegue', () => {
    expect(values([web, doc])).toEqual(['Razón social=COLTRANS LOGÍSTICA S.A.S.']);
    expect(values([doc, web])).toEqual(['Razón social=COLTRANS LOGÍSTICA S.A.S.']);
  });

  it('la perdedora queda a un clic, no se tira', () => {
    const p = selectProposal([web, doc], BASE);
    expect(p.facts[0]?.alternatives).toEqual([
      { value: 'Coltrans', provenance: { kind: 'web', source: 'coltrans.com' } },
    ]);
  });

  it('el registro mercantil, el día que exista, le gana al contrato', () => {
    // RUES no está conectado y no se ha escrito el conector. Lo que sí está es
    // el escalón: un candidato `registry` gana sin tocar la selección.
    const rues = candidate({
      label: 'Razón social',
      value: 'COLTRANS LOGISTICA S A S',
      provenance: { kind: 'registry', source: 'RUES' },
    });
    expect(values([doc, rues, web])[0]).toBe('Razón social=COLTRANS LOGISTICA S A S');
  });

  it('el documento le gana a lo derivado del propio espacio', () => {
    const own = candidate({
      label: 'Razón social',
      value: 'Coltrans',
      provenance: { kind: 'workspace', source: 'Tu espacio' },
    });
    expect(values([own, doc])[0]).toBe('Razón social=COLTRANS LOGÍSTICA S.A.S.');
  });

  it('dos fuentes que dicen lo MISMO no se pintan como una duda', () => {
    const same = candidate({
      label: 'Razón social',
      value: 'COLTRANS LOGÍSTICA S.A.S.',
      provenance: { kind: 'web', source: 'coltrans.com' },
    });
    expect(selectProposal([doc, same], BASE).facts[0]?.alternatives).toEqual([]);
  });

  it('entre dos de la misma fuente manda el orden en que las puso el recolector', () => {
    const observado = candidate({
      section: 'ingresos',
      label: 'Plazo de pago',
      value: '47 días',
      provenance: { kind: 'workspace', source: 'Tus pagos' },
    });
    const pactado = candidate({
      section: 'ingresos',
      label: 'Plazo de pago',
      value: '30 días',
      provenance: { kind: 'workspace', source: 'Tus clientes' },
    });
    const p = selectProposal([observado, pactado], BASE);
    expect(p.facts[0]?.value).toBe('47 días');
    expect(p.facts[0]?.alternatives[0]?.value).toBe('30 días');
  });
});

// ---------------------------------------------------------------------------
// El orden y las secciones
// ---------------------------------------------------------------------------

describe('el orden en que se lee', () => {
  it('sale por secciones y, dentro, como las pregunta la pantalla', () => {
    const p = selectProposal(
      [
        candidate({ section: 'ingresos', label: 'Moneda', value: 'COP' }),
        candidate({ section: 'identidad', label: 'NIT', value: '900.373.115-3' }),
        candidate({ section: 'ingresos', label: 'Qué vendemos', value: 'carga' }),
        candidate({ section: 'identidad', label: 'Razón social', value: 'X S.A.S.' }),
      ],
      BASE,
    );
    expect(p.facts.map((f) => f.label)).toEqual(['Razón social', 'NIT', 'Qué vendemos', 'Moneda']);
  });

  it('lo que nadie sugirió va después de lo sugerido, no antes', () => {
    const p = selectProposal(
      [
        candidate({ section: 'identidad', label: 'Matrícula mercantil', value: '1234' }),
        candidate({ section: 'identidad', label: 'NIT', value: '900.373.115-3' }),
      ],
      BASE,
    );
    expect(p.facts.map((f) => f.label)).toEqual(['NIT', 'Matrícula mercantil']);
  });

  it('descarta un candidato de una sección que no existe', () => {
    // El mismo criterio que `renderCompanyFactsBlock`: el registro manda, y un
    // slug que nadie reconoce es un error de quien recolectó.
    expect(
      values([candidate({ section: 'inventada', label: 'NIT', value: '900.373.115-3' })]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// El presupuesto, dicho ANTES
// ---------------------------------------------------------------------------

describe('el presupuesto se avisa antes de aceptar', () => {
  it('pesa lo que hay, lo que habría, y no se lo inventa', () => {
    const p = selectProposal([candidate({ label: 'NIT', value: '900.373.115-3' })], BASE);
    expect(p.usedNow).toBe(0);
    expect(p.budget).toBe(COMPANY_FACTS_BUDGET);
    // El encabezado de la sección pesa, porque el hecho la hace aparecer.
    expect(p.usedIfAll).toBe('\n## Identidad\n'.length + '- NIT: 900.373.115-3\n'.length);
    expect(p.overIfAll).toBe(false);
  });

  it('avisa cuando aceptar la propuesta entera se pasaría del tope', () => {
    const written = Array.from({ length: 14 }, (_, i) => ({
      section: 'identidad',
      label: `Dato ${i}`,
      value: 'x'.repeat(280),
    }));
    const p = selectProposal([candidate({ label: 'NIT', value: 'y'.repeat(280) })], {
      ...BASE,
      written,
    });
    expect(p.overIfAll).toBe(true);
    expect(p.usedIfAll).toBeGreaterThan(COMPANY_FACTS_BUDGET);
  });

  it('avisa también cuando lo que se pasaría es el número de filas', () => {
    const written = Array.from({ length: 120 }, (_, i) => ({
      section: 'identidad',
      label: `Dato ${i}`,
      value: 'x',
    }));
    const p = selectProposal([candidate({ label: 'NIT', value: '900.373.115-3' })], {
      ...BASE,
      written,
    });
    expect(p.countIfAll).toBe(121);
    expect(p.overCountIfAll).toBe(true);
  });

  it('el medidor de lo MARCADO cuenta sólo lo marcado', () => {
    const written = [{ section: 'identidad', label: 'NIT', value: '900.373.115-3' }];
    const solo = weighSelection(written, [], SECTIONS);
    const conUno = weighSelection(
      written,
      [{ section: 'ingresos', label: 'Moneda', value: 'COP' }],
      SECTIONS,
    );
    expect(conUno).toBe(solo + '\n## Cómo entra la plata\n'.length + '- Moneda: COP\n'.length);
  });
});

// ---------------------------------------------------------------------------
// El «aceptar todos», acotado por procedencia
// ---------------------------------------------------------------------------

describe('qué se puede aceptar en bloque', () => {
  it('lo del registro, los documentos y sus propios datos, sí', () => {
    expect(isBulkAcceptable('registry')).toBe(true);
    expect(isBulkAcceptable('document')).toBe(true);
    expect(isBulkAcceptable('workspace')).toBe(true);
  });

  it('lo de la web, NUNCA', () => {
    // Un valor leído de una página web se acepta de uno en uno o no se acepta.
    // Es la única regla que impide que el botón convierta la revisión campo por
    // campo en un adorno.
    expect(isBulkAcceptable('web')).toBe(false);
  });
});

describe('labelKey', () => {
  it('iguala mayúsculas, tildes y espacios de sobra', () => {
    expect(labelKey('  Razón   Social ')).toBe(labelKey('razon social'));
  });
});
