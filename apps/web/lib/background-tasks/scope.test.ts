import { describe, expect, it } from 'vitest';
import { applyTaskScope, canCancelTask, canRetryTask, canSeeTask } from './scope';

const owner = { id: 'u1', isManager: false };
const other = { id: 'u2', isManager: false };
const admin = { id: 'u3', isManager: true };
const task = { userId: 'u1' };

describe('alcance de las tareas', () => {
  it('cada quien ve las suyas; quien administra ve todas', () => {
    expect(canSeeTask(owner, task)).toBe(true);
    expect(canSeeTask(other, task)).toBe(false);
    expect(canSeeTask(admin, task)).toBe(true);
  });

  it('cancelar: la dueña o quien administra', () => {
    expect(canCancelTask(owner, task)).toBe(true);
    expect(canCancelTask(admin, task)).toBe(true);
    expect(canCancelTask(other, task)).toBe(false);
  });

  it('reintentar: sólo la dueña (la tarea nueva corre con SUS permisos)', () => {
    expect(canRetryTask(owner, task)).toBe(true);
    expect(canRetryTask(admin, task)).toBe(false);
  });

  it('la consulta se acota por dueña salvo para administradores', () => {
    const calls: Array<[string, unknown]> = [];
    const q = {
      eq(c: string, v: unknown) {
        calls.push([c, v]);
        return q;
      },
    };
    applyTaskScope(q, owner);
    expect(calls).toEqual([['user_id', 'u1']]);
    calls.length = 0;
    applyTaskScope(q, admin);
    expect(calls).toEqual([]);
  });
});
