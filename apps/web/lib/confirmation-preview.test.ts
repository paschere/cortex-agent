import { describe, expect, it } from 'vitest';
import { confirmationReason } from './confirmation-notes';
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
    expect(p?.rows.map((r) => r.label)).toEqual(['Título']);
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

describe('trackers.define', () => {
  const field = (key: string, type = 'text', extra: object = {}) => ({
    key,
    label: key.toUpperCase(),
    type,
    required: false,
    ...extra,
  });
  const fields = Array.from({ length: 14 }, (_, i) => field(`campo_${i}`));
  const input = { slug: 'atenciones', name: 'Atenciones', description: '', fields };

  it('una tabla nueva lista los campos, sin «[object Object]», y el slug va en pequeño', () => {
    const p = buildPreview('trackers.define', input, { trackerExists: false });
    expect(JSON.stringify(p)).not.toContain('object Object');
    expect(p?.rows.map((r) => r.label)).toEqual(['Nombre', 'Campos']);
    expect(p?.rows[0]?.secondary).toBe('Identificador: atenciones');
    expect(p?.rows[1]?.items).toHaveLength(14);
    expect(p?.rows[1]?.items?.[0]).toBe('CAMPO_0 · Texto');
  });

  it('una tabla que existe enseña sólo la diferencia de campos', () => {
    const before = {
      name: 'Atenciones',
      description: '',
      fields: [
        field('a'),
        field('b', 'number'),
        field('c'),
        field('d', 'select', { options: ['x'] }),
      ],
    };
    const next = {
      slug: 'atenciones',
      name: 'Atenciones',
      description: '',
      fields: [
        field('a'),
        field('b', 'money', { required: true }),
        field('d', 'select', { options: ['x'] }),
        field('e', 'date'),
      ],
    };
    const p = buildPreview('trackers.define', next, { trackerExists: true, trackerBefore: before });
    const by = Object.fromEntries((p?.rows ?? []).map((r) => [r.key, r]));
    expect(p?.kind).toBe('diff');
    expect(by.added?.items).toEqual(['E · Fecha']);
    expect(by.removed?.items).toEqual(['C · Texto']);
    expect(by.changed?.items).toEqual(['B · tipo: Número → Dinero; obligatorio: no → sí']);
    expect(by.same?.after).toBe('2 campos');
    expect(by.same?.changed).toBe(false);
  });

  it('un campo con los valores por omisión explícitos no cuenta como cambio', () => {
    const before = { fields: [{ key: 'a', label: 'A', type: 'text', required: false }] };
    const p = buildPreview(
      'trackers.define',
      { slug: 's', name: 'S', fields: [{ key: 'a', label: 'A', type: 'text' }] },
      { trackerExists: true, trackerBefore: before },
    );
    expect(p?.rows.map((r) => r.key)).toEqual(['same']);
  });

  it('el título dice crear o cambiar según exista', () => {
    expect(headlineFor('trackers.define', input)).toBe('Crear o cambiar la tabla «Atenciones»');
    expect(headlineFor('trackers.define', input, { trackerExists: true })).toBe(
      'Cambiar la tabla «Atenciones»',
    );
    expect(headlineFor('trackers.define', input, { trackerExists: false })).toBe(
      'Crear la tabla «Atenciones»',
    );
  });

  it('una herramienta cualquiera con arreglos de objetos nunca da «[object Object]»', () => {
    const p = buildPreview('apps.apply_draft', {
      name: 'Bodega',
      slug: 'bodega',
      screens: [{ title: 'Inicio' }, { title: 'Recibo' }],
      roles: [{ name: 'Operario', permissions: { read: true } }],
      portal: { enabled: true, tabs: [{ name: 'a' }] },
    });
    expect(JSON.stringify(p)).not.toContain('object Object');
    expect(p?.rows.map((r) => r.label)).toEqual(['Nombre', 'Pantallas', 'Roles', 'Portal']);
    expect(p?.rows[0]?.secondary).toBe('Identificador: bodega');
  });
});

describe('confirmationReason', () => {
  it('lo interno de Cortex no se describe como sistema externo', () => {
    for (const id of [
      'trackers.define',
      'trackers.set_flow',
      'apps.apply_draft',
      'apps.update',
      'views.create',
      'views.update',
      'trackers.remove',
      'apps.publish',
    ])
      expect(confirmationReason(id)).not.toMatch(/externo|fuera de esta conversación/);
  });
  it('lo que sí sale de la empresa conserva su aviso', () => {
    expect(confirmationReason('xyz.send')).toMatch(/sistema externo/);
    expect(confirmationReason('gmail.send_message')).toMatch(/Gmail/);
  });
});
