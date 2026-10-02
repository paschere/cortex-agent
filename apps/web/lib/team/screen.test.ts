import { buildTeamReport } from '@cortex/agent-tools';
import {
  ANDRES,
  AS_OF,
  CARLOS,
  LAURA,
  PERIOD,
  PREVIOUS,
  SOFIA,
  team,
  workItems,
} from '@cortex/agent-tools/src/work/metrics.fixtures';
import { describe, expect, it } from 'vitest';
import { type TeamHrefs, buildPersonScreen, buildTeamScreen, planMoves } from './screen';
import {
  awayRanges,
  canMarkDone,
  chatPath,
  daysInRange,
  formatHours,
  initials,
  markableTrackers,
  periodFor,
  readPeriodKey,
  sourcePath,
  trendOf,
} from './shape';

const hrefs: TeamHrefs = {
  team: ({ periodo, tipo }) => `/team?periodo=${periodo}${tipo ? `&tipo=${tipo}` : ''}`,
  person: (id) => `/team/${id}`,
  me: () => '/team/yo',
  settings: '/team/medir',
  people: '/admin/users',
  activity: null,
  chat: chatPath,
  source: (p) => p,
};

const items = workItems();
const report = buildTeamReport({
  items,
  people: team(),
  period: PERIOD,
  previous: PREVIOUS,
  asOf: AS_OF,
});

const admin = { id: 'u-admin', seesAll: true, canReassign: true, canConfigure: true };

describe('los períodos', () => {
  it('esta semana va de lunes a domingo; la pasada, la anterior; 30 días termina hoy', () => {
    expect(periodFor('semana', '2026-10-02')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(periodFor('pasada', '2026-10-02')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(periodFor('30d', '2026-10-02')).toEqual({ from: '2026-09-03', to: '2026-10-02' });
    expect(periodFor('semana', '2026-09-28').from).toBe('2026-09-28');
    expect(periodFor('semana', '2026-10-04').from).toBe('2026-09-28');
    expect(readPeriodKey('x')).toBe('semana');
  });
});

describe('las piezas', () => {
  it('escribe duraciones, iniciales y flechas con su tono', () => {
    expect(formatHours(6)).toBe('6 h');
    expect(formatHours(72)).toBe('3 días');
    expect(initials('Laura Gómez Ríos')).toBe('LR');
    expect(trendOf(5, 8, 'down')?.tone).toBe('good');
    expect(trendOf(5, 8, 'up')?.tone).toBe('attention');
    expect(trendOf(5, 8, 'none')?.tone).toBe('neutral');
    expect(trendOf(8, 8, 'up')?.dir).toBe('flat');
  });

  it('sólo marca hecho lo propio y abierto con un camino seguro', () => {
    const base = { status: 'open' as const, assigneeId: 'me' };
    expect(canMarkDone({ ...base, source: { kind: 'commitment', ref: 'c1' } }, 'me')).toBe(true);
    expect(canMarkDone({ ...base, source: { kind: 'chat', ref: 'h' } }, 'me')).toBe(true);
    expect(canMarkDone({ ...base, source: { kind: 'tracker_row', ref: 'r' } }, 'me')).toBe(false);
    expect(canMarkDone({ ...base, source: { kind: 'management_case', ref: 'm' } }, 'me')).toBe(
      false,
    );
    expect(canMarkDone({ ...base, source: { kind: 'chat', ref: 'h' } }, 'other')).toBe(false);
  });

  it('una fila de tabla con estado «hecho»: quien responde, o quien administra o es dueño', () => {
    const row = {
      status: 'open' as const,
      assigneeId: 'me',
      source: { kind: 'tracker_row' as const, system: 'despachos', ref: 'r1' },
    };
    const markable = markableTrackers([
      { tracker: 'despachos', statusField: 'estado', doneValues: ['Despachado'] },
      { tracker: 'sin-estado', statusField: null, doneValues: [] },
      { tracker: 'sin-hecho', statusField: 'estado', doneValues: [] },
    ]);
    expect([...markable]).toEqual(['despachos']);
    expect(canMarkDone(row, 'me', { markableTrackers: markable })).toBe(true);
    expect(canMarkDone(row, 'other', { markableTrackers: markable })).toBe(false);
    expect(canMarkDone(row, 'other', { markableTrackers: markable, manages: true })).toBe(true);
    expect(
      canMarkDone({ ...row, source: { ...row.source, system: 'sin-estado' } }, 'me', {
        markableTrackers: markable,
        manages: true,
      }),
    ).toBe(false);
    expect(canMarkDone({ ...row, status: 'done' }, 'me', { markableTrackers: markable })).toBe(
      false,
    );
    // Quien administra no cierra los compromisos de otros desde aquí.
    expect(
      canMarkDone({ ...row, source: { kind: 'commitment', ref: 'c1' } }, 'other', {
        manages: true,
      }),
    ).toBe(false);
    expect(sourcePath({ source: { kind: 'tracker_row', system: 'guias', ref: 'r' } })).toBe(
      '/trackers/guias',
    );
  });

  it('agrupa días fuera seguidos', () => {
    expect(awayRanges(['2026-10-02', '2026-09-30', '2026-10-01', '2026-10-06'])).toEqual([
      { from: '2026-09-30', to: '2026-10-02' },
      { from: '2026-10-06', to: '2026-10-06' },
    ]);
    expect(daysInRange('2026-10-01', '2026-10-03')).toHaveLength(3);
    expect(daysInRange('2026-10-03', '2026-10-01')).toEqual([]);
  });
});

describe('/team', () => {
  const screen = buildTeamScreen({
    report,
    items,
    periodKey: 'semana',
    workType: null,
    today: AS_OF,
    viewer: admin,
    visibleIds: null,
    hrefs,
  });

  it('muestra a todos en orden alfabético, sin puntaje', () => {
    const names = screen.people.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'es')));
    expect(names).toHaveLength(6);
    for (const p of screen.people) {
      expect(Object.keys(p)).not.toContain('score');
      expect(p.metrics.map((m) => m.key)).toEqual([
        'abiertos',
        'vencidos',
        'cerrados',
        'a_tiempo',
        'ciclo',
      ]);
    }
  });

  it('Laura: 16 abiertos, 7 vencidos, con la mediana del equipo al lado', () => {
    const laura = screen.people.find((p) => p.id === LAURA);
    expect(laura?.metrics[0]?.value).toBe('16');
    expect(laura?.metrics[1]?.value).toBe('7');
    expect(laura?.metrics[1]?.attention).toBe(true);
    expect(laura?.metrics[0]?.team).not.toBeNull();
  });

  it('Carlos está fuera: se dice, y nada cuenta en contra', () => {
    const carlos = screen.people.find((p) => p.id === CARLOS);
    expect(carlos?.awayToday).toBe(true);
    expect(carlos?.note).toMatch(/fuera/);
  });

  it('separa lo que pide atención de los reconocimientos, y lo sin responsable aparte', () => {
    expect(screen.attention.some((s) => s.kind === 'overloaded' && s.personId === LAURA)).toBe(
      true,
    );
    expect(screen.recognitions.some((s) => s.personId === SOFIA)).toBe(true);
    expect(screen.attention.some((s) => s.kind === 'unassigned_pile')).toBe(false);
    expect(screen.unassigned?.count).toBe(7);
    expect(screen.unassigned?.signal?.moves.length).toBeGreaterThan(0);
  });

  it('«Reasignar» propone ítems concretos de Laura para quien menos tiene', () => {
    const over = screen.attention.find((s) => s.kind === 'overloaded' && s.personId === LAURA);
    expect(over?.moves.length).toBeGreaterThan(0);
    expect(over?.moves.map((m) => m.toId)).toContain(ANDRES);
    const moved = over?.moves.flatMap((m) => m.items.map((i) => i.id)) ?? [];
    expect(new Set(moved).size).toBe(moved.length);
    expect(moved.every((id) => id.startsWith('lau-open-'))).toBe(true);
    expect(over?.writeHref).toMatch(/^\/chat\?prompt=/);
  });

  it('nunca propone pasar un asunto de Gerencia o una aprobación', () => {
    const signal = report.signals.find((s) => s.kind === 'overloaded');
    if (!signal) throw new Error('falta la señal');
    const byId = new Map(
      items.map((i) => [
        i.id,
        i.id === 'lau-open-1'
          ? { ...i, source: { kind: 'management_case' as const, ref: 'x' } }
          : i,
      ]),
    );
    const plan = planMoves(signal, team(), byId, AS_OF);
    expect(plan.blocked).toBe(1);
    expect(plan.moves.flatMap((m) => m.items.map((i) => i.id))).not.toContain('lau-open-1');
  });

  it('con un tipo elegido compara peras con peras', () => {
    const despachos = buildTeamScreen({
      report,
      items,
      periodKey: 'semana',
      workType: 'despacho',
      today: AS_OF,
      viewer: admin,
      visibleIds: null,
      hrefs,
    });
    expect(despachos.people.map((p) => p.id).sort()).toEqual([ANDRES, LAURA, SOFIA].sort());
    expect(despachos.withoutType).toContain('Carlos Ruiz');
    expect(despachos.types.find((t) => t.active)?.key).toBe('despacho');
  });

  it('quien no ve a todos no recibe señales de otros, ni lo sin responsable, ni las notas', () => {
    const mine = buildTeamScreen({
      report,
      items,
      periodKey: 'semana',
      workType: null,
      today: AS_OF,
      viewer: { id: SOFIA, seesAll: false, canReassign: false, canConfigure: false },
      visibleIds: new Set([SOFIA, ANDRES, LAURA]),
      hrefs,
    });
    expect(mine.people.map((p) => p.id).sort()).toEqual([ANDRES, LAURA, SOFIA].sort());
    expect(mine.attention.every((s) => s.personId === SOFIA)).toBe(true);
    expect(mine.unassigned).toBeNull();
    expect(mine.notes).toEqual([]);
    expect(mine.attention.flatMap((s) => s.moves)).toEqual([]);
  });
});

describe('/team/[persona] y Mi semana', () => {
  it('trae el párrafo, ocho semanas por tipo y los abiertos con lo vencido primero', () => {
    const screen = buildPersonScreen({
      report,
      history: items,
      personId: SOFIA,
      periodKey: 'semana',
      today: AS_OF,
      viewer: { id: SOFIA, seesAll: false, canEditAway: true },
      hrefs,
      mode: 'self',
    });
    if (!screen) throw new Error('sin pantalla');
    expect(screen.self).toBe(true);
    expect(screen.description).toMatch(/cerraste/);
    expect(screen.sections[0]?.weeks).toHaveLength(8);
    expect(screen.sections.map((s) => s.workType)).toEqual([null, 'despacho', 'solicitud']);
    expect(screen.improved.length).toBeGreaterThan(0);
    expect(screen.links.team).toBeNull();
    expect(screen.links.write).toBeNull();
  });

  it('a Laura le pone lo vencido arriba', () => {
    const screen = buildPersonScreen({
      report,
      history: items,
      personId: LAURA,
      periodKey: 'semana',
      today: AS_OF,
      viewer: { id: 'u-admin', seesAll: true, canEditAway: true },
      hrefs,
    });
    expect(screen?.open[0]?.overdue).toBe(true);
    expect(screen?.overdueTotal).toBe(7);
    expect(screen?.links.write).toMatch(/^\/chat\?prompt=/);
  });
});
