import { describe, expect, it } from 'vitest';
import { confirmDialog, promptDialog, settleDialog, subscribeDialogs } from './dialog-queue';
import type { DialogRequest } from './dialog-queue';

describe('cola de diálogos', () => {
  it('sin anfitrión se cancela en vez de colgarse', async () => {
    expect(await confirmDialog('¿Seguro?')).toBe(false);
    expect(await promptDialog({ title: 'Motivo', label: 'Motivo' })).toBeNull();
  });
  it('con anfitrión, la pregunta espera la respuesta y sale de la cola', async () => {
    let seen: DialogRequest[] = [];
    const off = subscribeDialogs((q) => {
      seen = q;
    });
    const answer = confirmDialog({ title: '¿Archivar?', tone: 'danger', confirmLabel: 'Archivar' });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    if (req?.kind !== 'confirm') throw new Error('esperaba una confirmación');
    expect(req).toMatchObject({ title: '¿Archivar?', tone: 'danger', cancelLabel: 'Cancelar' });
    req.resolve(true);
    settleDialog(req);
    expect(await answer).toBe(true);
    expect(seen).toHaveLength(0);
    off();
  });
  it('un texto pedido llega recortado y vacío cuenta como texto', async () => {
    let seen: DialogRequest[] = [];
    const off = subscribeDialogs((q) => {
      seen = q;
    });
    const answer = promptDialog({ title: 'Motivo', label: 'Motivo' });
    const req = seen[0];
    if (req?.kind !== 'prompt') throw new Error('esperaba un prompt');
    expect(req.maxLength).toBe(300);
    req.resolve('');
    settleDialog(req);
    expect(await answer).toBe('');
    off();
  });
});
