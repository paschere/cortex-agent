import { describe, expect, it } from 'vitest';
import { groupThreads, threadState } from './chat-thread-groups';

const now = new Date(2026, 9, 15, 12, 0, 0);
const d = (days: number, h = 10) => new Date(2026, 9, 15 - days, h).toISOString();

describe('groupThreads', () => {
  const rows = [
    { id: 'a', title: 'Hoy uno', updated_at: d(0) },
    { id: 'b', title: 'Ayer uno', updated_at: d(1) },
    { id: 'c', title: 'Semana', updated_at: d(4) },
    { id: 'd', title: 'Cartera vencida', updated_at: d(10) },
    { id: 'e', title: null, updated_at: d(60) },
  ];
  it('agrupa por antigüedad en orden', () => {
    const g = groupThreads(rows, { now });
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'week', 'month', 'older']);
  });
  it('busca sin tildes ni mayúsculas', () => {
    const g = groupThreads(rows, { now, query: 'CARTERA' });
    expect(g).toHaveLength(1);
    expect(g[0]?.rows[0]?.id).toBe('d');
  });
  it('los fijados van primero', () => {
    const g = groupThreads(rows, { now, pinned: new Set(['d']) });
    expect(g[0]?.key).toBe('pinned');
  });
  it('sin título se llama Sin título', () => {
    expect(groupThreads(rows, { now, query: 'sin titulo' })[0]?.rows[0]?.id).toBe('e');
  });
});

describe('filtros y estado de la lista', () => {
  const rows = [
    { id: 'a', title: 'Uno', task_status: 'working' },
    { id: 'b', title: 'Dos', task_status: null },
    { id: 'c', title: 'Tres', task_status: 'done' },
  ];
  it('Tareas deja sólo los chats con tarea', () => {
    const g = groupThreads(rows, { filter: 'tasks' });
    expect(g.flatMap((x) => x.rows.map((r) => r.id)).sort()).toEqual(['a', 'c']);
  });
  it('Fijados deja sólo los fijados', () => {
    const g = groupThreads(rows, { filter: 'pinned', pinned: new Set(['b']) });
    expect(g.flatMap((x) => x.rows.map((r) => r.id))).toEqual(['b']);
  });
  it('el estado prioriza aprobación, luego respondiendo, luego tarea', () => {
    expect(threadState({ task_status: 'working' }, 'approval')).toBe('approval');
    expect(threadState({ task_status: 'needs_you' })).toBe('approval');
    expect(threadState({ task_status: 'working' }, 'responding')).toBe('responding');
    expect(threadState({ task_status: 'queued' })).toBe('task');
    expect(threadState({ task_status: 'done' })).toBe('done');
    expect(threadState({ task_status: null })).toBeNull();
  });
});
