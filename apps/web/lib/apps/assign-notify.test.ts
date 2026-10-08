import { describe, expect, it, vi } from 'vitest';
import { type AssignNoticeDeps, notifyAssigned } from './assign-notify';

/**
 * EL AVISO DE UNA TAREA ASIGNADA: cada persona por el canal que tenga, sin
 * inventar otra vía, y un aviso caído nunca tumba la asignación.
 */

const APP = { id: 'app-1', slug: 'campo', name: 'Equipo en campo' };
const TASK = { rowId: 'row-9', label: 'Cambiar medidor', due: '2026-10-09' };
const db = {} as never;

function deps(over: Partial<AssignNoticeDeps> = {}): AssignNoticeDeps & {
  calls: { push: unknown[][]; bell: unknown[][]; email: unknown[][]; members: unknown[][] };
} {
  const calls = {
    push: [] as unknown[][],
    bell: [] as unknown[][],
    email: [] as unknown[][],
    members: [] as unknown[][],
  };
  return {
    calls,
    pushAppUsers: vi.fn(async (...a: unknown[]) => {
      calls.push.push(a);
      return [] as string[];
    }) as never,
    pushMembers: vi.fn(async (...a: unknown[]) => {
      calls.members.push(a);
      return [] as string[];
    }) as never,
    bell: vi.fn(async (...a: unknown[]) => {
      calls.bell.push(a);
      return 'n1';
    }) as never,
    email: vi.fn(async (...a: unknown[]) => {
      calls.email.push(a);
      return { sent: true };
    }) as never,
    baseUrl: () => 'https://cortex.test',
    ...over,
  };
}

const elena = {
  kind: 'app_user' as const,
  id: 'u-elena',
  email: 'elena@example.com',
  name: 'Elena',
};
const mario = { kind: 'member' as const, id: 'u-mario', email: 'mario@example.com', name: 'Mario' };

describe('aviso de tarea asignada', () => {
  it('usuario externo con push: llega el push a SU app y no se manda correo', async () => {
    const d = deps({ pushAppUsers: vi.fn(async () => ['u-elena']) as never });
    const out = await notifyAssigned(
      db,
      { app: APP, person: elena, task: TASK, screen: 'mis_tareas', by: 'Lucía' },
      d,
    );
    expect(out).toBe('push');
    const [, appId, ids, payload] = (d.pushAppUsers as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [unknown, string, string[], { title: string; url: string; body: string }];
    expect(appId).toBe('app-1');
    expect(ids).toEqual(['u-elena']);
    expect(payload.title).toBe('Nueva tarea: Cambiar medidor');
    expect(payload.url).toBe('/a/app-1/mis_tareas?fila=row-9');
    expect(payload.body).toContain('Lucía te la asignó');
    expect(payload.body).toContain('2026-10-09');
    expect(d.calls.email).toHaveLength(0);
  });

  it('usuario externo sin push (sin llaves o sin suscripción): cae a correo con el enlace', async () => {
    const d = deps();
    const out = await notifyAssigned(
      db,
      { app: APP, person: elena, task: TASK, screen: 'mis_tareas', by: 'Lucía' },
      d,
    );
    expect(out).toBe('email');
    const [mail] = d.calls.email as [[{ to: string; subject: string; text: string }]];
    expect(mail[0].to).toBe('elena@example.com');
    expect(mail[0].text).toContain('https://cortex.test/a/app-1/mis_tareas?fila=row-9');
  });

  it('un push que revienta o un correo que no sale no lanzan: dice «none»', async () => {
    const d = deps({
      pushAppUsers: vi.fn(async () => {
        throw new Error('boom');
      }) as never,
      email: vi.fn(async () => ({ sent: false, reason: 'sin llaves' })) as never,
    });
    await expect(
      notifyAssigned(db, { app: APP, person: elena, task: TASK, screen: null, by: 'Lucía' }, d),
    ).resolves.toBe('none');
  });

  it('miembro de Cortex: campana (con enlace a /apps/<slug>) y push si activó los avisos', async () => {
    const d = deps();
    const out = await notifyAssigned(
      db,
      { app: APP, person: mario, task: TASK, screen: 'mis_tareas', by: 'Lucía' },
      d,
    );
    expect(out).toBe('bell');
    const bell = d.calls.bell[0]?.[1] as { userId: string; href: string; dedupeKey: string };
    expect(bell.userId).toBe('u-mario');
    expect(bell.href).toBe('/apps/campo/mis_tareas?fila=row-9');
    expect(bell.dedupeKey).toContain('row-9');
    expect(d.calls.members).toHaveLength(1);
    expect(d.calls.email).toHaveLength(0);
    const pushed = deps({ pushMembers: vi.fn(async () => ['u-mario']) as never });
    expect(
      await notifyAssigned(
        db,
        { app: APP, person: mario, task: TASK, screen: null, by: 'Lucía' },
        pushed,
      ),
    ).toBe('push');
  });
});
