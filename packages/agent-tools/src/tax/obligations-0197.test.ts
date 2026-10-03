import { describe, expect, it } from 'vitest';
import { collectBorradores } from './autopilot-drafts';
import { pickObligation } from './draft-tools';
import { buildTaxCalendar } from './engine';
import type { TaxObligation } from './shape';

/**
 * Lo que 0197 le agrega al calendario (patrimonio, precios de transferencia,
 * RUB), el aviso del piloto una semana antes y cómo `tax.draft` elige la
 * obligación de un periodo.
 */

const BASE = {
  nit: '900123453',
  personType: 'juridica' as const,
  granContribuyente: false,
  regimenSimple: false,
  ivaPeriodicity: 'bimestral' as const,
  agenteRetencion: true,
  icaCity: null,
  icaPeriodicity: null,
  exogena: false,
  activosExterior: false,
  camaraComercio: false,
  nominaElectronica: false,
  pila: false,
  facturacionElectronica: false,
};

describe('obligaciones nuevas del calendario', () => {
  it('patrimonio, precios de transferencia y RUB salen por confirmar', () => {
    const { obligations, gaps } = buildTaxCalendar(
      { ...BASE, impuestoPatrimonio: true, vinculadosExterior: true, rubLastChange: '2026-03-10' },
      2026,
    );
    const by = (k: string) => obligations.find((o) => o.key === k);
    expect(by('patrimonio:dec')?.dueDate.slice(0, 7)).toBe('2026-05');
    expect(by('patrimonio:c2')?.dueDate.slice(0, 7)).toBe('2026-09');
    expect(by('precios_transferencia:dec')?.form).toBe('120');
    expect(by('rub:2026-03-10')?.dueDate).toBe('2026-04-30');
    for (const k of ['patrimonio:dec', 'precios_transferencia:dec', 'rub:2026-03-10'])
      expect(by(k)?.needsConfirmation, k).toBe(true);
    expect(gaps.some((g) => g.includes('RUB'))).toBe(false);
  });

  it('sin fecha del último cambio, el RUB es un vacío explicado (no una fecha inventada)', () => {
    const { obligations, gaps } = buildTaxCalendar(BASE, 2026);
    expect(obligations.some((o) => o.kind === 'rub')).toBe(false);
    expect(gaps.some((g) => g.includes('RUB'))).toBe(true);
  });
});

const ob = (
  key: string,
  kind: TaxObligation['kind'],
  dueDate: string,
  status: TaxObligation['status'] = 'pendiente',
): TaxObligation => ({
  id: key,
  key,
  year: 2026,
  kind,
  period: key,
  title: key,
  authority: 'DIAN',
  form: null,
  dueDate,
  requiresPayment: true,
  needsConfirmation: false,
  ruleVersion: 'co-2026.1',
  sourceNote: null,
  status,
  statusAt: null,
  statusBy: null,
  statusNote: null,
  evidenceDocumentId: null,
  evidenceUrl: null,
  commitmentId: null,
});

describe('tax.draft elige la obligación', () => {
  const rows = [
    ob('iva:b4', 'iva', '2026-09-15', 'pagada'),
    ob('iva:b5', 'iva', '2026-11-12'),
    ob('iva:b6', 'iva', '2027-01-14'),
  ];
  it('por un mes del periodo', () => {
    expect(
      pickObligation(rows, { kind: 'iva', month: '2026-10', today: '2026-10-03' })?.obligation.key,
    ).toBe('iva:b5');
    expect(
      pickObligation(rows, { kind: 'iva', month: '2026-07', today: '2026-10-03' })?.obligation.key,
    ).toBe('iva:b4');
  });
  it('sin mes, la próxima pendiente', () => {
    expect(pickObligation(rows, { kind: 'iva', today: '2026-10-03' })?.obligation.key).toBe(
      'iva:b5',
    );
  });
});

describe('el piloto cuenta el borrador una semana antes', () => {
  const row = {
    obligationId: 'o1',
    kind: 'iva' as const,
    title: 'IVA bimestral — bimestre 5',
    dueOn: '2026-11-12',
    periodClosed: true,
    draftStatus: null,
    ownerName: 'Laura',
  };
  it('a 7 días, sólo aviso (sin acción), con el enlace al borrador', () => {
    const items = collectBorradores([row], '2026-11-05');
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Borrador de IVA listo para revisión del contador');
    expect(items[0]?.proposedAction).toBeNull();
    expect(items[0]?.href).toBe('/impuestos/borrador/o1');
  });
  it('no repite lo revisado, ni lo que ya cubre el recordatorio de 5 días', () => {
    expect(collectBorradores([{ ...row, draftStatus: 'revisado' }], '2026-11-05')).toHaveLength(0);
    expect(collectBorradores([row], '2026-11-08')).toHaveLength(0);
    expect(collectBorradores([{ ...row, periodClosed: false }], '2026-11-05')).toHaveLength(0);
  });
});
