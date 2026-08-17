import { describe, expect, it } from 'vitest';
import {
  buildDocumentCandidates,
  describeUploadProblem,
  parseFieldAnswers,
  verifyFieldAnswers,
} from './from-file';

/**
 * LA PUERTA ENTRE EL MODELO Y EL PANEL DE PROPUESTAS.
 *
 * NADA DE ESTE ARCHIVO LLAMA A ANTHROPIC NI PODRÍA: las funciones que prueba
 * reciben cadenas y devuelven cadenas. El modelo de verdad vive en
 * `read-document.ts` y aquí sólo existe como texto que dice haber leído cosas —
 * que es exactamente la postura correcta ante un modelo: lo que dice se
 * comprueba, no se cree.
 *
 * Como en `extract.test.ts`, casi todas las pruebas son sobre cuándo NO se
 * acepta nada, porque ésa es la mitad del trabajo que falla en silencio.
 */

const CERTIFICADO = [
  'CÁMARA DE COMERCIO DE BOGOTÁ',
  'CERTIFICADO DE EXISTENCIA Y REPRESENTACIÓN LEGAL',
  '',
  'Razón social: COLTRANS LOGÍSTICA S.A.S.',
  'NIT: 900.373.115-3',
  'Domicilio principal: Bogotá D.C.',
  'Fecha de matrícula: 12 de marzo de 2014',
  'Objeto social: la prestación de servicios de logística postal y aduanera',
  'en el territorio nacional.',
].join('\n');

const CATALOGO = {
  identidad: [
    'Razón social',
    'NIT',
    'A qué se dedica',
    'Dónde opera',
    'Desde cuándo',
    'Régimen tributario',
  ],
  operacion: ['Horario', 'Herramientas que usamos'],
};

const OPTS = { suggested: CATALOGO, excludeLabels: ['Razón social', 'NIT'] };

describe('describeUploadProblem', () => {
  it('acepta los cuatro tipos que parseDocument sabe leer', () => {
    for (const mime of [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ]) {
      expect(describeUploadProblem(mime, 1024)).toBeNull();
    }
  });

  it('acepta el mime aunque venga con parámetros', () => {
    expect(describeUploadProblem('text/plain; charset=utf-8', 1024)).toBeNull();
  });

  it('rechaza una imagen con una frase que dice qué sí se puede', () => {
    expect(describeUploadProblem('image/png', 1024)).toMatch(/PDF, DOCX, TXT y MD/);
  });

  it('rechaza lo que pasa de 10 MB, y lo dice en megas y no en bytes', () => {
    expect(describeUploadProblem('application/pdf', 10 * 1024 * 1024 + 1)).toMatch(/10 MB/);
  });

  it('rechaza el archivo vacío', () => {
    expect(describeUploadProblem('application/pdf', 0)).toMatch(/vacío/);
  });
});

describe('parseFieldAnswers', () => {
  it('lee el JSON aunque el modelo lo envuelva en prosa', () => {
    const raw =
      'Aquí están los campos:\n{"fields":[{"section":"identidad","label":"Dónde opera","value":"Bogotá D.C.","quote":"Domicilio principal: Bogotá D.C."}]}\nEso es todo.';
    expect(parseFieldAnswers(raw)).toEqual([
      {
        section: 'identidad',
        label: 'Dónde opera',
        value: 'Bogotá D.C.',
        quote: 'Domicilio principal: Bogotá D.C.',
      },
    ]);
  });

  it('devuelve vacío ante basura, JSON roto o la forma equivocada', () => {
    expect(parseFieldAnswers('no hay json aquí')).toEqual([]);
    expect(parseFieldAnswers('{"fields": "no es una lista"}')).toEqual([]);
    expect(parseFieldAnswers('{"otra": []}')).toEqual([]);
  });

  it('tira la entrada a la que le falte cualquiera de las cuatro piezas', () => {
    const raw = JSON.stringify({
      fields: [
        { section: 'identidad', label: 'Dónde opera', value: 'Bogotá' }, // sin quote
        { section: 'identidad', label: 'Dónde opera', quote: 'x' }, // sin value
        { label: 'Dónde opera', value: 'Bogotá', quote: 'x' }, // sin section
      ],
    });
    expect(parseFieldAnswers(raw)).toEqual([]);
  });
});

describe('verifyFieldAnswers', () => {
  const good = {
    section: 'identidad',
    label: 'Dónde opera',
    value: 'Bogotá D.C.',
    quote: 'Domicilio principal: Bogotá D.C.',
  };

  it('acepta la respuesta cuya cita está en el documento y cuyo valor está en la cita', () => {
    const { accepted, rejectedCount } = verifyFieldAnswers([good], CERTIFICADO, OPTS);
    expect(accepted).toEqual([good]);
    expect(rejectedCount).toBe(0);
  });

  it('sobrevive al salto de línea con que un PDF parte una frase', () => {
    // En el certificado la frase del objeto social está partida en dos
    // renglones; el modelo la devuelve seguida. Son la misma frase.
    const answer = {
      section: 'identidad',
      label: 'A qué se dedica',
      value: 'la prestación de servicios de logística postal y aduanera en el territorio nacional',
      quote:
        'Objeto social: la prestación de servicios de logística postal y aduanera en el territorio nacional.',
    };
    expect(verifyFieldAnswers([answer], CERTIFICADO, OPTS).accepted).toHaveLength(1);
  });

  it('TIRA la cita que no está en el documento, palabra por palabra', () => {
    const invented = { ...good, quote: 'La empresa opera principalmente en Bogotá D.C.' };
    const { accepted, rejectedCount } = verifyFieldAnswers([invented], CERTIFICADO, OPTS);
    expect(accepted).toEqual([]);
    expect(rejectedCount).toBe(1);
  });

  it('TIRA el valor redactado aunque la cita sea real — redactar no es citar', () => {
    // La cita existe tal cual; el valor es un resumen razonable que NO está en
    // ella. Ésta es la alucinación interesante: frase real, dato compuesto.
    const composed = {
      section: 'identidad',
      label: 'A qué se dedica',
      value: 'Logística postal y aduanera en Colombia',
      quote: 'Objeto social: la prestación de servicios de logística postal y aduanera',
    };
    const { accepted, rejectedCount } = verifyFieldAnswers([composed], CERTIFICADO, OPTS);
    expect(accepted).toEqual([]);
    expect(rejectedCount).toBe(1);
  });

  it('TIRA la etiqueta que no está en el catálogo — un campo inventado no es un campo nuevo', () => {
    const offCatalog = { ...good, label: 'Dirección de la bodega' };
    expect(verifyFieldAnswers([offCatalog], CERTIFICADO, OPTS).accepted).toEqual([]);
  });

  it('TIRA la sección que no existe', () => {
    const offSection = { ...good, section: 'finanzas' };
    expect(verifyFieldAnswers([offSection], CERTIFICADO, OPTS).accepted).toEqual([]);
  });

  it('TIRA la identidad aunque venga bien citada: esa vía es de pickIdentity', () => {
    const nit = {
      section: 'identidad',
      label: 'NIT',
      value: '900.373.115-3',
      quote: 'NIT: 900.373.115-3',
    };
    expect(verifyFieldAnswers([nit], CERTIFICADO, OPTS).accepted).toEqual([]);
  });

  it('normaliza la etiqueta a la del catálogo, para que «donde opera» no cree una segunda pregunta', () => {
    const variant = { ...good, label: 'DONDE OPERA' };
    const { accepted } = verifyFieldAnswers([variant], CERTIFICADO, OPTS);
    expect(accepted[0]?.label).toBe('Dónde opera');
  });

  it('dos respuestas a la misma pregunta son una: gana la primera', () => {
    const second = { ...good, value: 'Bogotá', quote: 'Domicilio principal: Bogotá D.C.' };
    const { accepted, rejectedCount } = verifyFieldAnswers([good, second], CERTIFICADO, OPTS);
    expect(accepted).toEqual([good]);
    // Un duplicado no es un rechazo: no enseña nada sobre cuánto creerle al resto.
    expect(rejectedCount).toBe(0);
  });

  it('una cita demasiado corta no identifica nada y se tira', () => {
    const tiny = { ...good, value: 'Bogotá', quote: 'Bogotá' };
    expect(verifyFieldAnswers([tiny], CERTIFICADO, OPTS).accepted).toEqual([]);
  });
});

describe('buildDocumentCandidates', () => {
  const identity = {
    legalName: {
      value: 'COLTRANS LOGÍSTICA S.A.S.',
      quote: 'Razón social: COLTRANS LOGÍSTICA S.A.S.',
      at: 10,
    },
    nit: { value: '900.373.115-3', quote: 'NIT: 900.373.115-3', at: 60 },
  };

  it('junta identidad y campos verificados en la MISMA forma que gather.ts', () => {
    const candidates = buildDocumentCandidates({
      fileName: 'camara-comercio.pdf',
      readAt: '15 ago 2026',
      identity,
      fields: [
        {
          section: 'identidad',
          label: 'Dónde opera',
          value: 'Bogotá D.C.',
          quote: 'Domicilio principal: Bogotá D.C.',
        },
      ],
    });

    expect(candidates.map((c) => c.label)).toEqual(['Razón social', 'NIT', 'Dónde opera']);
    for (const c of candidates) {
      // Todo con el mismo chip: el archivo, el día, y el renglón para cotejar.
      expect(c.provenance.kind).toBe('document');
      expect(c.provenance.source).toBe('camara-comercio.pdf');
      expect(c.provenance.readAt).toBe('15 ago 2026');
      expect(c.provenance.quote).toBeTruthy();
    }
  });

  it('sin identidad y sin campos devuelve vacío, no rellenos', () => {
    expect(
      buildDocumentCandidates({
        fileName: 'acta.pdf',
        identity: { legalName: null, nit: null },
        fields: [],
      }),
    ).toEqual([]);
  });

  it('la identidad a medias entra a medias: lo que no se encontró no existe', () => {
    const candidates = buildDocumentCandidates({
      fileName: 'contrato.pdf',
      identity: { legalName: null, nit: identity.nit },
      fields: [],
    });
    expect(candidates.map((c) => c.label)).toEqual(['NIT']);
  });
});
