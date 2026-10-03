import { describe, expect, it } from 'vitest';
import type { DocumentChunk } from '../../documents/verify';
import {
  type ObligationClaim,
  looksLikeContract,
  parseContractClaims,
  quoteStatesDays,
  verifyObligations,
  verifyTerm,
} from '../extract';

const TODAY = '2026-10-03';

const CONTRACT: DocumentChunk[] = [
  {
    id: 'c1',
    chunk_index: 0,
    content:
      'CONTRATO DE PRESTACIÓN DE SERVICIOS entre Transportes Andinos S.A.S. (EL CONTRATANTE) y Frío Express S.A.S. (EL CONTRATISTA). CLÁUSULA TERCERA. PLAZO. El presente contrato inicia el 1 de noviembre de 2026 y termina el 31 de octubre de 2027, y se prorrogará automáticamente por períodos iguales si ninguna de las partes avisa por escrito con treinta (30) días de anticipación.',
  },
  {
    id: 'c2',
    chunk_index: 1,
    content:
      'CLÁUSULA CUARTA. VALOR. El valor total es de $ 120.000.000. EL CONTRATANTE pagará mensualmente dentro de los cinco primeros días de cada mes la suma de $10.000.000. EL CONTRATISTA entregará el informe de temperaturas a más tardar el 15 de diciembre de 2026. En caso de retardo en la entrega del informe, EL CONTRATISTA pagará una multa equivalente al 1% del valor mensual por cada día de retraso.',
  },
];

function claim(partial: Partial<ObligationClaim>): ObligationClaim {
  return {
    party: 'nosotros',
    responsible: null,
    category: 'otra',
    description: 'algo',
    quote: '',
    dueOn: null,
    recurrence: 'none',
    dueNote: null,
    penaltyQuote: null,
    ...partial,
  };
}

describe('la puerta de las obligaciones', () => {
  it('rechaza lo que no trae frase o cuya frase no está en el contrato', () => {
    const { accepted, rejected } = verifyObligations(
      [
        claim({ description: 'Pagar el arriendo', quote: '' }),
        claim({
          description: 'Pagar la póliza',
          quote: 'EL CONTRATANTE pagará la póliza de cumplimiento cada año',
        }),
      ],
      CONTRACT,
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      'no trajo la frase del contrato que la dice',
      'la frase no está en el contrato',
    ]);
  });

  it('acepta una obligación con su frase y su fecha escrita en ella', () => {
    const { accepted } = verifyObligations(
      [
        claim({
          party: 'contraparte',
          responsible: 'EL CONTRATISTA',
          category: 'entrega',
          description: 'Entregar el informe de temperaturas',
          quote:
            'EL CONTRATISTA entregará el informe de temperaturas a más tardar el 15 de diciembre de 2026',
          dueOn: '2026-12-15',
          penaltyQuote:
            'En caso de retardo en la entrega del informe, EL CONTRATISTA pagará una multa equivalente al 1% del valor mensual por cada día de retraso',
        }),
      ],
      CONTRACT,
      TODAY,
    );
    expect(accepted).toHaveLength(1);
    const o = accepted[0];
    expect(o?.dueOn).toBe('2026-12-15');
    expect(o?.chunkId).toBe('c2');
    expect(o?.responsibleLabel).toBe('EL CONTRATISTA');
    expect(o?.penalty).toMatch(/multa equivalente al 1%/);
    expect(o?.confidence).toBe('alta');
    expect(o?.reviewNote).toBeNull();
  });

  it('una fecha calculada no pasa: queda sin fecha y con la razón', () => {
    const { accepted } = verifyObligations(
      [
        claim({
          description: 'Pagar la mensualidad',
          category: 'pago',
          quote:
            'EL CONTRATANTE pagará mensualmente dentro de los cinco primeros días de cada mes la suma de $10.000.000',
          dueOn: '2026-11-05',
          recurrence: 'monthly',
          dueNote: 'dentro de los cinco primeros días de cada mes',
        }),
      ],
      CONTRACT,
      TODAY,
    );
    const o = accepted[0];
    expect(o?.dueOn).toBeNull();
    expect(o?.recurrence).toBe('monthly');
    expect(o?.dueNote).toBe('dentro de los cinco primeros días de cada mes');
    expect(o?.reviewNote).toMatch(/calculada, no leída/);
    expect(o?.confidence).toBe('media');
  });

  it('una periodicidad que la frase no dice se quita', () => {
    const { accepted } = verifyObligations(
      [
        claim({
          quote:
            'EL CONTRATISTA entregará el informe de temperaturas a más tardar el 15 de diciembre de 2026',
          dueOn: '2026-12-15',
          recurrence: 'yearly',
        }),
      ],
      CONTRACT,
      TODAY,
    );
    expect(accepted[0]?.recurrence).toBe('none');
    expect(accepted[0]?.reviewNote).toMatch(/no dice que se repita/);
  });

  it('una sanción sin frase literal no se guarda', () => {
    const { accepted } = verifyObligations(
      [
        claim({
          quote:
            'EL CONTRATISTA entregará el informe de temperaturas a más tardar el 15 de diciembre de 2026',
          penaltyQuote: 'multa de diez salarios mínimos',
        }),
      ],
      CONTRACT,
      TODAY,
    );
    expect(accepted[0]?.penalty).toBeNull();
    expect(accepted[0]?.reviewNote).toMatch(/sanción/);
  });

  it('dos propuestas de la misma frase son una', () => {
    const q =
      'EL CONTRATISTA entregará el informe de temperaturas a más tardar el 15 de diciembre de 2026';
    const { accepted } = verifyObligations(
      [claim({ quote: q }), claim({ quote: q })],
      CONTRACT,
      TODAY,
    );
    expect(accepted).toHaveLength(1);
  });
});

describe('la vigencia', () => {
  it('cree inicio, fin, renovación automática, días de aviso y valor sólo con su frase', () => {
    const term = verifyTerm(
      {
        startOn: '2026-11-01',
        startQuote: 'El presente contrato inicia el 1 de noviembre de 2026',
        endOn: '2027-10-31',
        endQuote: 'termina el 31 de octubre de 2027',
        renewal: 'automatica',
        renewalQuote: 'se prorrogará automáticamente por períodos iguales',
        noticeDays: 30,
        noticeQuote: 'avisa por escrito con treinta (30) días de anticipación',
        valueAmount: 120_000_000,
        valueQuote: 'El valor total es de $ 120.000.000',
      },
      CONTRACT,
      TODAY,
    );
    expect(term.startOn.value).toBe('2026-11-01');
    expect(term.endOn.value).toBe('2027-10-31');
    expect(term.renewal.value).toBe('automatica');
    expect(term.noticeDays.value).toBe(30);
    expect(term.valueAmount.value).toBe(120_000_000);
  });

  it('rechaza lo que la frase no dice', () => {
    const term = verifyTerm(
      {
        startOn: null,
        startQuote: null,
        endOn: '2027-11-30',
        endQuote: 'termina el 31 de octubre de 2027',
        renewal: 'automatica',
        renewalQuote: 'CLÁUSULA TERCERA. PLAZO',
        noticeDays: 60,
        noticeQuote: 'avisa por escrito con treinta (30) días de anticipación',
        valueAmount: 99_000_000,
        valueQuote: 'El valor total es de $ 120.000.000',
      },
      CONTRACT,
      TODAY,
    );
    // La frase dice otra fecha de fin: se lee de la frase, con la nota.
    expect(term.endOn.value).toBe('2027-10-31');
    expect(term.endOn.note).toMatch(/leída de la frase/);
    expect(term.renewal.value).toBeNull();
    expect(term.noticeDays.value).toBeNull();
    expect(term.valueAmount.value).toBeNull();
  });

  it('reconoce días en cifras o en letras', () => {
    expect(quoteStatesDays('con treinta (30) días', 30)).toBe(true);
    expect(quoteStatesDays('con sesenta días de antelación', 60)).toBe(true);
    expect(quoteStatesDays('con sesenta días de antelación', 30)).toBe(false);
    expect(quoteStatesDays('con 90 días', 90)).toBe(true);
  });
});

describe('lo que devuelve el modelo', () => {
  it('tolera texto alrededor del JSON y basura', () => {
    expect(parseContractClaims('nada')).toEqual({ obligations: [], term: null });
    const parsed = parseContractClaims(
      'Aquí va: {"obligations":[{"party":"nosotros","description":"Pagar","quote":"x","dueOn":"null"}],"term":{"noticeDays":"30"}} fin',
    );
    expect(parsed.obligations[0]?.dueOn).toBeNull();
    expect(parsed.term?.noticeDays).toBe(30);
  });

  it('un texto que no es un contrato no se paga', () => {
    expect(looksLikeContract('Factura electrónica de venta No. FE-1043, total a pagar')).toBe(
      false,
    );
    expect(looksLikeContract(CONTRACT.map((c) => c.content).join(' '))).toBe(true);
  });
});
