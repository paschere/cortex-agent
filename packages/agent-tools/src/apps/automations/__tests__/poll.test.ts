import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { buildAskUserPrompt, describeRow, writableFields } from '../ask';
import { DEFAULT_AUTOMATION_LIMITS, MAX_AUTOMATION_LIMITS, resolveLimits } from '../engine';
import {
  type PollRow,
  inPollWindow,
  pollDue,
  pollSlotIndex,
  pollSlotStart,
  rowInstant,
  rowSlotVersion,
  selectPollRows,
} from '../poll';
import { queuePollRound } from '../poll-run';
import { automationInputSchema, structuralProblems } from '../spec';

const fields = [
  { key: 'vuelo', label: 'Vuelo', type: 'text' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'hora', label: 'Hora', type: 'time' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    options: ['Programado', 'En vuelo', 'Aterrizó'],
  },
];
const catalog = { slug: 'vuelos', name: 'Vuelos', fields } as never;
// 12:00 en Bogotá = 17:00Z
const NOW = new Date('2026-10-07T17:00:00.000Z');

function row(
  id: string,
  values: Record<string, string>,
  updated = '2026-10-07T10:00:00Z',
): PollRow {
  return { id, label: id, values, created_at: updated, updated_at: updated };
}

describe('franjas de «cada X minutos»', () => {
  it('la franja empieza en múltiplos y no se repite', () => {
    expect(pollSlotStart(20, new Date('2026-10-07T17:13:00Z')).toISOString()).toBe(
      '2026-10-07T17:00:00.000Z',
    );
    expect(pollDue(20, null, NOW)?.toISOString()).toBe('2026-10-07T17:00:00.000Z');
    expect(
      pollDue(20, new Date('2026-10-07T17:00:00Z'), new Date('2026-10-07T17:19:00Z')),
    ).toBeNull();
    expect(
      pollDue(20, new Date('2026-10-07T17:00:00Z'), new Date('2026-10-07T17:20:00Z')),
    ).not.toBeNull();
  });
  it('la frecuencia por fila es otra franja, estable dentro de ella', () => {
    expect(rowSlotVersion(60, new Date('2026-10-07T17:05:00Z'))).toBe(
      rowSlotVersion(60, new Date('2026-10-07T17:55:00Z')),
    );
    expect(rowSlotVersion(60, new Date('2026-10-07T17:55:00Z'))).not.toBe(
      rowSlotVersion(60, new Date('2026-10-07T18:01:00Z')),
    );
  });
});

describe('ventana de fechas', () => {
  it('entiende fecha, fecha + hora y zonas', () => {
    expect(rowInstant({ f: '2026-10-07' }, 'f')?.toISOString()).toBe('2026-10-07T05:00:00.000Z');
    expect(rowInstant({ f: '2026-10-07', h: '14:30' }, 'f', 'h')?.toISOString()).toBe(
      '2026-10-07T19:30:00.000Z',
    );
    expect(rowInstant({ f: '2026-10-07 14:30' }, 'f')?.toISOString()).toBe(
      '2026-10-07T19:30:00.000Z',
    );
    expect(rowInstant({ f: '2026-10-07T14:30Z' }, 'f')?.toISOString()).toBe(
      '2026-10-07T14:30:00.000Z',
    );
    expect(rowInstant({ f: 'mañana' }, 'f')).toBeNull();
    expect(rowInstant({}, 'f')).toBeNull();
  });
  it('de 6 h antes a 24 h después de la hora de la fila', () => {
    const w = { field: 'fecha', timeField: 'hora', beforeHours: 6, afterHours: 24 };
    // Vuelo a las 20:00 Bogotá (01:00Z del 8): ahora (17:00Z) falta 8 h → fuera.
    expect(inPollWindow({ fecha: '2026-10-07', hora: '20:00' }, w, NOW)).toBe(false);
    // Vuelo a las 16:00 Bogotá: falta 4 h → dentro.
    expect(inPollWindow({ fecha: '2026-10-07', hora: '16:00' }, w, NOW)).toBe(true);
    // Vuelo de ayer 10:00 (hace 26 h) → fuera; de ayer 14:00 (hace 22 h) → dentro.
    expect(inPollWindow({ fecha: '2026-10-06', hora: '10:00' }, w, NOW)).toBe(false);
    expect(inPollWindow({ fecha: '2026-10-06', hora: '14:00' }, w, NOW)).toBe(true);
    // Sin fecha legible no se atiende; sin ventana siempre.
    expect(inPollWindow({}, w, NOW)).toBe(false);
    expect(inPollWindow({}, undefined, NOW)).toBe(true);
  });
});

describe('qué filas toca atender', () => {
  const conditions = [
    { field: 'vuelo', op: 'not_empty' },
    { field: 'estado', op: 'neq', value: 'Aterrizó' },
  ] as never;
  const base = {
    conditions,
    tracker: catalog,
    alreadyQueued: new Set<string>(),
    maxRows: 10,
    slotIndex: 0,
    now: NOW,
  };
  const win = { field: 'fecha', beforeHours: 6, afterHours: 24 };

  it('sólo las que cumplen condiciones y ventana', () => {
    const rows = [
      row('a', { vuelo: 'AV9', fecha: '2026-10-07', estado: 'Programado' }),
      row('b', { vuelo: '', fecha: '2026-10-07', estado: 'Programado' }),
      row('c', { vuelo: 'LA5', fecha: '2026-10-07', estado: 'Aterrizó' }),
      row('d', { vuelo: 'CM7', fecha: '2026-10-20', estado: 'Programado' }),
    ];
    const out = selectPollRows({ ...base, rows, window: win });
    expect(out.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('respeta la frecuencia por fila (ya encoladas no entran)', () => {
    const rows = [
      row('a', { vuelo: 'AV9', fecha: '2026-10-07', estado: 'Programado' }),
      row('b', { vuelo: 'LA5', fecha: '2026-10-07', estado: 'Programado' }),
    ];
    const out = selectPollRows({ ...base, rows, window: win, alreadyQueued: new Set(['a']) });
    expect(out.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('el tope de filas rota para que todas tengan turno', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      row(id, { vuelo: id, fecha: '2026-10-07', estado: 'Programado' }),
    );
    const seen = new Set<string>();
    for (let slot = 0; slot < 3; slot++) {
      const out = selectPollRows({ ...base, rows, window: win, maxRows: 2, slotIndex: slot });
      expect(out.rows).toHaveLength(2);
      expect(out.overflow).toBe(3);
      for (const r of out.rows) seen.add(r.id);
    }
    expect(seen.size).toBe(5);
  });
});

describe('vuelta contra la base', () => {
  const rule = (extra = {}) => ({
    id: 'auto-p',
    organization_id: 'org-a',
    app_id: 'app-a',
    name: 'Seguir vuelos',
    enabled: true,
    trigger: {
      type: 'rows_poll',
      tracker: 'vuelos',
      everyMinutes: 20,
      maxRows: 10,
      window: { field: 'fecha', beforeHours: 6, afterHours: 24 },
    },
    conditions: [{ field: 'estado', op: 'neq', value: 'Aterrizó' }],
    actions: [{ type: 'ask_cortex', instruction: 'Busca el vuelo {{vuelo}}' }],
    tracker_id: 't-v',
    trigger_kind: 'rows_poll',
    schedule_last_slot: null as string | null,
    ...extra,
  });
  function world() {
    const tables = {
      trackers: [
        {
          id: 't-v',
          organization_id: 'org-a',
          slug: 'vuelos',
          name: 'Vuelos',
          description: '',
          fields,
          created_by: null,
          created_at: '',
          updated_at: '',
        },
        {
          id: 't-x',
          organization_id: 'org-b',
          slug: 'vuelos',
          name: 'Vuelos',
          description: '',
          fields,
          created_by: null,
          created_at: '',
          updated_at: '',
        },
      ],
      tracker_rows: [
        {
          id: 'r1',
          organization_id: 'org-a',
          tracker_id: 't-v',
          label: 'AV9',
          values: { vuelo: 'AV9', fecha: '2026-10-07', estado: 'Programado' },
          created_at: '',
          updated_at: '',
        },
        {
          id: 'r2',
          organization_id: 'org-a',
          tracker_id: 't-v',
          label: 'LA5',
          values: { vuelo: 'LA5', fecha: '2026-10-07', estado: 'Aterrizó' },
          created_at: '',
          updated_at: '',
        },
        {
          id: 'rx',
          organization_id: 'org-b',
          tracker_id: 't-x',
          label: 'XX1',
          values: { vuelo: 'XX1', fecha: '2026-10-07', estado: 'Programado' },
          created_at: '',
          updated_at: '',
        },
      ],
      custom_app_automations: [rule()],
      custom_app_automation_runs: [] as Array<Record<string, unknown>>,
    } as Record<string, Array<Record<string, unknown>>>;
    const fake = createFakeSupabase(tables);
    return { tables, db: createOrgScopedClient(fake.client, 'org-a') };
  }
  const input = (r: ReturnType<typeof rule>) => ({
    id: r.id,
    app_id: r.app_id,
    trigger: r.trigger,
    conditions: r.conditions as never,
    schedule_last_slot: r.schedule_last_slot,
  });

  it('encola una corrida por fila elegida, sólo de su empresa, y una vez por franja', async () => {
    const { db, tables } = world();
    const out = await queuePollRound(db, input(rule()), NOW);
    expect(out).toMatchObject({ queued: 1, claimed: true });
    const runs = tables.custom_app_automation_runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger_ref).toBe('poll:r1');
    // La franja quedó reclamada: otra vuelta del reloj en la misma franja no hace nada.
    const slot = (tables.custom_app_automations ?? [])[0]?.schedule_last_slot as string;
    expect(slot).toBeTruthy();
    const again = await queuePollRound(db, input(rule({ schedule_last_slot: slot })), NOW);
    expect(again.claimed).toBe(false);
    expect(runs).toHaveLength(1);
  });

  it('la frecuencia por fila: en la franja siguiente no repite si perRowMinutes es mayor', async () => {
    const { db, tables } = world();
    const r = rule({
      trigger: {
        type: 'rows_poll',
        tracker: 'vuelos',
        everyMinutes: 20,
        perRowMinutes: 60,
        maxRows: 10,
      },
    });
    (tables.custom_app_automations ?? [])[0] = r;
    await queuePollRound(db, input(r), new Date('2026-10-07T17:00:00Z'));
    const slot = (tables.custom_app_automations ?? [])[0]?.schedule_last_slot as string;
    // Creado "ahora": la corrida del fake lleva created_at; simulamos la hora de la corrida.
    for (const run of tables.custom_app_automation_runs ?? [])
      run.created_at = '2026-10-07T17:00:00Z';
    const second = await queuePollRound(
      db,
      input({ ...r, schedule_last_slot: slot }),
      new Date('2026-10-07T17:20:00Z'),
    );
    expect(second.queued).toBe(0);
    for (const run of tables.custom_app_automation_runs ?? [])
      run.created_at = '2026-10-07T17:00:00Z';
    const later = await queuePollRound(
      db,
      input({
        ...r,
        schedule_last_slot: (tables.custom_app_automations ?? [])[0]?.schedule_last_slot as string,
      }),
      new Date('2026-10-07T18:00:00Z'),
    );
    expect(later.queued).toBe(1);
  });
});

describe('la gramática', () => {
  const base = {
    name: 'Seguir vuelos',
    trigger: { type: 'rows_poll', tracker: 'vuelos', everyMinutes: 20 },
    actions: [{ type: 'ask_cortex', instruction: 'x', writes: ['estado'] }],
  };
  it('acepta lo válido y aplica los valores por defecto', () => {
    const p = automationInputSchema.parse(base);
    expect(p.trigger).toMatchObject({ type: 'rows_poll', maxRows: 10 });
    expect(structuralProblems(p)).toEqual([]);
  });
  it('rechaza menos de 10 minutos y más de 25 filas', () => {
    expect(
      automationInputSchema.safeParse({ ...base, trigger: { ...base.trigger, everyMinutes: 5 } })
        .success,
    ).toBe(false);
    expect(
      automationInputSchema.safeParse({ ...base, trigger: { ...base.trigger, maxRows: 26 } })
        .success,
    ).toBe(false);
  });
  it('la frecuencia por fila no puede ser menor que la vuelta', () => {
    const p = automationInputSchema.parse({
      ...base,
      trigger: { ...base.trigger, perRowMinutes: 10 },
    });
    expect(structuralProblems(p).join(' ')).toContain('frecuencia por fila');
  });
  it('escribir en la fila exige una fila', () => {
    const p = automationInputSchema.parse({
      ...base,
      trigger: { type: 'schedule', cadence: 'daily', hour: 7 },
    });
    expect(structuralProblems(p).join(' ')).toContain('necesita una fila');
  });
});

describe('topes configurables', () => {
  it('por defecto, acotados a los máximos y sin valores raros', () => {
    expect(resolveLimits({})).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(resolveLimits(null)).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(resolveLimits({ runsPerDay: 50, askCortexPerDay: 7 })).toEqual({
      runsPerDay: 50,
      askCortexPerDay: 7,
    });
    expect(resolveLimits({ runsPerDay: 99999999, askCortexPerDay: -3 })).toEqual({
      runsPerDay: MAX_AUTOMATION_LIMITS.runsPerDay,
      askCortexPerDay: DEFAULT_AUTOMATION_LIMITS.askCortexPerDay,
    });
  });
});

describe('el armado de la instrucción para Cortex', () => {
  const info = [
    { key: 'vuelo', label: 'Vuelo' },
    { key: 'fecha', label: 'Fecha' },
    { key: 'estado', label: 'Estado' },
  ];
  const ctx = { after: { vuelo: 'AV9', fecha: '2026-10-07' }, labels: { vuelo: 'Vuelo' } };
  it('pinta las variables, describe la fila y declara los campos escribibles', () => {
    const text = buildAskUserPrompt({
      instruction: 'Busca el estado del vuelo {{vuelo}} del {{Fecha}}',
      ctx,
      trackerSlug: 'vuelos',
      rowId: 'r1',
      fields: info,
      writes: ['estado', 'campo_que_no_existe'],
      today: '2026-10-07',
    });
    expect(text).toContain('Busca el estado del vuelo AV9 del');
    expect(text).toContain('- Vuelo (vuelo): AV9');
    expect(text).toContain('- Estado (estado): (vacío)');
    expect(text).toContain('rowId r1');
    expect(text).toContain('SÓLO en estos campos: estado.');
    expect(text).not.toContain('campo_que_no_existe');
    expect(text).toContain('2026-10-07');
  });
  it('«row» permite todos los campos; sin writes queda el permiso de siempre', () => {
    expect([...(writableFields('row', info) as Set<string>)]).toEqual(['vuelo', 'fecha', 'estado']);
    expect(writableFields(undefined, info)).toBe('legacy');
    const legacy = buildAskUserPrompt({
      instruction: 'x',
      ctx,
      trackerSlug: 'vuelos',
      rowId: 'r1',
      fields: info,
      writes: undefined,
      today: '2026-10-07',
    });
    expect(legacy).toContain('Puedes escribir en la tabla «vuelos»');
  });
  it('sin campos permitidos no se escribe', () => {
    const t = buildAskUserPrompt({
      instruction: 'x',
      ctx,
      trackerSlug: 'vuelos',
      rowId: 'r1',
      fields: info,
      writes: ['nada'],
      today: '2026-10-07',
    });
    expect(t).toContain('No tienes permiso de escribir en la fila');
  });
  it('una fila larga se recorta', () => {
    expect(describeRow({ vuelo: 'x'.repeat(900) }, info)).toContain('x'.repeat(400));
    expect(describeRow({ vuelo: 'x'.repeat(900) }, info)).not.toContain('x'.repeat(401));
  });
});

describe('índice de franja', () => {
  it('avanza cada X minutos', () => {
    expect(pollSlotIndex(20, new Date('2026-10-07T17:20:00Z'))).toBe(
      pollSlotIndex(20, new Date('2026-10-07T17:00:00Z')) + 1,
    );
  });
});
