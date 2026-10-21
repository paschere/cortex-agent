import { describe, expect, it } from 'vitest';
import {
  type TrackerOrigin,
  agoLabel,
  creatingOrigin,
  fieldLockedMessage,
  freshnessText,
  lockedFieldKeys,
  mergeOrigin,
  originName,
  originOfField,
  ownFieldKeys,
  parseOrigins,
  refreshWaitSeconds,
  rowCreateBlockedMessage,
} from './origin';
import { assertDefineAllowed, assertRowWriteAllowed } from './origin-guard';
import type { TrackerField } from './schema';

const f = (key: string, type: TrackerField['type'] = 'text', extra: object = {}): TrackerField =>
  ({ key, label: key.toUpperCase(), type, required: false, ...extra }) as TrackerField;

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'conn-1',
  fields: ['numero', 'total'],
  creates: true,
};
const tracker = {
  origins: [siigo],
  fields: [f('numero'), f('total', 'money'), f('responsable'), f('notas', 'longtext')],
};

describe('origen de una tabla (0237)', () => {
  it('lee origins con tolerancia: lo inválido se ignora, nunca lanza', () => {
    expect(parseOrigins(null)).toEqual([]);
    expect(parseOrigins('x')).toEqual([]);
    expect(parseOrigins([{ kind: 'otro' }, siigo])).toEqual([siigo]);
  });

  it('separa campos del origen de campos propios', () => {
    expect([...lockedFieldKeys(tracker)].sort()).toEqual(['numero', 'total']);
    expect(ownFieldKeys(tracker)).toEqual(['responsable', 'notas']);
    expect(originOfField(tracker, 'total')?.ref).toBe('conn-1');
    expect(originOfField(tracker, 'notas')).toBeNull();
    expect(lockedFieldKeys({})).toEqual(new Set());
  });

  it('el mensaje de Siigo nombra la bandeja; el de otros programas no', () => {
    expect(fieldLockedMessage(siigo, ['Total'])).toBe(
      '«Total» viene de Siigo: cámbialo en Siigo o con la bandeja «Por enviar a Siigo».',
    );
    expect(fieldLockedMessage(siigo)).toContain('Este dato viene de Siigo');
    const alegra = { ...siigo, provider: 'alegra', label: 'Alegra' };
    expect(fieldLockedMessage(alegra, ['A', 'B'])).toBe(
      '«A», «B» vienen de Alegra: cámbialo en Alegra.',
    );
    const sheet: TrackerOrigin = {
      ...siigo,
      kind: 'sheet',
      provider: undefined,
      label: 'la hoja «Vuelos»',
    };
    expect(fieldLockedMessage(sheet)).toContain('cámbialo en la hoja «Vuelos»');
    expect(rowCreateBlockedMessage(siigo)).toContain('Por enviar a Siigo');
  });

  it('une orígenes sin duplicar y conserva writeBack', () => {
    const sheet: TrackerOrigin = {
      kind: 'sheet',
      label: 'h',
      ref: 's1',
      fields: ['a'],
      creates: true,
      writeBack: true,
    };
    const again = mergeOrigin([sheet], { ...sheet, fields: ['a', 'b'], writeBack: undefined });
    expect(again).toHaveLength(1);
    expect(again[0]?.fields).toEqual(['a', 'b']);
    expect(again[0]?.writeBack).toBe(true);
    expect(mergeOrigin([sheet], siigo)).toHaveLength(2);
  });

  it('sólo un programa contable prohíbe filas a mano; hojas y carpetas no', () => {
    const sheet: TrackerOrigin = { ...siigo, kind: 'sheet', provider: undefined, label: 'h' };
    const drive: TrackerOrigin = { ...siigo, kind: 'drive_folder', provider: undefined, label: 'c' };
    expect(creatingOrigin({ origins: [sheet, drive] })).toBeNull();
    expect(creatingOrigin({ origins: [sheet, siigo] })?.ref).toBe('conn-1');
  });
});

describe('rechazo de escritura por origen', () => {
  it('rechaza cambiar un campo del origen, con el mensaje en español', () => {
    expect(() =>
      assertRowWriteAllowed(tracker, {
        before: { numero: 'FV-1', total: 100 },
        after: { numero: 'FV-1', total: 999 },
      }),
    ).toThrow('«TOTAL» viene de Siigo');
  });

  it('deja pasar los campos propios y lo que no cambió (la grilla manda la fila entera)', () => {
    expect(() =>
      assertRowWriteAllowed(tracker, {
        before: { numero: 'FV-1', total: 100, responsable: '' },
        after: { numero: 'FV-1', total: '100', responsable: 'Ana', notas: 'llamar' },
      }),
    ).not.toThrow();
  });

  it('un parche sólo juzga las claves que toca', () => {
    expect(() =>
      assertRowWriteAllowed(tracker, {
        before: { total: 1 },
        after: { total: 2, responsable: 'x' },
        keys: ['responsable'],
      }),
    ).not.toThrow();
  });

  it('no deja agregar filas a mano a una tabla que se llena sola', () => {
    expect(() => assertRowWriteAllowed(tracker, { creating: true, after: {} })).toThrow(
      'Esta tabla se llena sola desde Siigo',
    );
  });

  it('en un programa contable una fila a mano se rechaza aunque sólo traiga campos propios', () => {
    expect(() =>
      assertRowWriteAllowed(tracker, { creating: true, after: { responsable: 'Ana' } }),
    ).toThrow('Esta tabla se llena sola desde Siigo');
  });

  it('en un programa contable el campo del origen se cierra aunque la fila no tenga clave', () => {
    expect(() =>
      assertRowWriteAllowed(tracker, { before: { total: 1 }, after: { total: 2 }, externalKey: null }),
    ).toThrow('viene de Siigo');
  });

  it('hojas y carpetas: las filas a mano se crean y editan libres; las del origen, no', () => {
    for (const kind of ['sheet', 'drive_folder'] as const) {
      const t = {
        fields: [f('a'), f('b')],
        origins: [{ kind, label: 'X', ref: 's', fields: ['a'], creates: true }],
      };
      expect(() =>
        assertRowWriteAllowed(t, { creating: true, after: { a: '1', b: 'x' } }),
      ).not.toThrow();
      expect(() =>
        assertRowWriteAllowed(t, { before: { a: '1' }, after: { a: '2' }, externalKey: null }),
      ).not.toThrow();
      expect(() =>
        assertRowWriteAllowed(t, { before: { a: '1' }, after: { a: '2' }, externalKey: 'K1' }),
      ).toThrow('viene de');
      // Sin saber de dónde es la fila, se supone que es del origen.
      expect(() => assertRowWriteAllowed(t, { before: { a: '1' }, after: { a: '2' } })).toThrow(
        'viene de',
      );
      // Los campos propios de una fila del origen siguen libres.
      expect(() =>
        assertRowWriteAllowed(t, { before: { b: '1' }, after: { b: '2' }, externalKey: 'K1' }),
      ).not.toThrow();
    }
  });

  it('una tabla propia no se toca', () => {
    expect(() =>
      assertRowWriteAllowed(
        { origins: [], fields: [f('a')] },
        { creating: true, after: { a: 'x' } },
      ),
    ).not.toThrow();
    expect(() => assertRowWriteAllowed(null, { creating: true, after: {} })).not.toThrow();
  });
});

describe('trackers.define sobre una tabla sincronizada', () => {
  it('agregar un campo propio pasa; los del origen siguen igual', () => {
    expect(() =>
      assertDefineAllowed(tracker, [
        ...tracker.fields,
        f('estado_cobro', 'select', { options: ['a'] }),
      ]),
    ).not.toThrow();
  });

  it('cambiar la etiqueta de un campo del origen pasa', () => {
    const next = tracker.fields.map((x) => (x.key === 'total' ? { ...x, label: 'Valor' } : x));
    expect(() => assertDefineAllowed(tracker, next)).not.toThrow();
  });

  it('cambiar el tipo de un campo del origen se rechaza', () => {
    const next = tracker.fields.map((x) =>
      x.key === 'total' ? { ...x, type: 'text' as const } : x,
    );
    expect(() => assertDefineAllowed(tracker, next)).toThrow('viene de Siigo');
  });

  it('quitar un campo del origen se rechaza; quitar uno propio pasa', () => {
    expect(() =>
      assertDefineAllowed(
        tracker,
        tracker.fields.filter((x) => x.key !== 'numero'),
      ),
    ).toThrow('no se puede quitar');
    expect(() =>
      assertDefineAllowed(
        tracker,
        tracker.fields.filter((x) => x.key !== 'notas'),
      ),
    ).not.toThrow();
  });

  it('en una hoja o carpeta la definición se cambia como en cualquier tabla', () => {
    const sheet = {
      fields: tracker.fields,
      origins: [{ ...siigo, kind: 'sheet' as const, provider: undefined, label: 'la hoja' }],
    };
    const next = tracker.fields.map((x) =>
      x.key === 'total' ? { ...x, type: 'text' as const } : x,
    );
    expect(() => assertDefineAllowed(sheet, next)).not.toThrow();
  });

  it('una tabla propia se define como siempre', () => {
    expect(() => assertDefineAllowed({ fields: [f('a')] }, [f('b')])).not.toThrow();
  });
});

describe('frescura', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();

  it('«hace N min / h / días»', () => {
    expect(agoLabel(ago(0), now)).toBe('hace un momento');
    expect(agoLabel(ago(3), now)).toBe('hace 3 min');
    expect(agoLabel(ago(180), now)).toBe('hace 3 h');
    expect(agoLabel(ago(60 * 24), now)).toBe('hace 1 día');
    expect(agoLabel(ago(60 * 48), now)).toBe('hace 2 días');
    expect(agoLabel(null, now)).toBe('sin leer todavía');
  });

  it('la frase de cada bloque', () => {
    expect(originName(siigo)).toBe('Siigo');
    expect(freshnessText('Siigo', { lastSyncAt: ago(3), state: 'ok' }, now)).toBe(
      'Viene de Siigo · actualizado hace 3 min',
    );
    expect(freshnessText('Siigo', { lastSyncAt: ago(3), state: 'ok', running: true }, now)).toBe(
      'Viene de Siigo · actualizando…',
    );
    expect(freshnessText('Siigo', { lastSyncAt: ago(90), state: 'error' }, now)).toBe(
      'Viene de Siigo · no se pudo actualizar (última vez hace 1 h)',
    );
    expect(freshnessText('la hoja «Vuelos»', null, now)).toBe(
      'Viene de la hoja «Vuelos» · sin leer todavía',
    );
  });

  it('el tope de frecuencia: un minuto entre pedidos', () => {
    expect(refreshWaitSeconds(null, now)).toBe(0);
    expect(refreshWaitSeconds(ago(0.5), now)).toBe(30);
    expect(refreshWaitSeconds(ago(2), now)).toBe(0);
  });
});
