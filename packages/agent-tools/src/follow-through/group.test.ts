import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
  batchApproveLabel,
  groupPendingApprovals,
  inputShape,
  pendingGroupKey,
  pendingGroupTitle,
} from './group';

const mail = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  toolId: 'gmail.send_message',
  kind: 'collect_payment',
  createdAt,
  input: { to: [`${id}@cliente.co`], subject: `Factura ${id}`, body: 'Hola…', ...extra },
});

describe('la forma de una entrada', () => {
  it('no depende del orden de los campos', () => {
    expect(inputShape({ to: ['a@b.co'], subject: 'x', body: 'y' })).toBe(
      inputShape({ body: 'y', subject: 'x', to: ['a@b.co'] }),
    );
  });

  it('ignora la copia, el hilo y la marca de repetir, que no cambian qué se hace', () => {
    expect(
      inputShape({ to: ['a@b.co'], subject: 'x', body: 'y', cc: ['c@d.co'], threadId: 't' }),
    ).toBe(inputShape({ to: ['a@b.co'], subject: 'x', body: 'y', repeatConfirmedByUser: true }));
  });

  it('un campo vacío no cuenta; uno con otro tipo sí separa', () => {
    expect(inputShape({ a: '', b: 1 })).toBe('b:number');
    expect(inputShape({ a: 'x' })).not.toBe(inputShape({ a: ['x'] }));
  });

  it('la llave junta herramienta, clase y forma', () => {
    const a = mail('a', '2026-10-01T10:00:00Z');
    expect(pendingGroupKey(a)).toBe(
      'gmail.send_message|collect_payment|body:string,subject:string,to:list',
    );
    expect(pendingGroupKey({ ...a, kind: 'remind_owner' })).not.toBe(pendingGroupKey(a));
  });
});

describe('agrupar lo que espera permiso', () => {
  it('seis cobros parecidos son un grupo; un correo distinto queda suelto', () => {
    const items = [
      ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id, i) =>
        mail(id, `2026-10-0${i + 1}T10:00:00Z`),
      ),
      {
        id: 'w1',
        toolId: 'trackers.upsert_row',
        input: { tracker: 'x', values: {} },
        createdAt: '2026-10-01T09:00:00Z',
      },
    ];
    const out = groupPendingApprovals(items);
    expect(out.groups).toHaveLength(1);
    const g = out.groups[0];
    expect(g?.items.map((i) => i.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(g?.batchable).toHaveLength(6);
    expect(g?.oldestAt).toBe('2026-10-01T10:00:00Z');
    expect(out.singles.map((s) => s.id)).toEqual(['w1']);
    expect(g && pendingGroupTitle(g)).toBe('6 cobros de cartera');
    expect(g && batchApproveLabel(g)).toBe('Aprobar los 6');
  });

  it('lo que repite algo ya hecho se queda en el grupo pero fuera del lote', () => {
    const out = groupPendingApprovals([
      mail('a', '2026-10-01T10:00:00Z'),
      { ...mail('b', '2026-10-01T11:00:00Z'), repeat: true },
      mail('c', '2026-10-01T12:00:00Z'),
    ]);
    const g = out.groups[0];
    expect(g?.items).toHaveLength(3);
    expect(g?.batchable.map((i) => i.id)).toEqual(['a', 'c']);
    expect(g?.heldBack.map((i) => i.id)).toEqual(['b']);
  });

  it('un «grupo» donde sólo uno se puede aprobar no es grupo', () => {
    const out = groupPendingApprovals([
      mail('a', '2026-10-01T10:00:00Z'),
      { ...mail('b', '2026-10-01T11:00:00Z'), repeat: true },
    ]);
    expect(out.groups).toEqual([]);
    expect(out.singles.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('el lote tiene techo; lo que no cupo se revisa en su tarjeta', () => {
    const many = Array.from({ length: MAX_BATCH + 3 }, (_, i) =>
      mail(`m${String(i).padStart(2, '0')}`, `2026-10-01T10:${String(i).padStart(2, '0')}:00Z`),
    );
    const g = groupPendingApprovals(many).groups[0];
    expect(g?.batchable).toHaveLength(MAX_BATCH);
    expect(g?.heldBack).toHaveLength(3);
  });

  it('los grupos más grandes primero; a igual tamaño, el que lleva más esperando', () => {
    const out = groupPendingApprovals([
      { ...mail('r1', '2026-10-03T10:00:00Z'), kind: 'remind_owner' },
      { ...mail('r2', '2026-10-03T11:00:00Z'), kind: 'remind_owner' },
      mail('c1', '2026-10-01T10:00:00Z'),
      mail('c2', '2026-10-02T10:00:00Z'),
      mail('c3', '2026-10-02T11:00:00Z'),
    ]);
    expect(out.groups.map((g) => g.kind)).toEqual(['collect_payment', 'remind_owner']);
    expect(out.groups[1] && batchApproveLabel(out.groups[1])).toBe('Aprobar los 2');
  });

  it('una herramienta sin nombre propio cae a «acciones parecidas», en femenino', () => {
    const g = groupPendingApprovals([
      {
        id: 'x',
        toolId: 'hubspot.update_deal',
        input: { id: '1', stage: 'won' },
        createdAt: '2026-10-01T10:00:00Z',
      },
      {
        id: 'y',
        toolId: 'hubspot.update_deal',
        input: { id: '2', stage: 'won' },
        createdAt: '2026-10-01T10:00:00Z',
      },
    ]).groups[0];
    expect(g && pendingGroupTitle(g)).toBe('2 acciones parecidas');
    expect(g && batchApproveLabel(g)).toBe('Aprobar las 2');
  });
});
