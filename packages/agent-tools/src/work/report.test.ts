import { describe, expect, it } from 'vitest';
import {
  AS_OF,
  CARLOS,
  JULIAN,
  LAURA,
  PERIOD,
  PREVIOUS,
  SOFIA,
  VALENTINA,
  closed,
  item,
  team,
  workItems,
} from './metrics.fixtures';
import { buildTeamReport, describePerson, periodLabel } from './report';

const build = () =>
  buildTeamReport({ items: workItems(), people: team(), period: PERIOD, asOf: AS_OF });

describe('buildTeamReport', () => {
  it('el anterior por defecto es la semana inmediatamente antes', () => {
    const r = build();
    expect(r.period).toEqual(PERIOD);
    expect(r.previous).toEqual(PREVIOUS);
    expect(r.asOf).toBe(AS_OF);
  });

  it('las personas van en orden alfabético, nunca por una cifra', () => {
    expect(build().people.map((e) => e.person.name)).toEqual([
      'Andrés Restrepo',
      'Carlos Ruiz',
      'Julián Pérez',
      'Laura Gómez',
      'Sofía Martínez',
      'Valentina Ospina',
    ]);
  });

  it('nunca resume a nadie en un puntaje', () => {
    const r = build();
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(x);
        }
      }
    };
    walk(r);
    for (const k of keys) expect(k).not.toMatch(/score|rank|rating|grade|puntaje|nota$/);
    const text = [
      ...r.signals.flatMap((s) => [s.message, s.suggestion ?? '']),
      // La nota que lo promete («No hay nota única ni ranking») es la única excepción.
      ...r.notes.map((n) => n.replace('No hay nota única ni ranking.', '')),
      ...r.people.map((e) => describePerson(r, e.person.id, workItems())),
    ].join('\n');
    expect(text).not.toMatch(/puntaje|ranking|calificaci|el mejor|el peor|no rinde/i);
  });

  it('cada persona trae su total, su anterior y sus tipos', () => {
    const r = build();
    const julian = r.people.find((e) => e.person.id === JULIAN);
    expect(julian?.byType.map((s) => s.workType)).toEqual(['caso', 'cobro']);
    expect(julian?.current).toMatchObject({ done: 9, openNow: 9, workingDays: 5 });
    expect(julian?.previous).toMatchObject({ done: 16 });
    // Valentina no tiene historia: nulo, no ceros.
    expect(r.people.find((e) => e.person.id === VALENTINA)?.previous).toBeNull();
  });

  it('las notas dicen los límites', () => {
    const notes = build().notes.join('\n');
    expect(notes).toContain('Sin vencimiento no se mide a tiempo: 5 de 45 cerrados');
    expect(notes).toContain('Menos de 8 ítems: no se compara');
    expect(notes).toContain('Valentina Ospina (3 ítems)');
    expect(notes).toContain('Días fuera descontados (no cuentan en contra): Carlos Ruiz (5 días)');
    expect(notes).toContain('El período sigue en curso: la foto es al 2 oct');
    expect(notes).toContain('Lo cancelado (1) no cuenta');
    expect(notes).toContain('No hay nota única ni ranking');
  });

  it('un festivo en el período se nombra en las notas', () => {
    const period = { from: '2026-10-12', to: '2026-10-18' };
    const items = closed('x', LAURA, 'despacho', ['2026-10-13', '2026-10-14'], 4, {
      cycleHours: 5,
    });
    const r = buildTeamReport({ items, people: team(), period });
    expect(r.notes.join('\n')).toContain('menos festivos de Colombia (12 oct)');
    expect(r.people.find((e) => e.person.id === LAURA)?.current.workingDays).toBe(4);
  });

  it('determinista: el mismo resultado sin importar el orden de entrada', () => {
    const a = build();
    const items = workItems().reverse();
    const people = team().reverse();
    const b = buildTeamReport({ items, people, period: PERIOD, asOf: AS_OF });
    expect(b).toEqual(a);
    expect(JSON.stringify(build())).toBe(JSON.stringify(a));
  });

  it('ítems de alguien fuera del equipo y hechos sin fecha se dicen, no se cuentan', () => {
    const items = [
      item('z1', 'u-externo', 'despacho', '2026-09-29'),
      item('z2', LAURA, 'despacho', '2026-09-20', { status: 'done', doneAt: null }),
    ];
    const r = buildTeamReport({ items, people: team(), period: PERIOD, asOf: AS_OF });
    const notes = r.notes.join('\n');
    expect(notes).toContain('1 ítem asignado a alguien que no está en el equipo');
    expect(notes).toContain('1 marcado como hecho sin fecha de cierre');
    expect(r.people.find((e) => e.person.id === LAURA)?.current.sample).toBe(0);
  });
});

describe('describePerson («Mi semana»)', () => {
  it('Laura: sus números, lo que la espera y la carga dicha sin reclamo', () => {
    const r = build();
    expect(describePerson(r, LAURA, workItems())).toBe(
      'En la semana del 28 sep cerraste 9 despachos en 5 días trabajables. ' +
        'De los que tenían fecha, 7 de 9 a tiempo (78%). Lo producido: 240 guías. ' +
        'Te esperan 16 abiertos, 7 ya vencidos. Lo primero: «Despacho pedido 4500» y «Despacho pedido 4501». ' +
        'En despachos tienes más abiertos que la mayoría del equipo (16; la mediana es 4): se sugirió repartir, no es un reclamo. ' +
        'El período anterior: 10 cerrados en 5 días trabajables.',
    );
  });

  it('Sofía: lo que mejoró, en segunda persona', () => {
    const text = describePerson(build(), SOFIA);
    expect(text).toContain('cerraste 16 (despachos 13, solicitudes 3)');
    expect(text).toContain(
      'Mejoraste en despachos: cierras 2,6 por día (antes 1,6); 100% a tiempo (antes 75%); tardas 18 horas en cerrar uno (antes 28).',
    );
    expect(text).not.toContain('Lo primero'); // sin ítems, no nombra títulos
  });

  it('Carlos: las vacaciones no cuentan en contra', () => {
    const text = describePerson(build(), CARLOS);
    expect(text).toContain('estuviste fuera todos los días trabajables');
    expect(text).toContain('Te esperan 5 abiertos, 3 ya vencidos.');
  });

  it('Julián: la baja como pregunta de apoyo', () => {
    expect(describePerson(build(), JULIAN)).toContain(
      'En casos cerraste 0,8 por día (antes 2). Si algo te está frenando, dilo y se busca cómo ayudarte.',
    );
  });

  it('Valentina: nueva, sin comparación y en singular', () => {
    const text = describePerson(build(), VALENTINA);
    expect(text).toContain('cerraste 1 caso en 5 días trabajables');
    expect(text).toContain('Todavía no hay un período anterior tuyo para comparar');
  });

  it('alguien sin nada registrado', () => {
    expect(describePerson(build(), 'u-nadie')).toBe(
      'No hay trabajo registrado a tu nombre en este período.',
    );
  });

  it('etiqueta del período', () => {
    expect(periodLabel(PERIOD)).toBe('la semana del 28 sep');
    expect(periodLabel({ from: '2026-09-01', to: '2026-09-15' })).toBe('del 1 sep al 15 sep');
  });
});
