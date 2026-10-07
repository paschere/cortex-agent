import type { TrackerField } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { spokenNumbers } from './spoken-number';
import {
  type VoiceDef,
  type VoiceOutcome,
  type VoiceState,
  answer,
  applyServerTurn,
  findField,
  parseCommand,
  parseSpokenDate,
  parseSpokenTime,
  startVoice,
} from './voice-form';

const ctx = { today: '2026-10-07', now: '14:30' }; // miércoles

const f = (x: Partial<TrackerField> & { key: string; type: TrackerField['type'] }): TrackerField =>
  ({ label: x.key, required: false, ...x }) as TrackerField;

const def: VoiceDef = {
  fields: [
    f({ key: 'guia', label: 'Guía', type: 'text', required: true, format: 'awb' }),
    f({ key: 'vuelo', label: 'Vuelo', type: 'text', required: true }),
    f({ key: 'piezas', label: 'Piezas', type: 'number', required: true, min: 1, max: 500 }),
    f({
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: true,
      options: ['Conforme', 'Con novedad'],
    }),
    f({
      key: 'novedad',
      label: 'Descripción de la novedad',
      type: 'longtext',
      required: true,
      showIf: { field: 'estado', equals: 'Con novedad' },
    }),
    f({ key: 'foto', label: 'Foto', type: 'file', required: false }),
    f({ key: 'llego', label: 'Fecha de llegada', type: 'date', required: true, max: 'today' }),
    f({ key: 'urgente', label: 'Urgente', type: 'checkbox' }),
  ],
};

function run(texts: string[]): { out: VoiceOutcome; says: string[] } {
  let out = startVoice(def, {}, ctx);
  const says = [out.say];
  for (const t of texts) {
    out = answer(def, out.state, t, ctx);
    says.push(out.say);
  }
  return { out, says };
}

describe('conversación', () => {
  it('pregunta en el orden del formulario y salta lo que no aplica (showIf)', () => {
    const { out, says } = run(['72912345675', 'AV204', 'cuatro', 'conforme']);
    expect(says[0]).toContain('Guía');
    expect(says[1]).toContain('Vuelo');
    expect(says[2]).toContain('Piezas');
    // «Descripción de la novedad» no aplica con «Conforme»; la foto se dice y se salta.
    expect(out.say).toContain('«Foto» hay que llenarlo en la pantalla');
    expect(out.say).toContain('Fecha de llegada');
    expect(out.state.values.piezas).toBe('4');
    expect(out.state.current).toBe('llego');
  });

  it('pregunta lo condicional cuando aplica', () => {
    const { out } = run(['72912345675', 'AV204', '3', 'con novedad']);
    expect(out.state.current).toBe('novedad');
    expect(out.say).toContain('Descripción de la novedad');
  });

  it('re-pide lo inválido con el mensaje del campo', () => {
    const { out } = run(['72912345675', 'AV204', '900']);
    expect(out.say).toContain('no puede ser mayor que 500');
    expect(out.state.current).toBe('piezas');
    expect(out.state.values.piezas).toBeUndefined();
  });

  it('una fecha futura se rechaza y se vuelve a pedir', () => {
    const { out } = run(['72912345675', 'AV204', '2', 'conforme', 'mañana']);
    expect(out.say).toMatch(/futura/);
    expect(out.state.current).toBe('llego');
  });

  it('lee el resumen y envía con «sí»', () => {
    const { out } = run(['72912345675', 'AV204', '2', 'conforme', 'hoy', 'no']);
    expect(out.state.phase).toBe('confirming');
    expect(out.say).toContain('Voy a enviar');
    expect(out.say).toContain('Piezas: 2');
    expect(out.say).toContain('¿Lo envío?');
    const sent = answer(def, out.state, 'sí', ctx);
    expect(sent.effect).toEqual({ type: 'submit' });
    expect(sent.state.phase).toBe('done');
  });

  it('«no» en el resumen pregunta qué corregir y vuelve al resumen', () => {
    const { out } = run(['72912345675', 'AV204', '2', 'conforme', 'hoy', 'no']);
    const no = answer(def, out.state, 'no', ctx);
    expect(no.say).toContain('Qué campo corrijo');
    const fix = answer(def, no.state, 'las piezas', ctx);
    expect(fix.state.current).toBe('piezas');
    const again = answer(def, fix.state, 'cinco', ctx);
    expect(again.state.phase).toBe('confirming');
    expect(again.state.values.piezas).toBe('5');
  });

  it('cancela sin enviar', () => {
    const { out } = run(['cancela']);
    expect(out.effect).toEqual({ type: 'cancel' });
  });
});

describe('comandos', () => {
  it('repite, salta, atrás y lee lo que llevo', () => {
    let o = startVoice(def, {}, ctx);
    o = answer(def, o.state, 'repite', ctx);
    expect(o.say).toContain('Guía');
    o = answer(def, o.state, 'salta', ctx);
    expect(o.say).toContain('obligatorio');
    o = answer(def, o.state, '72912345675', ctx);
    o = answer(def, o.state, 'AV204', ctx);
    o = answer(def, o.state, 'atrás', ctx);
    expect(o.state.current).toBe('vuelo');
    o = answer(def, o.state, 'atrás', ctx);
    expect(o.state.current).toBe('guia');
    o = answer(def, o.state, 'lee lo que llevo', ctx);
    expect(o.say).toContain('Guía');
  });

  it('un campo opcional se salta', () => {
    const { out } = run(['72912345675', 'AV204', '1', 'conforme', 'hoy', 'salta']);
    expect(out.state.phase).toBe('confirming');
    expect(out.state.values.urgente).toBeUndefined();
  });

  it('corrige <campo> desde cualquier punto', () => {
    const { out } = run(['72912345675', 'AV204', 'corrige el vuelo']);
    expect(out.state.current).toBe('vuelo');
  });

  it('parseCommand sólo toma frases cortas completas', () => {
    expect(parseCommand('Salta, por favor')?.command).toBe('skip');
    expect(parseCommand('la nota dice salta la cuerda')).toBeNull();
    expect(parseCommand('corrige piezas')).toEqual({ command: 'correct', target: 'piezas' });
  });

  it('findField por parecido', () => {
    expect(findField(def, 'la guia')?.key).toBe('guia');
    expect(findField(def, 'la fecha')?.key).toBe('llego');
  });
});

describe('interpretación determinista', () => {
  it('fechas relativas (hoy es miércoles 2026-10-07)', () => {
    expect(parseSpokenDate('hoy', ctx)).toBe('2026-10-07');
    expect(parseSpokenDate('ayer', ctx)).toBe('2026-10-06');
    expect(parseSpokenDate('antier', ctx)).toBe('2026-10-05');
    expect(parseSpokenDate('mañana', ctx)).toBe('2026-10-08');
    expect(parseSpokenDate('el lunes', ctx)).toBe('2026-10-05');
    expect(parseSpokenDate('el lunes', ctx, { min: 'today' })).toBe('2026-10-12');
    expect(parseSpokenDate('el próximo viernes', ctx)).toBe('2026-10-09');
    expect(parseSpokenDate('hace tres días', ctx)).toBe('2026-10-04');
    expect(parseSpokenDate('5 de marzo', ctx)).toBe('2026-03-05');
    expect(parseSpokenDate('el quince de enero de 2025', ctx)).toBe('2025-01-15');
    expect(parseSpokenDate('15/03/2026', ctx)).toBe('2026-03-15');
    expect(parseSpokenDate('qué sé yo', ctx)).toBeNull();
  });

  it('horas', () => {
    expect(parseSpokenTime('a las tres de la tarde', ctx)).toBe('15:00');
    expect(parseSpokenTime('ocho y media de la mañana', ctx)).toBe('08:30');
    expect(parseSpokenTime('15:45', ctx)).toBe('15:45');
    expect(parseSpokenTime('mediodía', ctx)).toBe('12:00');
  });

  it('números hablados', () => {
    expect(spokenNumbers('cuatro piezas')).toEqual([4]);
    expect(spokenNumbers('treinta y dos')).toEqual([32]);
    expect(spokenNumbers('dos mil quinientos')).toEqual([2500]);
    expect(spokenNumbers('un millón doscientos mil')).toEqual([1_200_000]);
    expect(spokenNumbers('tres punto cinco')).toEqual([3.5]);
    expect(spokenNumbers('1.200.000 pesos')).toEqual([1_200_000]);
    expect(spokenNumbers('4 y 7')).toEqual([4, 7]);
  });

  it('select por similitud, por orden y ambiguo', () => {
    const base = startVoice(def, { guia: '72912345675', vuelo: 'X', piezas: '1' }, ctx).state;
    const sel = (t: string) => answer(def, base, t, ctx);
    expect(sel('con novedad').state.values.estado).toBe('Con novedad');
    expect(sel('hay novedad pues').state.values.estado).toBe('Con novedad');
    expect(sel('la segunda').state.values.estado).toBe('Con novedad');
    expect(sel('conformes').state.values.estado).toBe('Conforme');
    expect(sel('banana').server).toBe(true);
  });

  it('una frase con varios datos va al servidor', () => {
    const o = startVoice(def, {}, ctx);
    const r = answer(def, o.state, 'guía 729 12345675, vuelo AV204, 4 piezas', ctx);
    expect(r.server).toBe(true);
  });

  it('un número con más de un número va al servidor', () => {
    const base = startVoice(def, { guia: '72912345675', vuelo: 'X' }, ctx).state;
    expect(answer(def, base, 'cuatro o cinco', ctx).server).toBe(true);
  });
});

describe('turno del servidor', () => {
  it('aplica varios campos, valida y sigue con lo pendiente', () => {
    const o = startVoice(def, {}, ctx);
    const r = applyServerTurn(
      def,
      o.state,
      { values: { guia: '729-12345675', vuelo: 'AV204', piezas: '4' } },
      ctx,
    );
    expect(r.say).toContain('Anoté');
    expect(r.state.values.piezas).toBe('4');
    expect(r.state.current).toBe('estado');
  });

  it('un valor inválido del servidor se dice y se re-pide', () => {
    const o = startVoice(def, {}, ctx);
    const r = applyServerTurn(def, o.state, { values: { vuelo: 'AV204', piezas: '9000' } }, ctx);
    expect(r.state.current).toBe('piezas');
    expect(r.state.values.vuelo).toBe('AV204');
    expect(r.say).toContain('mayor que 500');
  });

  it('un comando que leyó el servidor se ejecuta', () => {
    const o = startVoice(def, {}, ctx);
    const r = applyServerTurn(def, o.state, { values: {}, command: 'skip' }, ctx);
    expect(r.say).toContain('obligatorio');
  });

  it('sin nada reconocido, vuelve a preguntar', () => {
    const o = startVoice(def, {}, ctx);
    const r = applyServerTurn(def, o.state, { values: {} }, ctx);
    expect(r.say).toContain('No te entendí');
    const again = applyServerTurn(def, r.state as VoiceState, { values: {} }, ctx);
    expect(again.say).toContain('pantalla');
  });
});
