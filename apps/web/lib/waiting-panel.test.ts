import { describe, expect, it } from 'vitest';
import { panelForWaiting } from './waiting-panel';
import { noticeFromCounts } from './waiting-shape';

/**
 * Que el aviso de la cabecera abra el panel que corresponde, y que la única
 * cola sin panel no acabe abriendo el de otra.
 */
describe('panelForWaiting', () => {
  it('sin nada esperando, no hay panel que abrir', () => {
    const notice = noticeFromCounts({ approvals: 0, commitments: 0, actions: 0, errands: 0 });
    expect(panelForWaiting(notice.queues)).toBeNull();
  });

  it('manda la primera cola con panel en el orden de reloj del producto', () => {
    const notice = noticeFromCounts({ approvals: 2, commitments: 5, actions: 0, errands: 1 });
    expect(panelForWaiting(notice.queues)).toBe('approvals');
  });

  it('salta las colas vacías', () => {
    const notice = noticeFromCounts({ approvals: 0, commitments: 0, actions: 0, errands: 3 });
    expect(panelForWaiting(notice.queues)).toBe('errands');
  });

  it('sólo correos redactados: ninguna de las cinco pantallas con panel', () => {
    // `/actions` no tiene panel a propósito — ver panels/shape.ts. El aviso
    // pregunta en vez de abrir, que es lo honesto.
    const notice = noticeFromCounts({ approvals: 0, commitments: 0, actions: 4, errands: 0 });
    expect(notice.total).toBe(4);
    expect(panelForWaiting(notice.queues)).toBeNull();
  });
});
