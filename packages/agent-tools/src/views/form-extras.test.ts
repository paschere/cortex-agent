import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView } from './compute';
import {
  EDIT_MESSAGES,
  canEditSubmission,
  editDeadline,
  editWindowOpen,
  isPendingReview,
  reviewPatch,
  sameToken,
  stepErrors,
  stepFields,
  visibleSteps,
} from './form-extras';
import {
  APPROVE_ACTION_ID,
  type CatalogTracker,
  REJECT_ACTION_ID,
  approvalFor,
  checkSpecAgainst,
  editWindowOf,
  specWrites,
  viewSpecSchema,
} from './spec';

const tracker: CatalogTracker = {
  slug: 'novedades',
  name: 'Novedades',
  fields: [
    { key: 'titulo', label: 'Título', type: 'text', required: true },
    { key: 'foto', label: 'Foto', type: 'file', required: false },
    { key: 'donde', label: 'Dónde', type: 'location', required: false },
    { key: 'sede', label: 'Sede', type: 'relation', required: false, tracker: 'sedes' },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Por revisar', 'Aprobado', 'Rechazado'],
    },
    { key: 'motivo', label: 'Motivo', type: 'longtext', required: false },
  ],
};

const form = {
  id: 'f',
  type: 'form',
  title: 'Reportar',
  tracker: 'novedades',
  fields: ['titulo', 'foto', 'donde'],
  approval: {
    field: 'estado',
    pending: 'Por revisar',
    approved: 'Aprobado',
    rejected: 'Rechazado',
    notesField: 'motivo',
  },
  steps: [
    { title: 'Qué pasó', fields: ['titulo'] },
    { title: 'Evidencia', fields: ['foto', 'donde'] },
  ],
};
const table = {
  id: 't',
  type: 'table',
  title: 'Novedades',
  tracker: 'novedades',
  columns: ['titulo', 'foto', 'donde', 'estado'],
};

const FILE = JSON.stringify({
  url: '/api/files/blob/abc',
  name: 'a.jpg',
  mime: 'image/jpeg',
  size: 9,
});
const sources = new Map<string, ViewSource>([
  [
    'novedades',
    {
      tracker,
      truncated: false,
      rows: [
        {
          id: 'r1',
          label: 'Fuga',
          values: { titulo: 'Fuga', foto: FILE, donde: '4.7,-74.07', estado: 'Por revisar' },
          created_at: '2026-10-01T10:00:00Z',
          updated_at: '2026-10-01T10:00:00Z',
        },
        {
          id: 'r2',
          label: 'Ruido',
          values: { titulo: 'Ruido', estado: 'Aprobado' },
          created_at: '2026-10-01T11:00:00Z',
          updated_at: '2026-10-01T11:00:00Z',
        },
      ],
    },
  ],
]);

describe('ventana para corregir', () => {
  const at = '2026-10-05T10:00:00Z';
  it('abierta dentro de N minutos y cerrada después', () => {
    expect(editWindowOpen(at, 10, new Date('2026-10-05T10:09:59Z'))).toBe(true);
    expect(editWindowOpen(at, 10, new Date('2026-10-05T10:10:00Z'))).toBe(false);
  });
  it('0 minutos = no se corrige', () => {
    expect(editWindowOpen(at, 0, new Date('2026-10-05T10:00:01Z'))).toBe(false);
    expect(editDeadline(at, 0)).toBeNull();
    expect(editDeadline(at, 5)).toBe('2026-10-05T10:05:00.000Z');
  });
  it('sin valor en el spec son 10 minutos', () => {
    expect(editWindowOf({})).toBe(10);
    expect(editWindowOf({ editWindowMinutes: 0 })).toBe(0);
  });
  it('valida quién: el mismo usuario o el token, y la ventana', () => {
    const sub = { created_at: at, submitted_by: 'u1', edit_token: 'tok-1234567890abcdef' };
    const now = new Date('2026-10-05T10:03:00Z');
    expect(
      canEditSubmission({ submission: sub, minutes: 10, actor: 'u1', token: null, now }).ok,
    ).toBe(true);
    expect(
      canEditSubmission({ submission: sub, minutes: 10, actor: 'u2', token: null, now }),
    ).toEqual({ ok: false, reason: 'who' });
    const pub = { ...sub, submitted_by: null };
    expect(
      canEditSubmission({
        submission: pub,
        minutes: 10,
        actor: null,
        token: 'tok-1234567890abcdef',
        now,
      }).ok,
    ).toBe(true);
    expect(
      canEditSubmission({
        submission: pub,
        minutes: 10,
        actor: null,
        token: 'tok-1234567890abcdeX',
        now,
      }),
    ).toEqual({ ok: false, reason: 'who' });
    expect(
      canEditSubmission({ submission: pub, minutes: 10, actor: null, token: null, now }),
    ).toEqual({ ok: false, reason: 'who' });
    expect(
      canEditSubmission({
        submission: pub,
        minutes: 10,
        actor: null,
        token: 'tok-1234567890abcdef',
        now: new Date('2026-10-05T10:11:00Z'),
      }),
    ).toEqual({ ok: false, reason: 'window' });
    expect(EDIT_MESSAGES.window).toMatch(/tiempo/);
  });
  it('compara tokens sin aceptar vacíos', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('', '')).toBe(false);
    expect(sameToken(null, 'x')).toBe(false);
  });
});

describe('aprobación', () => {
  const spec = viewSpecSchema.parse({ version: 1, editing: 'team', blocks: [form, table] });
  const approval = approvalFor(spec, 'novedades')?.approval;
  it('el spec trae el estado y la decisión escribe lo del spec', () => {
    expect(approval?.pending).toBe('Por revisar');
    if (!approval) return;
    expect(reviewPatch(approval, 'approve', 'ignorado')).toEqual({ estado: 'Aprobado' });
    expect(reviewPatch(approval, 'reject', '  Foto borrosa ')).toEqual({
      estado: 'Rechazado',
      motivo: 'Foto borrosa',
    });
    expect(reviewPatch(approval, 'reject', '')).toEqual({ estado: 'Rechazado' });
    expect(isPendingReview(approval, { estado: 'Por revisar' })).toBe(true);
    expect(isPendingReview(approval, { estado: 'Aprobado' })).toBe(false);
  });
  it('exige un select con las tres opciones y escribir en la vista', () => {
    expect(checkSpecAgainst(spec, [tracker])).toEqual([]);
    const bad = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [{ ...form, approval: { ...form.approval, approved: 'Listo' } }],
    });
    expect(checkSpecAgainst(bad, [tracker]).join(' ')).toMatch(/«Listo»/);
    const notSelect = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [{ ...form, approval: { ...form.approval, field: 'titulo' } }],
    });
    expect(checkSpecAgainst(notSelect, [tracker]).join(' ')).toMatch(/select/);
    const off = viewSpecSchema.parse({ version: 1, blocks: [form] });
    expect(specWrites(off)).toBe(true);
    expect(checkSpecAgainst(off, [tracker]).join(' ')).toMatch(/editing/);
  });
  it('Aprobar / Rechazar salen sólo con quien escribe y sólo en las filas pendientes', () => {
    const view = computeView(spec, sources, new Date('2026-10-05T12:00:00Z'), { writable: true });
    const t = view.blocks.find((b) => b.type === 'table');
    if (t?.type !== 'table') throw new Error('sin tabla');
    const ids = t.actions.map((a) => a.id);
    expect(ids).toEqual([APPROVE_ACTION_ID, REJECT_ACTION_ID]);
    expect(t.actions[0]?.rowIds).toEqual(['r1']);
    expect(t.actions[1]?.askReason).toBe(true);
    const readOnly = computeView(spec, sources, new Date('2026-10-05T12:00:00Z'), {
      writable: false,
    });
    const t2 = readOnly.blocks.find((b) => b.type === 'table');
    expect(t2?.type === 'table' && t2.actions).toEqual([]);
  });
  it('el formulario no pide el campo de estado: lo pone el servidor', () => {
    const view = computeView(spec, sources, new Date('2026-10-05T12:00:00Z'), { writable: true });
    const f = view.blocks.find((b) => b.type === 'form');
    if (f?.type !== 'form') throw new Error('sin form');
    expect(f.fields.map((x) => x.key)).toEqual(['titulo', 'foto', 'donde']);
    expect(f.steps?.length).toBe(2);
    expect(f.editWindowMinutes).toBe(10);
  });
});

describe('pasos', () => {
  const steps = [
    { title: 'A', fields: ['x', 'y'] },
    { title: 'B', fields: ['z', 'ya_no_existe'] },
  ];
  it('agrupa, descarta lo que no existe y manda lo suelto a «Otros datos»', () => {
    expect(stepFields(steps, ['x', 'y', 'z', 'w'])).toEqual([
      { title: 'A', fields: ['x', 'y'] },
      { title: 'B', fields: ['z'] },
      { title: 'Otros datos', fields: ['w'] },
    ]);
  });
  it('un campo en dos pasos sólo cuenta en el primero', () => {
    expect(
      stepFields(
        [
          { title: 'A', fields: ['x'] },
          { title: 'B', fields: ['x', 'y'] },
        ],
        ['x', 'y'],
      ),
    ).toEqual([
      { title: 'A', fields: ['x'] },
      { title: 'B', fields: ['y'] },
    ]);
  });
  it('valida un paso con sus campos visibles y se salta pasos sin visibles', () => {
    const errors = { x: 'Falta x', z: 'Falta z' };
    expect(stepErrors({ fields: ['x', 'y'] }, new Set(['x', 'y']), errors)).toEqual({
      x: 'Falta x',
    });
    expect(stepErrors({ fields: ['x'] }, new Set(), errors)).toEqual({});
    expect(visibleSteps([{ fields: ['x'] }, { fields: ['z'] }], new Set(['z']))).toEqual([
      { fields: ['z'] },
    ]);
  });
  it('un paso no puede nombrar un campo que el formulario no pide ni repetirlo', () => {
    const bad = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [
        {
          ...form,
          approval: undefined,
          steps: [
            { title: 'A', fields: ['titulo'] },
            { title: 'B', fields: ['titulo', 'estado'] },
          ],
        },
      ],
    });
    const out = checkSpecAgainst(bad, [tracker]).join(' ');
    expect(out).toMatch(/«estado», que el formulario no pide/);
    expect(out).toMatch(/«titulo» está en dos pasos/);
  });
  it('máximo 10 pasos', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ title: `P${i}`, fields: ['titulo'] }));
    expect(
      viewSpecSchema.safeParse({ version: 1, blocks: [{ ...form, steps: many }] }).success,
    ).toBe(false);
  });
  it('sin steps el formulario es el de siempre', () => {
    const plain = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'f', type: 'form', title: 'F', tracker: 'novedades' }],
    });
    const view = computeView(plain, sources, new Date('2026-10-05T12:00:00Z'));
    const f = view.blocks[0];
    expect(f?.type === 'form' && f.steps).toBeFalsy();
  });
});

describe('fotos y mapas en tablas y tarjetas', () => {
  const spec = viewSpecSchema.parse({
    version: 1,
    blocks: [
      table,
      {
        id: 'g',
        type: 'gallery',
        title: 'G',
        tracker: 'novedades',
        titleField: 'titulo',
        metaFields: ['foto', 'donde', 'estado'],
      },
    ],
  });
  const view = computeView(spec, sources, new Date('2026-10-05T12:00:00Z'));
  it('la tabla marca las columnas file y location y deja el valor crudo', () => {
    const t = view.blocks[0];
    if (t?.type !== 'table') throw new Error('sin tabla');
    expect(t.columns.map((c) => c.rich ?? null)).toEqual([null, 'file', 'location', null]);
    expect(t.rows[0]?.sort[1]).toBe(FILE);
    expect(t.rows[0]?.cells[1]).toBe('a.jpg');
  });
  it('las tarjetas traen kind y raw sólo donde hace falta', () => {
    const g = view.blocks[1];
    if (g?.type !== 'gallery') throw new Error('sin galería');
    const meta = g.cards[0]?.meta ?? [];
    expect(meta[0]).toMatchObject({ kind: 'file', raw: FILE });
    expect(meta[1]).toMatchObject({ kind: 'location', raw: '4.7,-74.07' });
    expect(meta[2]?.kind).toBeUndefined();
  });
});
