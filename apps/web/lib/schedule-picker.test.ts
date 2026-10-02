import { expect, describe as group, it } from 'vitest';
import {
  DEFAULT_PICKER,
  HOUR_STEPS,
  type SchedulePicker,
  cronToPicker,
  describe,
  describeCron,
  describeDraft,
  draftFromSchedule,
  formatRun,
  formatTime12,
  nextRuns,
  nextRunsForDraft,
  nextRunsForPicker,
  onceToRunAt,
  parseCronSpec,
  pickerToCron,
  resolveDraft,
  runAtToPicker,
  searchTimezones,
  tzLabel,
  withPicker,
  withRawCron,
  zonedToUtc,
} from './schedule-picker';

const p = (over: Partial<SchedulePicker>): SchedulePicker => ({ ...DEFAULT_PICKER, ...over });
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

group('pickerToCron', () => {
  it('builds each mode', () => {
    expect(pickerToCron(p({ mode: 'daily', time: '09:00' }))).toBe('0 9 * * *');
    expect(pickerToCron(p({ mode: 'weekdays', time: '08:30' }))).toBe('30 8 * * 1-5');
    expect(pickerToCron(p({ mode: 'days', time: '07:05', days: [5, 1, 3] }))).toBe('5 7 * * 1,3,5');
    expect(pickerToCron(p({ mode: 'weekly', time: '18:00', weekday: 0 }))).toBe('0 18 * * 0');
    expect(pickerToCron(p({ mode: 'monthly', time: '06:00', monthDay: 1 }))).toBe('0 6 1 * *');
    expect(pickerToCron(p({ mode: 'hourly', time: '00:15', everyHours: 2 }))).toBe('15 */2 * * *');
    expect(pickerToCron(p({ mode: 'hourly', time: '00:00', everyHours: 1 }))).toBe('0 * * * *');
  });

  it('returns null for once and for incomplete pickers', () => {
    expect(pickerToCron(p({ mode: 'once', date: '2026-10-10' }))).toBeNull();
    expect(pickerToCron(p({ mode: 'days', days: [] }))).toBeNull();
    expect(pickerToCron(p({ mode: 'daily', time: '' }))).toBeNull();
    expect(pickerToCron(p({ mode: 'daily', time: '24:00' }))).toBeNull();
    expect(pickerToCron(p({ mode: 'monthly', monthDay: 0 }))).toBeNull();
    expect(pickerToCron(p({ mode: 'monthly', monthDay: 32 }))).toBeNull();
    expect(pickerToCron(p({ mode: 'hourly', everyHours: 5 }))).toBeNull();
    expect(pickerToCron(p({ mode: 'weekly', weekday: 7 }))).toBeNull();
  });

  it('dedupes chip days and collapses all seven to daily', () => {
    expect(pickerToCron(p({ mode: 'days', days: [3, 3, 1] }))).toBe('0 9 * * 1,3');
    expect(pickerToCron(p({ mode: 'days', days: [0, 1, 2, 3, 4, 5, 6] }))).toBe('0 9 * * *');
  });
});

group('cronToPicker', () => {
  it('reads the common shapes', () => {
    expect(cronToPicker('0 9 * * *')).toMatchObject({ mode: 'daily', time: '09:00' });
    expect(cronToPicker('30 8 * * 1-5')).toMatchObject({ mode: 'weekdays', time: '08:30' });
    expect(cronToPicker('0 8 * * MON-FRI')).toMatchObject({ mode: 'weekdays' });
    expect(cronToPicker('0 8 * * 1,2,3,4,5')).toMatchObject({ mode: 'weekdays' });
    expect(cronToPicker('0 9 * * 1,3,5')).toMatchObject({ mode: 'days', days: [1, 3, 5] });
    expect(cronToPicker('0 9 * * 2')).toMatchObject({ mode: 'weekly', weekday: 2 });
    expect(cronToPicker('0 9 * * 7')).toMatchObject({ mode: 'weekly', weekday: 0 });
    expect(cronToPicker('0 9 * * sun')).toMatchObject({ mode: 'weekly', weekday: 0 });
    expect(cronToPicker('0 9 * * 0-6')).toMatchObject({ mode: 'daily' });
    expect(cronToPicker('0 6 1 * *')).toMatchObject({ mode: 'monthly', monthDay: 1 });
    expect(cronToPicker('0 6 31 * ?')).toMatchObject({ mode: 'monthly', monthDay: 31 });
    expect(cronToPicker('15 */2 * * *')).toMatchObject({
      mode: 'hourly',
      everyHours: 2,
      time: '00:15',
    });
    expect(cronToPicker('0 * * * *')).toMatchObject({ mode: 'hourly', everyHours: 1 });
    expect(cronToPicker('0 0-23/6 * * *')).toMatchObject({ mode: 'hourly', everyHours: 6 });
  });

  it('treats 5-7 as Friday through Sunday', () => {
    expect(cronToPicker('0 9 * * 5-7')).toMatchObject({ mode: 'days', days: [0, 5, 6] });
  });

  it('returns null for anything the picker cannot show', () => {
    for (const cron of [
      null,
      '',
      '0 9 * *', // four fields
      '0 9 * * * *', // six fields
      '*/15 * * * *', // every 15 minutes
      '0 9 * 3 *', // only in March
      '0 9,17 * * *', // two hours
      '0 8-17 * * 1-5', // hour range
      '0 */5 * * *', // uneven hour step
      '0 9 1 * 1', // dom AND dow
      '0 9 1,15 * *', // two days of the month
      '0 9 L * *', // last day
      '0 9 * * 1#2', // nth weekday
      '0 25 * * *', // impossible hour
      '61 9 * * *',
      '0 9 * * */2', // stepped dow
    ]) {
      expect(cronToPicker(cron), String(cron)).toBeNull();
    }
  });
});

group('round trips', () => {
  const pickers: SchedulePicker[] = [
    p({ mode: 'daily', time: '00:00' }),
    p({ mode: 'daily', time: '23:59' }),
    p({ mode: 'weekdays', time: '08:00' }),
    p({ mode: 'days', time: '10:30', days: [0, 6] }),
    p({ mode: 'days', time: '10:30', days: [1, 2, 4] }),
    p({ mode: 'weekly', time: '17:45', weekday: 5 }),
    p({ mode: 'monthly', time: '06:00', monthDay: 1 }),
    p({ mode: 'monthly', time: '06:00', monthDay: 31 }),
    ...HOUR_STEPS.map((everyHours) => p({ mode: 'hourly', time: '00:30', everyHours })),
  ];

  it('picker → cron → picker keeps every field the mode uses', () => {
    for (const picker of pickers) {
      const cron = pickerToCron(picker);
      expect(cron, picker.mode).not.toBeNull();
      const back = cronToPicker(cron);
      expect(back?.mode).toBe(picker.mode);
      expect(back?.time).toBe(picker.time);
      if (picker.mode === 'days') expect(back?.days).toEqual(picker.days);
      if (picker.mode === 'weekly') expect(back?.weekday).toBe(picker.weekday);
      if (picker.mode === 'monthly') expect(back?.monthDay).toBe(picker.monthDay);
      if (picker.mode === 'hourly') expect(back?.everyHours).toBe(picker.everyHours);
    }
  });

  it('cron → picker → cron is stable for canonical expressions', () => {
    for (const cron of [
      '0 9 * * *',
      '30 8 * * 1-5',
      '5 7 * * 1,3,5',
      '0 18 * * 0',
      '0 6 1 * *',
      '15 */2 * * *',
      '0 * * * *',
    ]) {
      const picker = cronToPicker(cron);
      expect(picker, cron).not.toBeNull();
      expect(pickerToCron(picker as SchedulePicker)).toBe(cron);
    }
  });

  it('a once picker survives runAt in its own timezone', () => {
    const picker = p({ mode: 'once', date: '2026-12-24', time: '19:30' });
    const runAt = onceToRunAt(picker, 'America/Bogota');
    expect(runAt).toBe('2026-12-25T00:30:00.000Z');
    expect(runAtToPicker(runAt, 'America/Bogota')).toMatchObject({
      mode: 'once',
      date: '2026-12-24',
      time: '19:30',
    });
  });
});

group('describe', () => {
  it('says each mode in Spanish', () => {
    expect(describe(p({ mode: 'daily', time: '09:00' }))).toBe('Todos los días a las 9:00 a. m.');
    expect(describe(p({ mode: 'weekdays', time: '08:00' }))).toBe(
      'De lunes a viernes a las 8:00 a. m.',
    );
    expect(describe(p({ mode: 'days', time: '13:30', days: [0, 1, 3, 6] }))).toBe(
      'Los lunes, miércoles, sábados y domingos a las 1:30 p. m.',
    );
    expect(describe(p({ mode: 'weekly', time: '12:00', weekday: 5 }))).toBe(
      'Cada viernes a las 12:00 p. m.',
    );
    expect(describe(p({ mode: 'monthly', time: '06:00', monthDay: 1 }))).toBe(
      'El día 1 de cada mes a las 6:00 a. m.',
    );
    expect(describe(p({ mode: 'monthly', monthDay: 31 }))).toContain('se saltan');
    expect(describe(p({ mode: 'hourly', time: '00:00', everyHours: 2 }))).toBe(
      'Cada 2 horas, en punto (desde la medianoche)',
    );
    expect(describe(p({ mode: 'hourly', time: '00:15', everyHours: 1 }))).toBe(
      'Cada hora, en el minuto 15',
    );
    expect(describe(p({ mode: 'once', date: '2026-10-02', time: '15:00' }))).toBe(
      'Una sola vez, el viernes 2 de octubre de 2026 a las 3:00 p. m.',
    );
    expect(describe(p({ mode: 'once', date: '' }))).toContain('elige la fecha');
    expect(describe(p({ mode: 'days', days: [] }))).toContain('al menos un día');
  });

  it('formats 12-hour time at the edges', () => {
    expect(formatTime12('00:00')).toBe('12:00 a. m.');
    expect(formatTime12('12:00')).toBe('12:00 p. m.');
    expect(formatTime12('23:05')).toBe('11:05 p. m.');
  });

  it('describeCron falls back gracefully', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('De lunes a viernes a las 9:00 a. m.');
    expect(describeCron('*/15 * * * *')).toBe('Cada 15 minutos');
    expect(describeCron('0 9 * 3 *')).toBe('Expresión cron «0 9 * 3 *»');
    expect(describeCron(null)).toBe('—');
  });
});

group('nextRuns', () => {
  // Friday 2026-10-02, 10:00 in Bogotá (UTC-5, no DST).
  const now = new Date('2026-10-02T15:00:00Z');

  it('weekdays skip the weekend, in local time', () => {
    expect(iso(nextRuns('0 9 * * 1-5', 'America/Bogota', now))).toEqual([
      '2026-10-05T14:00:00.000Z',
      '2026-10-06T14:00:00.000Z',
      '2026-10-07T14:00:00.000Z',
    ]);
  });

  it('still fires later today when the time has not passed', () => {
    expect(iso(nextRuns('30 10 * * *', 'America/Bogota', now, 1))).toEqual([
      '2026-10-02T15:30:00.000Z',
    ]);
    // Exactly now is not "next".
    expect(iso(nextRuns('0 10 * * *', 'America/Bogota', now, 1))).toEqual([
      '2026-10-03T15:00:00.000Z',
    ]);
  });

  it('first of the month', () => {
    expect(iso(nextRuns('0 6 1 * *', 'America/Bogota', now))).toEqual([
      '2026-11-01T11:00:00.000Z',
      '2026-12-01T11:00:00.000Z',
      '2027-01-01T11:00:00.000Z',
    ]);
  });

  it('the 31st skips short months', () => {
    expect(iso(nextRuns('0 6 31 * *', 'UTC', now))).toEqual([
      '2026-10-31T06:00:00.000Z',
      '2026-12-31T06:00:00.000Z',
      '2027-01-31T06:00:00.000Z',
    ]);
  });

  it('every 2 hours', () => {
    expect(iso(nextRuns('0 */2 * * *', 'America/Bogota', now))).toEqual([
      '2026-10-02T17:00:00.000Z', // 12:00 local
      '2026-10-02T19:00:00.000Z',
      '2026-10-02T21:00:00.000Z',
    ]);
  });

  it('crosses midnight and month ends', () => {
    const late = new Date('2026-10-31T23:50:00Z');
    expect(iso(nextRuns('0 * * * *', 'UTC', late, 2))).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T01:00:00.000Z',
    ]);
  });

  it('honours DST: New York 9:00 is 13:00Z in October and 14:00Z in November', () => {
    const runs = iso(nextRuns('0 9 * * 1', 'America/New_York', new Date('2026-10-25T00:00:00Z')));
    expect(runs).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-09T14:00:00.000Z',
    ]);
  });

  it('skips a wall time that does not exist (spring-forward gap)', () => {
    // 2027-03-14 02:30 does not exist in New York.
    const runs = iso(
      nextRuns('30 2 * * *', 'America/New_York', new Date('2027-03-13T12:00:00Z'), 2),
    );
    expect(runs).toEqual(['2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z']);
  });

  it('dom AND dow match either (Vixie rule)', () => {
    // 2026-10: the 15th is a Thursday; Mondays are 5, 12, 19…
    expect(iso(nextRuns('0 0 15 * 1', 'UTC', now, 3))).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
      '2026-10-15T00:00:00.000Z',
    ]);
  });

  it('handles steps, ranges, lists and names', () => {
    expect(parseCronSpec('5/20 8-10 * jan,feb mon-fri')).toMatchObject({
      minutes: [5, 25, 45],
      hours: [8, 9, 10],
    });
    expect(iso(nextRuns('0 12 29 2 *', 'UTC', now, 1))).toEqual(['2028-02-29T12:00:00.000Z']);
  });

  it('returns nothing for impossible or unparsable expressions', () => {
    expect(nextRuns('0 9 31 2 *', 'UTC', now)).toEqual([]);
    expect(nextRuns('0 9 L * *', 'UTC', now)).toEqual([]);
    expect(nextRuns('not a cron', 'UTC', now)).toEqual([]);
    expect(nextRuns('0 9 * * *', 'Mars/Olympus', now)).toEqual([]);
    expect(parseCronSpec('0 24 * * *')).toBeNull();
    expect(parseCronSpec('0 5-3 * * *')).toBeNull();
    expect(parseCronSpec('*/0 * * * *')).toBeNull();
  });

  it('once: only a future instant', () => {
    const future = p({ mode: 'once', date: '2026-10-03', time: '09:00' });
    expect(iso(nextRunsForPicker(future, 'America/Bogota', now))).toEqual([
      '2026-10-03T14:00:00.000Z',
    ]);
    const past = p({ mode: 'once', date: '2026-10-01', time: '09:00' });
    expect(nextRunsForPicker(past, 'America/Bogota', now)).toEqual([]);
    expect(nextRunsForPicker(p({ mode: 'once', date: '' }), 'UTC', now)).toEqual([]);
  });
});

group('timezones', () => {
  it('labels Bogotá as Colombia and falls back to the IANA name', () => {
    expect(tzLabel('America/Bogota')).toBe('Hora de Colombia');
    expect(tzLabel('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(tzLabel('America/Port_of_Spain')).toBe('America/Port of Spain');
  });

  it('searches without accents', () => {
    expect(searchTimezones('mexico').map((z) => z.tz)).toContain('America/Mexico_City');
    expect(searchTimezones('espana').map((z) => z.tz)).toEqual(['Europe/Madrid']);
    expect(searchTimezones('new york').map((z) => z.tz)).toEqual(['America/New_York']);
    expect(searchTimezones('').length).toBeGreaterThan(20);
  });

  it('zonedToUtc converts wall time and rejects DST gaps', () => {
    expect(zonedToUtc(2026, 10, 2, 9, 0, 'America/Bogota')?.toISOString()).toBe(
      '2026-10-02T14:00:00.000Z',
    );
    expect(zonedToUtc(2026, 7, 1, 9, 0, 'Europe/Madrid')?.toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(zonedToUtc(2027, 3, 14, 2, 30, 'America/New_York')).toBeNull();
  });

  it('formatRun reads in the routine zone', () => {
    expect(formatRun(new Date('2026-10-05T14:00:00Z'), 'America/Bogota')).toBe(
      'lun 5 oct, 9:00 a. m.',
    );
  });
});

group('form drafts', () => {
  const now = new Date('2026-10-02T15:00:00Z');

  it('seeds from a saved cron, a saved one-off and nothing at all', () => {
    expect(
      draftFromSchedule({ scheduleKind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' }),
    ).toMatchObject({
      custom: false,
      rawCron: '0 9 * * 1-5',
      timezone: 'UTC',
      picker: { mode: 'weekdays' },
    });
    expect(draftFromSchedule({ scheduleKind: 'cron', cron: '*/15 * * * *' })).toMatchObject({
      custom: true,
      rawCron: '*/15 * * * *',
      timezone: 'America/Bogota',
    });
    expect(
      draftFromSchedule({
        scheduleKind: 'once',
        runAt: '2026-10-03T14:00:00Z',
        timezone: 'America/Bogota',
      }),
    ).toMatchObject({ picker: { mode: 'once', date: '2026-10-03', time: '09:00' } });
    expect(draftFromSchedule({})).toMatchObject({ custom: false, rawCron: '0 9 * * *' });
    expect(draftFromSchedule({ timezone: 'Nope/Nowhere' }).timezone).toBe('America/Bogota');
  });

  it('the advanced field round-trips with the picker', () => {
    let draft = draftFromSchedule({ scheduleKind: 'cron', cron: '0 9 * * *' });
    draft = withRawCron(draft, '30 7 * * 1,3');
    expect(draft).toMatchObject({
      custom: false,
      picker: { mode: 'days', days: [1, 3], time: '07:30' },
    });
    draft = withRawCron(draft, '0 9,17 * * *');
    expect(draft.custom).toBe(true);
    expect(describeDraft(draft)).toBe('Expresión cron «0 9,17 * * *»');
    expect(nextRunsForDraft(draft, now, 2).map((d) => d.toISOString())).toEqual([
      '2026-10-02T22:00:00.000Z',
      '2026-10-03T14:00:00.000Z',
    ]);
    // Touching the picker takes back control and rewrites the raw field.
    draft = withPicker(draft, { ...draft.picker, mode: 'weekdays', time: '08:00' });
    expect(draft).toMatchObject({ custom: false, rawCron: '0 8 * * 1-5' });
    expect(resolveDraft(draft, now)).toEqual({ ok: true, kind: 'cron', cron: '0 8 * * 1-5' });
  });

  it('resolves one-offs and refuses the past', () => {
    const base = draftFromSchedule({ timezone: 'America/Bogota' });
    const future = withPicker(base, p({ mode: 'once', date: '2026-10-03', time: '09:00' }));
    expect(resolveDraft(future, now)).toEqual({
      ok: true,
      kind: 'once',
      runAt: '2026-10-03T14:00:00.000Z',
    });
    const past = withPicker(base, p({ mode: 'once', date: '2026-10-01', time: '09:00' }));
    expect(resolveDraft(past, now)).toMatchObject({ ok: false });
    const blank = withPicker(base, p({ mode: 'once', date: '' }));
    expect(resolveDraft(blank, now)).toMatchObject({ ok: false });
  });

  it('reports incomplete pickers and malformed raw crons in words', () => {
    const base = draftFromSchedule({});
    expect(resolveDraft(withPicker(base, p({ mode: 'days', days: [] })), now)).toEqual({
      ok: false,
      error: 'Elige al menos un día de la semana.',
    });
    expect(resolveDraft(withRawCron(base, '0 9 * *'), now)).toMatchObject({ ok: false });
    expect(resolveDraft(withRawCron(base, '  0   9 * 3   * '), now)).toEqual({
      ok: true,
      kind: 'cron',
      cron: '0 9 * 3 *',
    });
    expect(resolveDraft({ ...base, timezone: 'Bad/Zone' }, now)).toMatchObject({ ok: false });
  });
});
