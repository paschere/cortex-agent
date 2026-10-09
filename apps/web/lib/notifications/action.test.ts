import { describe, expect, it, vi } from 'vitest';
import { type ActionDeps, runNotificationAction } from './action';

const ITEM = '11111111-1111-4111-8111-111111111111';
const NOTIF = '22222222-2222-4222-8222-222222222222';

function deps(over: Partial<ActionDeps> = {}) {
  const decide = vi.fn<ActionDeps['decide']>(async () => ({
    ok: true,
    status: 'done',
    message: 'Hecho.',
  }));
  const markRead = vi.fn<ActionDeps['markRead']>(async () => undefined);
  const find = vi.fn<ActionDeps['find']>(async () => ({
    directoryUserId: 'dir-user-1',
    actions: [
      { kind: 'autopilot_item', itemId: ITEM, contentHash: 'abcdef123456', title: 'Reintentar' },
    ],
  }));
  return { d: { find, decide, markRead, ...over } satisfies ActionDeps, decide, markRead, find };
}

const base = {
  baUserId: 'ba-1',
  notificationId: NOTIF,
  organizationId: 'org-a',
  index: 0,
  decision: 'approve' as const,
};

describe('botones de un aviso', () => {
  it('«Hacerlo» llama al MISMO camino del piloto con la huella guardada y la persona de la membresía', async () => {
    const { d, decide, markRead } = deps();
    const out = await runNotificationAction(d, base);
    expect(out).toMatchObject({ httpStatus: 200, ok: true });
    expect(decide).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'dir-user-1',
      itemId: ITEM,
      decision: 'approve',
      contentHash: 'abcdef123456',
    });
    expect(markRead).toHaveBeenCalledOnce();
  });

  it('un aviso que no es de esta persona (o de otra empresa) da 404 y no ejecuta nada', async () => {
    const { d, decide } = deps({ find: async () => null });
    const out = await runNotificationAction(d, { ...base, organizationId: 'org-b' });
    expect(out.httpStatus).toBe(404);
    expect(decide).not.toHaveBeenCalled();
  });

  it('un botón que no existe en el aviso da 400 y no ejecuta nada', async () => {
    const { d, decide } = deps();
    const out = await runNotificationAction(d, { ...base, index: 1 });
    expect(out.httpStatus).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('quien no administra: el camino del piloto lo rechaza y el aviso NO se marca leído', async () => {
    const { d, markRead } = deps({
      decide: async () => ({
        ok: false,
        message: 'Sólo un administrador o el dueño decide lo del piloto.',
      }),
    });
    const out = await runNotificationAction(d, base);
    expect(out).toMatchObject({ httpStatus: 409, ok: false });
    expect(out.note).toContain('administrador');
    expect(markRead).not.toHaveBeenCalled();
  });

  it('huella vencida (la cosa cambió): se propaga el rechazo', async () => {
    const { d } = deps({
      decide: async () => ({
        ok: false,
        message: 'Cambió desde que la viste. Actualiza la página y vuelve a mirarla.',
      }),
    });
    const out = await runNotificationAction(d, base);
    expect(out.httpStatus).toBe(409);
    expect(out.note).toContain('Cambió');
  });

  it('si al ejecutarse falla, se dice y no se marca leído', async () => {
    const { d, markRead } = deps({
      decide: async () => ({ ok: true, status: 'failed', message: 'No se pudo reintentar.' }),
    });
    const out = await runNotificationAction(d, base);
    expect(out).toMatchObject({ httpStatus: 409, ok: false, note: 'No se pudo reintentar.' });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('descartar también pasa por el mismo camino', async () => {
    const decide = vi.fn<ActionDeps['decide']>(async () => ({
      ok: true,
      status: 'dismissed',
      message: 'Descartado.',
    }));
    const { d } = deps({ decide });
    const out = await runNotificationAction(d, { ...base, decision: 'dismiss' });
    expect(out.ok).toBe(true);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'dismiss' }));
  });

  it('una decisión desconocida se rechaza antes de tocar nada', async () => {
    const { d, find } = deps();
    const out = await runNotificationAction(d, { ...base, decision: 'delete' as never });
    expect(out.httpStatus).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });
});
