import { describe, expect, it } from 'vitest';
import { runMatch } from './match-shape';
import { evaluateFormula } from './formula';
import {
  parseSocrataTrm,
  setAmbientTrm,
  trmListRows,
  trmOn,
  trmWarning,
  usesTrm,
} from './trm';

// Datos reales de datos.gov.co (32sa-8pi3), octubre de 2026.
const RAW = [
  { valor: '3158.43', unidad: 'COP', vigenciadesde: '2026-10-24T00:00:00.000', vigenciahasta: '2026-10-26T00:00:00.000' },
  { valor: '3157.94', unidad: 'COP', vigenciadesde: '2026-10-27T00:00:00.000', vigenciahasta: '2026-10-27T00:00:00.000' },
  { valor: '3148.02', unidad: 'COP', vigenciadesde: '2026-10-28T00:00:00.000', vigenciahasta: '2026-10-28T00:00:00.000' },
  { valor: '3100', unidad: 'COP', vigenciadesde: '2026-10-20T00:00:00.000', vigenciahasta: '2026-10-21T00:00:00.000' },
  { valor: 'abc', vigenciadesde: '2026-10-01', vigenciahasta: '2026-10-01' },
];
const table = parseSocrataTrm(RAW);

describe('parseSocrataTrm', () => {
  it('lee, ordena y descarta lo ilegible', () => {
    expect(table.map((r) => r.from)).toEqual(['2026-10-20', '2026-10-24', '2026-10-27', '2026-10-28']);
    expect(table[1]).toEqual({ from: '2026-10-24', to: '2026-10-26', value: 3158.43 });
  });
  it('no revienta con basura', () => {
    expect(parseSocrataTrm(null)).toEqual([]);
    expect(parseSocrataTrm([{}])).toEqual([]);
  });
});

describe('trmOn', () => {
  it('un día hábil usa su propia vigencia', () => {
    expect(trmOn(table, '2026-10-27')).toMatchObject({ ok: true, value: 3157.94 });
  });
  it('sábado, domingo y lunes festivo usan la vigencia del viernes', () => {
    for (const d of ['2026-10-24', '2026-10-25', '2026-10-26'])
      expect(trmOn(table, d)).toMatchObject({ ok: true, value: 3158.43, from: '2026-10-24' });
  });
  it('acepta fechas con hora', () => {
    expect(trmOn(table, '2026-10-28T09:30:00')).toMatchObject({ ok: true, value: 3148.02 });
  });
  it('una fecha sin dato avisa por qué', () => {
    const gap = trmOn(table, '2026-10-22');
    expect(gap).toEqual({ ok: false, reason: 'gap' });
    expect(trmWarning(gap, '2026-10-22')).toContain('No hay TRM oficial para el 2026-10-22');
    const future = trmOn(table, '2026-11-30');
    expect(future).toEqual({ ok: false, reason: 'not_published' });
    expect(trmWarning(future, '2026-11-30')).toContain('aún no se publica');
    expect(trmOn(table, '2026-01-01')).toEqual({ ok: false, reason: 'before_history' });
    expect(trmOn([], '2026-10-27')).toEqual({ ok: false, reason: 'empty' });
    expect(trmOn(table, 'no es fecha')).toEqual({ ok: false, reason: 'invalid_date' });
    expect(trmOn(table, '2026-02-31')).toEqual({ ok: false, reason: 'invalid_date' });
  });
});

describe('trm() en fórmulas', () => {
  const ctx = (vals: Record<string, string>) => ({
    today: '2026-10-27',
    now: '09:00',
    trm: table,
    get: (n: string) => vals[n] ?? undefined,
  });
  it('con fecha', () => {
    const r = evaluateFormula('trm([traslado])', {
      ...ctx({}),
      get: (n) => (n === 'traslado' ? { k: 'date', ms: Date.UTC(2026, 9, 25), time: false } : undefined),
    });
    expect(r.value).toBe(3158.43);
  });
  it('sin fecha usa hoy', () => {
    expect(evaluateFormula('trm()', ctx({})).value).toBe(3157.94);
  });
  it('fecha sin dato: vacío con aviso', () => {
    const r = evaluateFormula('trm(fecha(2026; 10; 22))', ctx({}));
    expect(r.value).toBeNull();
    expect(r.warnings.join(' ')).toContain('2026-10-22');
  });
  it('usa la tabla ambiente si el contexto no trae', () => {
    setAmbientTrm(table);
    expect(evaluateFormula('trm()', { today: '2026-10-28', now: '10:00', get: () => undefined }).value).toBe(3148.02);
    setAmbientTrm([]);
  });
  it('detecta tablas que la usan', () => {
    expect(usesTrm([{ formula: '[usd] × trm([fecha])' }])).toBe(true);
    expect(usesTrm([{ formula: '[a] + [b]' }, {}])).toBe(false);
  });
});

describe('cortex.trm en «buscar en lista» (por fecha)', () => {
  const rows = trmListRows(table, '2026-10-28');
  const config = {
    from: 'fecha_traslado',
    source: 'cortex.trm',
    key: 'vigencia_desde',
    fills: { trm: 'valor' },
  };
  const t = { key: 'vigencia_desde', rows, range: { from: 'vigencia_desde', to: 'vigencia_hasta' } };
  it('el domingo trae la TRM del viernes', () => {
    const out = runMatch(config, t, { fecha_traslado: '2026-10-25' });
    expect(out.hit).toBe(true);
    expect(out.suggestions.trm?.value).toBe('3158.43');
  });
  it('una fecha sin vigencia no sugiere nada', () => {
    expect(runMatch(config, t, { fecha_traslado: '2026-10-22' }).hit).toBe(false);
    expect(runMatch(config, t, { fecha_traslado: '' }).hit).toBe(false);
  });
});
