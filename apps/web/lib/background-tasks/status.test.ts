import { describe, expect, it } from 'vitest';
import {
  SEGMENT_MS,
  TASK_CAP_MS,
  TASK_STATUSES,
  afterSegment,
  approvalsNote,
  canCancel,
  canRetry,
  canTransition,
  deadlineFor,
  durationMs,
  formatTaskDuration,
  isActive,
  isStale,
  isTerminal,
  openApprovals,
  parseApprovals,
  readyToResume,
  segmentBudgetMs,
} from './status';

describe('máquina de estados', () => {
  it('los finales no salen de ahí', () => {
    for (const s of ['done', 'failed', 'cancelled'] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const to of TASK_STATUSES) expect(canTransition(s, to)).toBe(false);
    }
  });

  it('el camino feliz y la pausa por aprobación', () => {
    expect(canTransition('queued', 'working')).toBe(true);
    expect(canTransition('working', 'needs_you')).toBe(true);
    expect(canTransition('needs_you', 'working')).toBe(true);
    expect(canTransition('working', 'done')).toBe(true);
    expect(canTransition('queued', 'done')).toBe(false);
    expect(canTransition('queued', 'needs_you')).toBe(false);
  });

  it('cancelar mientras no terminó; reintentar sólo lo que no salió bien', () => {
    expect(['queued', 'working', 'needs_you'].every((s) => canCancel(s as never))).toBe(true);
    expect(canCancel('done')).toBe(false);
    expect(isActive('needs_you')).toBe(true);
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('cancelled')).toBe(true);
    expect(canRetry('done')).toBe(false);
    expect(canRetry('working')).toBe(false);
  });
});

describe('tiempos', () => {
  const t0 = new Date('2026-10-11T10:00:00Z');

  it('el tope son 20 minutos desde que empieza', () => {
    expect(deadlineFor(t0).getTime() - t0.getTime()).toBe(TASK_CAP_MS);
    expect(TASK_CAP_MS).toBe(20 * 60_000);
  });

  it('la tanda es la estándar o lo que le quede al tope', () => {
    const dl = deadlineFor(t0);
    expect(segmentBudgetMs(dl, t0)).toBe(SEGMENT_MS);
    expect(segmentBudgetMs(dl, new Date(t0.getTime() + 19 * 60_000))).toBe(60_000);
    expect(segmentBudgetMs(dl, new Date(t0.getTime() + 25 * 60_000))).toBe(0);
    expect(segmentBudgetMs(null, t0)).toBe(SEGMENT_MS);
  });

  it('una tanda sin latido en 5 minutos está muerta; entre tandas (sin latido) no', () => {
    const now = new Date('2026-10-11T10:10:00Z');
    expect(
      isStale(
        {
          status: 'working',
          heartbeatAt: '2026-10-11T10:00:00Z',
          startedAt: '2026-10-11T09:55:00Z',
        },
        now,
      ),
    ).toBe(true);
    expect(
      isStale(
        {
          status: 'working',
          heartbeatAt: '2026-10-11T10:08:00Z',
          startedAt: '2026-10-11T09:55:00Z',
        },
        now,
      ),
    ).toBe(false);
    expect(
      isStale({ status: 'working', heartbeatAt: null, startedAt: '2026-10-11T09:00:00Z' }, now),
    ).toBe(false);
    expect(
      isStale({ status: 'needs_you', heartbeatAt: '2026-10-11T08:00:00Z', startedAt: null }, now),
    ).toBe(false);
  });

  it('duración: hasta que terminó, o hasta ahora', () => {
    const now = new Date('2026-10-11T10:05:00Z');
    expect(durationMs({ startedAt: null, finishedAt: null }, now)).toBeNull();
    expect(durationMs({ startedAt: '2026-10-11T10:00:00Z', finishedAt: null }, now)).toBe(300_000);
    expect(
      durationMs({ startedAt: '2026-10-11T10:00:00Z', finishedAt: '2026-10-11T10:01:30Z' }, now),
    ).toBe(90_000);
    expect(formatTaskDuration(37_000)).toBe('37 s');
    expect(formatTaskDuration(252_000)).toBe('4 min 12 s');
    expect(formatTaskDuration(120_000)).toBe('2 min');
    expect(formatTaskDuration(3_900_000)).toBe('1 h 05 min');
    expect(formatTaskDuration(null)).toBe('—');
  });
});

describe('qué pasa al cerrar una tanda', () => {
  it('el modelo cerró: lista', () => {
    expect(afterSegment({ end: 'finished', pendingApprovals: 0, capReached: false })).toEqual({
      status: 'done',
      requeue: false,
      reason: 'finished',
    });
  });

  it('sin tiempo y sin tope: otra tanda', () => {
    expect(afterSegment({ end: 'out_of_time', pendingApprovals: 0, capReached: false })).toEqual({
      status: 'working',
      requeue: true,
      reason: 'continues',
    });
  });

  it('sin tiempo y con tope: se cierra con lo que lleva', () => {
    const r = afterSegment({ end: 'out_of_time', pendingApprovals: 0, capReached: true });
    expect(r.status).toBe('done');
    expect(r.reason).toBe('cap_reached');
    expect(r.requeue).toBe(false);
  });

  it('con acciones esperando, «te necesita» aunque el modelo haya cerrado', () => {
    expect(afterSegment({ end: 'finished', pendingApprovals: 2, capReached: false }).status).toBe(
      'needs_you',
    );
    expect(afterSegment({ end: 'out_of_time', pendingApprovals: 1, capReached: true }).status).toBe(
      'needs_you',
    );
  });

  it('error y cancelación mandan sobre todo lo demás', () => {
    expect(afterSegment({ end: 'error', pendingApprovals: 3, capReached: false }).status).toBe(
      'failed',
    );
    expect(afterSegment({ end: 'cancelled', pendingApprovals: 3, capReached: false }).status).toBe(
      'cancelled',
    );
  });
});

describe('acciones paradas', () => {
  const list = parseApprovals([
    { id: 'a', toolId: 'gmail.send', summary: 'Enviar correo a Ana' },
    {
      id: 'b',
      toolId: 'payments.record',
      summary: 'Registrar un pago',
      decision: 'approved',
      ok: true,
    },
    { nope: true },
    null,
  ]);

  it('ignora lo que no tiene forma', () => {
    expect(list.map((a) => a.id)).toEqual(['a', 'b']);
    expect(parseApprovals('x')).toEqual([]);
  });

  it('sigue sólo cuando TODAS tienen respuesta', () => {
    expect(openApprovals(list).map((a) => a.id)).toEqual(['a']);
    expect(readyToResume(list)).toBe(false);
    expect(readyToResume([])).toBe(false);
    expect(
      readyToResume(list.map((a) => ({ ...a, decision: a.decision ?? ('declined' as const) }))),
    ).toBe(true);
  });

  it('le cuenta al modelo lo aprobado, lo rechazado y lo que falló', () => {
    const note = approvalsNote([
      { id: '1', toolId: 'x', summary: 'Enviar correo', decision: 'approved', ok: true },
      { id: '2', toolId: 'y', summary: 'Pagar factura', decision: 'declined' },
      {
        id: '3',
        toolId: 'z',
        summary: 'Crear tarea',
        decision: 'approved',
        ok: false,
        note: 'sin permiso',
      },
      { id: '4', toolId: 'w', summary: 'Aún abierta' },
    ]);
    expect(note).toContain('Aprobada y ejecutada: Enviar correo');
    expect(note).toContain('RECHAZADA');
    expect(note).toContain('NO salió bien (sin permiso): Crear tarea');
    expect(note).not.toContain('Aún abierta');
    expect(approvalsNote([])).toBe('');
  });
});
