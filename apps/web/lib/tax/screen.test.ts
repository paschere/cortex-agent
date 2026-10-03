import { obligationsCsv } from '@/components/tax/export';
import { type TaxObligation, generateObligations } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { adaptObligation, buildTaxScreen, nitFromFacts, obligationTone, summarize } from './screen';

const gen = generateObligations(
  {
    nit: '900123456',
    personType: 'juridica',
    granContribuyente: false,
    regimenSimple: false,
    ivaPeriodicity: 'bimestral',
    agenteRetencion: true,
    icaCity: null,
    icaPeriodicity: null,
    exogena: false,
    activosExterior: false,
    camaraComercio: true,
    nominaElectronica: false,
    pila: false,
    facturacionElectronica: false,
  },
  2026,
);

function row(i: number, extra: Partial<TaxObligation> = {}): TaxObligation {
  const g = gen[i];
  if (!g) throw new Error('sin fila');
  return {
    ...g,
    id: `o${i}`,
    status: 'pendiente',
    statusAt: null,
    statusBy: null,
    statusNote: null,
    evidenceDocumentId: null,
    evidenceUrl: null,
    commitmentId: null,
    ...extra,
  };
}

describe('la pantalla de Impuestos', () => {
  it('el tono dice la urgencia: vencida rosa, esta semana ámbar, después índigo', () => {
    expect(obligationTone({ status: 'pendiente', requiresPayment: true }, -1)).toBe('rose');
    expect(obligationTone({ status: 'pendiente', requiresPayment: true }, 3)).toBe('amber');
    expect(obligationTone({ status: 'pendiente', requiresPayment: true }, 30)).toBe('primary');
    expect(obligationTone({ status: 'presentada', requiresPayment: true }, 30)).toBe('amber');
    expect(obligationTone({ status: 'presentada', requiresPayment: false }, -5)).toBe('emerald');
    expect(obligationTone({ status: 'no_aplica', requiresPayment: true }, -5)).toBe('neutral');
  });

  it('arma el resumen: pendientes, vencidas sin marcar y la próxima', () => {
    const today = '2026-10-03';
    const rows = gen.map((_, i) =>
      row(
        i,
        gen[i] && gen[i].dueDate < '2026-09-01'
          ? { status: 'pagada', statusAt: '2026-08-01T00:00:00Z' }
          : {},
      ),
    );
    const views = rows.map((o) => adaptObligation(o, today));
    const s = summarize(views);
    expect(s.overdue).toBeGreaterThan(0);
    expect(s.next?.daysLeft).toBeGreaterThanOrEqual(0);
    expect(views.find((v) => v.status === 'pagada')?.whenText).toMatch(/^Pagada el/);
  });

  it('la evidencia del Cerebro lleva al documento, con el espacio de trabajo', () => {
    const v = adaptObligation(
      row(0, { evidenceDocumentId: 'd1', status: 'pagada' }),
      '2026-10-03',
      {
        href: (p) => `${p}&workspace=org`,
        documentTitles: new Map([['d1', 'Recibo 490']]),
      },
    );
    expect(v.evidenceHref).toBe('/kb?document=d1&workspace=org');
    expect(v.evidenceLabel).toBe('Recibo 490');
  });

  it('sin perfil, propone el NIT escrito en Datos de la empresa', () => {
    expect(nitFromFacts([{ label: 'NIT', value: '900.123.456-8' }])).toBe('900.123.456-8');
    expect(nitFromFacts([{ label: 'Razón social', value: 'Andinos' }])).toBeNull();
    const data = buildTaxScreen({
      year: 2026,
      years: [2026],
      today: '2026-10-03',
      profile: null,
      obligations: [],
      gaps: [],
      sourceLine: '',
      canEdit: true,
      canMark: false,
      people: [],
      suggestedNit: '900123456',
    });
    expect(data.profile).toBeNull();
    expect(data.summary.next).toBeNull();
  });

  it('exporta un CSV con BOM, comillas y la marca de por confirmar', () => {
    const csv = obligationsCsv([
      adaptObligation(row(0, { title: 'Renta, "cuota" 1', needsConfirmation: true }), '2026-01-01'),
    ]);
    expect(csv.startsWith('﻿Fecha,')).toBe(true);
    expect(csv).toContain('"Renta, ""cuota"" 1"');
    expect(csv).toContain(',Sí,');
  });
});
