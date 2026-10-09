import { describe, expect, it } from 'vitest';
import { type IngestionCounts, describeProgress, stillLoading } from './progress';

const zero: IngestionCounts = {
  documentsReady: 0,
  documentsPending: 0,
  documentsFailed: 0,
  invoices: 0,
  payables: 0,
  sheets: 0,
  mailThreads: 0,
  mailRunning: false,
  accountingSyncing: false,
  accountingConnected: false,
  whatsappConnected: false,
  googleConnected: false,
};

describe('describeProgress', () => {
  it('sin nada conectado: vacío', () => {
    const p = describeProgress(zero);
    expect(p.empty).toBe(true);
    expect(p.loading).toBe(false);
    expect(stillLoading(zero)).toEqual(['Aún no hay fuentes conectadas.']);
  });

  it('la frase de ejemplo: leí N de ~M documentos · facturas · hojas', () => {
    const p = describeProgress({
      ...zero,
      googleConnected: true,
      documentsReady: 120,
      documentsPending: 680,
      invoices: 34,
      sheets: 2,
    });
    expect(p.lines).toEqual(['Leí 120 de ~800 documentos', '34 facturas de venta', '2 hojas']);
    expect(p.loading).toBe(true);
  });

  it('singular y sin pendientes', () => {
    const p = describeProgress({ ...zero, documentsReady: 1, invoices: 1, googleConnected: true });
    expect(p.lines).toEqual(['Leí 1 documento', '1 factura de venta']);
    expect(p.loading).toBe(false);
  });

  it('una sincronización contable en curso sigue "cargando" aunque no haya filas', () => {
    const p = describeProgress({ ...zero, accountingConnected: true, accountingSyncing: true });
    expect(p.loading).toBe(true);
    expect(p.empty).toBe(false);
    expect(stillLoading({ ...zero, accountingConnected: true, accountingSyncing: true })).toContain(
      'Tu programa contable sigue trayendo facturas.',
    );
  });
});
