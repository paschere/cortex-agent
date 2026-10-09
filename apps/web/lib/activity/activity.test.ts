import { describe, expect, it } from 'vitest';
import { applyActivityFilter, applyActivityScope, canSeeEvent, parseActivityFilter } from './scope';
import { describeEvent, isTimelineEvent, pastFirstPerson } from './sentences';
import { buildTimeline, groupByDay, weeklyCounts, weeklySentence } from './timeline';
import type { ActivityEvent } from './types';
import { canUndo, undoPlanFor } from './undo';

const ROW = '0b6c1d6e-2f0a-4c55-9f2a-1a2b3c4d5e6f';

function ev(over: Partial<ActivityEvent> & { detail?: unknown }): ActivityEvent {
  const { detail, ...rest } = over;
  return {
    id: over.id ?? 'e1',
    user_id: 'u1',
    conversation_id: null,
    tool_id: 'gmail.send_message',
    status: 'ok',
    decision: null,
    surface: 'web',
    mandate_id: null,
    created_at: '2026-10-08T15:00:00.000Z',
    metadata: detail ? { detail } : {},
    ...rest,
  };
}

const rowCreated = (id: string, tracker = 'vuelos', name = 'Vuelos') =>
  ev({
    id,
    tool_id: 'trackers.upsert',
    detail: {
      input: { tracker, values: { destino: 'Bogotá' } },
      result: { created: true, tracker: { slug: tracker, name }, row: { id: ROW, label: 'x' } },
    },
  });

describe('frases', () => {
  it('un correo enviado dice a quién y el asunto', () => {
    const d = describeEvent(
      ev({
        detail: { input: { to: ['ana@x.com'], subject: 'Cotización', body: 'hola' }, result: {} },
      }),
    );
    expect(d.text).toBe('Envié un correo a ana@x.com — «Cotización»');
    expect(d.group).toBe('email');
  });

  it('varios destinatarios se resumen', () => {
    const d = describeEvent(
      ev({
        detail: {
          input: { to: { items: ['a@x.com', 'b@x.com', 'c@x.com'], total: 7 } },
          result: {},
        },
      }),
    );
    expect(d.text).toContain('a@x.com y 2 más');
  });

  it('una herramienta sin frase propia usa su etiqueta en pasado', () => {
    expect(pastFirstPerson('Crear una vista')).toBe('Creé una vista');
    expect(pastFirstPerson('Actualizar negocio')).toBe('Actualicé negocio');
    expect(pastFirstPerson('Buscar en Gmail')).toBe('Busqué en Gmail');
    expect(pastFirstPerson('Hacer algo')).toBe('Hice algo');
    expect(pastFirstPerson('Resumen del embudo')).toBe('Usé: Resumen del embudo');
    expect(describeEvent(ev({ tool_id: 'hubspot.create_deal' })).text).toBe('Creé negocio');
  });

  it('un fallo lo dice y no se junta con los aciertos', () => {
    const d = describeEvent(ev({ status: 'error' }));
    expect(d.text.startsWith('No pude completar esto: envié un correo')).toBe(true);
    expect(d.collapse).toBeNull();
  });

  it('nunca muestra un valor tapado', () => {
    const d = describeEvent(
      ev({
        tool_id: 'schedule.create',
        detail: { input: { name: 'Cobro', token: '[oculto]' }, result: {} },
      }),
    );
    expect(d.text).toBe('Programé la rutina «Cobro»');
    expect(d.text).not.toContain('oculto');
  });

  it('las lecturas y los intentos no entran en la línea de tiempo', () => {
    expect(isTimelineEvent(ev({ tool_id: 'trackers.query' }))).toBe(false);
    expect(isTimelineEvent(ev({ tool_id: 'gmail.search' }))).toBe(false);
    expect(isTimelineEvent(ev({ status: 'attempted' }))).toBe(false);
    expect(isTimelineEvent(ev({ status: 'error', metadata: { reason: 'validation' } }))).toBe(
      false,
    );
    expect(isTimelineEvent(ev({ tool_id: 'trackers.upsert' }))).toBe(true);
    // Con detalle guardado fue una llamada con efectos aunque suene a lectura.
    expect(isTimelineEvent(ev({ tool_id: 'x.get_thing', detail: { input: {}, result: {} } }))).toBe(
      true,
    );
  });
});

describe('línea de tiempo', () => {
  it('junta filas seguidas de la misma tabla: «Anoté 3 filas en Vuelos»', () => {
    const lines = buildTimeline([rowCreated('a'), rowCreated('b'), rowCreated('c')]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Anoté 3 filas en Vuelos');
    expect(lines[0]?.eventIds).toEqual(['a', 'b', 'c']);
    expect(lines[0]?.undoLabel).toBe('Deshacer las 3');
  });

  it('no junta tablas distintas ni personas distintas', () => {
    expect(buildTimeline([rowCreated('a'), rowCreated('b', 'hoteles', 'Hoteles')])).toHaveLength(2);
    expect(buildTimeline([rowCreated('a'), { ...rowCreated('b'), user_id: 'u2' }])).toHaveLength(2);
  });

  it('lo ya deshecho no ofrece botón', () => {
    const lines = buildTimeline([rowCreated('a')], { undoneIds: new Set(['a']) });
    expect(lines[0]?.undoLabel).toBeNull();
  });

  it('agrupa por día de Bogotá con Hoy y Ayer', () => {
    const now = new Date('2026-10-08T20:00:00.000Z');
    const lines = buildTimeline([
      ev({ id: 'a', created_at: '2026-10-08T15:00:00.000Z' }),
      ev({ id: 'b', created_at: '2026-10-07T15:00:00.000Z' }),
      ev({ id: 'c', created_at: '2026-10-05T15:00:00.000Z' }),
    ]);
    const days = groupByDay(lines, now);
    expect(days.map((d) => d.label)).toEqual(['Hoy', 'Ayer', 'Lunes, 5 de octubre']);
  });

  it('una medianoche en UTC sigue siendo el día anterior en Bogotá', () => {
    const lines = buildTimeline([ev({ created_at: '2026-10-08T02:00:00.000Z' })]);
    expect(lines[0]?.day).toBe('2026-10-07');
  });

  it('el resumen de la semana cuenta por tipo', () => {
    const now = new Date('2026-10-08T20:00:00.000Z');
    const events = [
      ev({ id: '1' }),
      ev({ id: '2' }),
      rowCreated('3'),
      rowCreated('4'),
      ev({ id: '5', tool_id: 'payables.approve', decision: 'confirmed' }),
      ev({ id: '6', status: 'error' }),
      ev({ id: '7', created_at: '2026-09-01T15:00:00.000Z' }),
    ];
    const c = weeklyCounts(events, now);
    expect(c).toMatchObject({ emails: 2, rowsCreated: 2, approvals: 1, errors: 1 });
    expect(weeklySentence(c)).toBe(
      'Esta semana: 2 correos, 2 filas creadas, 1 cosa que necesitó tu aprobación, 1 error.',
    );
    expect(weeklySentence(weeklyCounts([], now))).toContain('todavía no ha hecho nada');
  });
});

describe('deshacer: elegibilidad', () => {
  it('una fila creada se quita', () => {
    expect(undoPlanFor(rowCreated('a'))).toEqual({
      toolId: 'trackers.remove',
      input: { tracker: 'vuelos', rowId: ROW },
      label: 'Quitar la fila',
    });
  });

  it('una edición se deshace sólo si la auditoría guardó los valores de antes', () => {
    const edited = (before?: Record<string, unknown>) =>
      ev({
        tool_id: 'trackers.upsert',
        detail: {
          input: { tracker: 'vuelos', rowId: ROW, values: { estado: 'Cancelado', precio: 10 } },
          result: { created: false, row: { id: ROW, label: 'x' } },
          ...(before ? { before } : {}),
        },
      });
    expect(undoPlanFor(edited())).toBeNull();
    expect(undoPlanFor(edited({ estado: 'Confirmado' }))).toBeNull(); // falta precio
    expect(undoPlanFor(edited({ estado: 'Confirmado', precio: 8 }))?.input).toEqual({
      tracker: 'vuelos',
      rowId: ROW,
      values: { estado: 'Confirmado', precio: 8 },
    });
  });

  it('archivar una vista se restaura; crear una vista se archiva', () => {
    expect(
      undoPlanFor(
        ev({
          tool_id: 'views.archive',
          detail: { input: { view: 'ventas' }, result: { archived: true } },
        }),
      ),
    ).toMatchObject({ toolId: 'views.restore', input: { view: 'ventas' } });
    expect(
      undoPlanFor(
        ev({
          tool_id: 'views.create',
          detail: { input: { name: 'V' }, result: { view: { slug: 'v' } } },
        }),
      ),
    ).toMatchObject({ toolId: 'views.archive', input: { view: 'v' } });
  });

  it('nada irreversible se ofrece: correos, fallos, o sin datos', () => {
    expect(undoPlanFor(ev({}))).toBeNull();
    expect(undoPlanFor({ ...rowCreated('a'), status: 'error' })).toBeNull();
    expect(undoPlanFor(ev({ tool_id: 'trackers.upsert' }))).toBeNull();
  });

  it('rechaza referencias raras en vez de reinyectarlas', () => {
    const bad = ev({
      tool_id: 'trackers.upsert',
      detail: { input: { tracker: 'a b;drop' }, result: { created: true, row: { id: ROW } } },
    });
    expect(undoPlanFor(bad)).toBeNull();
    expect(canUndo(rowCreated('a'), new Set())).toBe(true);
    expect(canUndo(rowCreated('a'), new Set(['a']))).toBe(false);
  });
});

describe('permisos de /actividad', () => {
  // Un constructor de consultas falso que sólo anota los filtros que le ponen.
  function fakeQuery() {
    const calls: Array<[string, ...unknown[]]> = [];
    const q = {
      calls,
      eq(c: string, v: unknown) {
        calls.push(['eq', c, v]);
        return q;
      },
      in(c: string, v: unknown[]) {
        calls.push(['in', c, v]);
        return q;
      },
      or(f: string) {
        calls.push(['or', f]);
        return q;
      },
    };
    return q;
  }

  it('quien administra ve toda la empresa: ningún filtro por usuario', () => {
    const q = applyActivityScope(fakeQuery(), { id: 'u1', isManager: true });
    expect(q.calls).toEqual([]);
  });

  it('cualquier otra persona queda acotada a su propio usuario en la consulta', () => {
    const q = applyActivityScope(fakeQuery(), { id: 'u1', isManager: false });
    expect(q.calls).toEqual([['eq', 'user_id', 'u1']]);
  });

  it('el predicado dice lo mismo que la consulta', () => {
    expect(canSeeEvent({ id: 'u1', isManager: false }, { user_id: 'u1' })).toBe(true);
    expect(canSeeEvent({ id: 'u1', isManager: false }, { user_id: 'u2' })).toBe(false);
    expect(canSeeEvent({ id: 'u1', isManager: true }, { user_id: 'u2' })).toBe(true);
  });

  it('los filtros: solo, aprobado, errores', () => {
    expect(applyActivityFilter(fakeQuery(), 'auto').calls).toEqual([
      ['in', 'status', ['ok', 'error']],
      ['or', 'decision.eq.delegated,surface.eq.schedule'],
    ]);
    expect(applyActivityFilter(fakeQuery(), 'approved').calls).toContainEqual([
      'eq',
      'decision',
      'confirmed',
    ]);
    expect(applyActivityFilter(fakeQuery(), 'errors').calls).toEqual([['eq', 'status', 'error']]);
    expect(applyActivityFilter(fakeQuery(), 'all').calls).toEqual([
      ['in', 'status', ['ok', 'error']],
    ]);
    expect(parseActivityFilter('auto')).toBe('auto');
    expect(parseActivityFilter('raro')).toBe('all');
  });
});
