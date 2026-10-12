import { isControlHandoffMessage } from '@/lib/confirmation-notes';
import { describe, expect, it } from 'vitest';
import { followUpFor } from './ConfirmationGroup';

describe('followUpFor', () => {
  it('una aprobación suelta usa el relato de siempre', () => {
    const t = followUpFor([{ status: 'allowed', toolId: 'x.y', summary: 'A' }]);
    expect(t && isControlHandoffMessage(t)).toBe(true);
  });
  it('varias aprobadas se cuentan juntas, una sola continuación', () => {
    const t = followUpFor([
      { status: 'allowed', toolId: 'x.y', summary: 'A' },
      { status: 'allowed', toolId: 'x.z', summary: 'B' },
    ]);
    expect(t).toContain('2 acciones');
    expect(t && isControlHandoffMessage(t)).toBe(true);
  });
  it('un rechazo sin motivo no dice nada; con motivo lo cuenta', () => {
    expect(followUpFor([{ status: 'cancelled', toolId: 'x.y', summary: 'A' }])).toBeNull();
    expect(
      followUpFor([{ status: 'cancelled', toolId: 'x.y', summary: 'A', reason: 'no toca' }]),
    ).toContain('Motivo: no toca');
  });
});
