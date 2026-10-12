import { describe, expect, it } from 'vitest';
import { buildPreview, headlineFor } from './confirmation-preview';
import { reversibilityOf } from './reversibility';

describe('buildPreview', () => {
  const input = {
    tracker: 'clientes',
    rowId: 'r1',
    values: { estado: 'Confirmado', precio: 8, nota: 'igual' },
  };
  it('una fila que se edita muestra antes → después y marca lo que no cambia', () => {
    const p = buildPreview('trackers.upsert', input, {
      before: { estado: 'Pendiente', precio: 5, nota: 'igual' },
      fieldLabels: { estado: 'Estado' },
      trackerName: 'Clientes',
    });
    expect(p?.kind).toBe('diff');
    expect(p?.rows.map((r) => [r.label, r.before, r.after, r.changed])).toEqual([
      ['Estado', 'Pendiente', 'Confirmado', true],
      ['Precio', '5', '8', true],
      ['Nota', 'igual', 'igual', false],
    ]);
  });
  it('sin valores de antes, o sin rowId, enseña los campos', () => {
    expect(buildPreview('trackers.upsert', input)?.kind).toBe('fields');
    const created = buildPreview('trackers.upsert', { ...input, rowId: undefined });
    expect(created?.heading).toContain('nueva');
    expect(created?.rows.every((r) => r.changed && r.before === undefined)).toBe(true);
  });
  it('un correo enseña para, asunto y cuerpo tal cual saldrán', () => {
    const p = buildPreview('gmail.send_message', {
      to: 'ana@x.co',
      subject: 'Cobro',
      body: 'Hola Ana',
    });
    expect(p?.kind).toBe('email');
    expect(p?.rows.map((r) => r.label)).toEqual(['Para', 'Asunto', 'Mensaje']);
  });
  it('una herramienta cualquiera cae a sus campos planos, sin la fontanería', () => {
    const p = buildPreview('views.create', { title: 'Mi vista', repeatConfirmedByUser: true });
    expect(p?.rows.map((r) => r.label)).toEqual(['Title']);
  });
  it('sin entrada objeto no hay vista previa', () => {
    expect(buildPreview('x.y', null)).toBeNull();
  });
});

describe('reversibilityOf', () => {
  it('lo que tiene Deshacer es reversible; lo que sale de la empresa, no', () => {
    expect(reversibilityOf('trackers.upsert')).toBe('reversible');
    expect(reversibilityOf('gmail.send_message')).toBe('irreversible');
    expect(reversibilityOf('trackers.define')).toBe('unknown');
  });
});

describe('headlineFor', () => {
  it('dice la acción en español, o deja que la tarjeta use el resumen de siempre', () => {
    expect(
      headlineFor(
        'trackers.upsert',
        { tracker: 'x', rowId: 'r', values: {} },
        { trackerName: 'Clientes' },
      ),
    ).toBe('Actualizar una fila de «Clientes»');
    expect(headlineFor('gmail.send_message', { to: 'a@b.co', subject: 'Hola' })).toBe(
      'Enviar un correo a a@b.co — «Hola»',
    );
    expect(headlineFor('hubspot.update_deal', { dealstage: 'x' })).toBeNull();
  });
});
