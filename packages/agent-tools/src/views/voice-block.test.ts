import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView } from './compute';
import { type CatalogTracker, checkSpecAgainst, formVoiceOf, viewSpecSchema } from './spec';

/**
 * El asistente de voz de los formularios: la opción `voice` del form y el
 * bloque `voice` que maneja un formulario de la misma vista.
 */

const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [{ key: 'guia', label: 'Guía', type: 'text', required: true }],
};
const sources = () =>
  new Map<string, ViewSource>([['guias', { tracker: guias, truncated: false, rows: [] }]]);
const NOW = new Date('2026-10-07T17:00:00Z');
const form = { id: 'f', type: 'form', tracker: 'guias', title: 'Recibo' };
const spec = (blocks: unknown[]) => viewSpecSchema.parse({ version: 1, blocks });

describe('voice en el formulario', () => {
  it('sin valor es «dictate» (lo de siempre) y acepta los tres modos', () => {
    const s = spec([form, { ...form, id: 'g', voice: 'conversation' }]);
    expect(s.blocks.map((b) => (b.type === 'form' ? formVoiceOf(b) : null))).toEqual([
      'dictate',
      'conversation',
    ]);
    expect(
      viewSpecSchema.safeParse({ version: 1, blocks: [{ ...form, voice: 'x' }] }).success,
    ).toBe(false);
  });

  it('llega calculado al bloque del formulario', () => {
    const view = computeView(spec([{ ...form, voice: 'off' }]), sources(), NOW);
    expect(view.blocks[0]).toMatchObject({ type: 'form', voice: 'off' });
  });
});

describe('bloque voice', () => {
  it('apunta a un formulario de la misma vista', () => {
    const ok = spec([form, { id: 'v', type: 'voice', form: 'f', autoStart: true }]);
    expect(checkSpecAgainst(ok, [guias])).toEqual([]);
    const bad = spec([form, { id: 'v', type: 'voice', form: 'nada' }]);
    expect(checkSpecAgainst(bad, [guias]).join(' ')).toMatch(/no es un bloque form/);
    const notForm = spec([
      { id: 't', type: 'text', markdown: 'hola' },
      { id: 'v', type: 'voice', form: 't' },
    ]);
    expect(checkSpecAgainst(notForm, [guias])).toHaveLength(1);
  });

  it('se calcula sin tabla, y avisa si su formulario ya no está', () => {
    const view = computeView(
      spec([form, { id: 'v', type: 'voice', form: 'f', title: 'Hablar' }]),
      sources(),
      NOW,
    );
    expect(view.blocks[1]).toMatchObject({
      type: 'voice',
      form: 'f',
      title: 'Hablar',
      autoStart: false,
    });
    const lost = computeView(spec([{ id: 'v', type: 'voice', form: 'f' }]), sources(), NOW);
    expect(lost.blocks[0]).toMatchObject({ type: 'problem' });
  });
});
