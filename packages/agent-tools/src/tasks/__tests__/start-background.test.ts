import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../types';
import { tasksStartBackground } from '../index';

/** Un db de mentira con la forma que usa la herramienta: count, insert().select().single(), update().eq(). */
function fakeDb(opts: { active: number; insertOk?: boolean }) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ in: async () => ({ count: opts.active, error: null }) }),
      }),
      insert: (row: unknown) => {
        inserted.push(row);
        return {
          select: () => ({
            single: async () =>
              opts.insertOk === false
                ? { data: null, error: { message: 'x' } }
                : { data: { id: 'task-1' }, error: null },
          }),
        };
      },
      update: (patch: unknown) => {
        updated.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { db, inserted, updated };
}

function ctx(over: Partial<ToolContext>, db: unknown): ToolContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    db,
    ...over,
  } as unknown as ToolContext;
}

const input = { request: 'Revisa la cartera vencida y prepara los correos de cobro' };

describe('tasks.start_background', () => {
  it('es una propuesta: pide confirmación', () => {
    expect(tasksStartBackground.requiresConfirmation).toBe(true);
  });

  it('sin conversación no hay dónde guardar el avance', async () => {
    const { db } = fakeDb({ active: 0 });
    const out = await tasksStartBackground.handler(
      input as never,
      ctx({ conversationId: undefined, enqueueJob: vi.fn() }, db),
    );
    expect(out.ok).toBe(false);
  });

  it('crea la tarea en modo «continue» y la encola con la empresa', async () => {
    const { db, inserted } = fakeDb({ active: 1 });
    const enqueueJob = vi.fn(async () => true);
    const out = await tasksStartBackground.handler(input as never, ctx({ enqueueJob }, db));
    expect(out).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(inserted[0]).toMatchObject({
      user_id: 'user-1',
      conversation_id: 'conv-1',
      mode: 'continue',
    });
    expect(enqueueJob).toHaveBeenCalledWith('tasks/run', {
      taskId: 'task-1',
      organizationId: 'org-1',
    });
  });

  it('con cinco tareas en curso no crea otra', async () => {
    const { db, inserted } = fakeDb({ active: 5 });
    const enqueueJob = vi.fn(async () => true);
    const out = await tasksStartBackground.handler(input as never, ctx({ enqueueJob }, db));
    expect(out.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('si la cola no la recibe, la tarea queda fallida y no se promete nada', async () => {
    const { db, updated } = fakeDb({ active: 0 });
    const out = await tasksStartBackground.handler(
      input as never,
      ctx({ enqueueJob: vi.fn(async () => false) }, db),
    );
    expect(out.ok).toBe(false);
    expect(updated[0]).toMatchObject({ status: 'failed' });
  });
});
