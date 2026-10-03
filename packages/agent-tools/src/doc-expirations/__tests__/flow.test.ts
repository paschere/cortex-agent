import { beforeEach, describe, expect, it, vi } from 'vitest';

// El modelo, contado. Cada prueba dice qué contesta.
const model = vi.hoisted(() => ({ calls: 0, reply: '{"items":[]}' }));
vi.mock('ai', () => ({
  generateText: vi.fn(async () => {
    model.calls += 1;
    return { text: model.reply };
  }),
}));
vi.mock('../../model', () => ({ UTILITY_MODEL: 'fake-utility', utilityModel: () => ({}) }));

import { type SnapshotExpiration, collectDocumentExpirations } from '../autopilot';
import { backfillDocumentExpirations, detectDocumentExpiration } from '../ingest';
import { confirmExpiration, discardExpiration, queueRenewalUpload, trackExpiration } from '../ops';
import { type World, createWorld } from './fake-db';

const ORG = 'org-a';
const TODAY = '2026-10-03';
const ANA = '00000000-0000-4000-8000-0000000000a1';
const LUIS = '00000000-0000-4000-8000-0000000000b2';
const SHARED = '00000000-0000-4000-8000-00000000c011';
const PERSONAL = '00000000-0000-4000-8000-00000000c022';
const VEHICLE = '00000000-0000-4000-8000-00000000f001';

const SOAT_TEXT = `SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO - SOAT
Póliza No. 1234567890  Aseguradora: Seguros del Estado S.A.
Placa: WGY 482
INICIO DE VIGENCIA 10/05/2026 00:00 FIN DE VIGENCIA 09/05/2027 23:59`;

const SOAT_REPLY = JSON.stringify({
  items: [
    {
      kind: 'soat',
      kindQuote: 'SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO - SOAT',
      subjectKind: 'vehiculo',
      subject: 'WGY482',
      issuer: 'Seguros del Estado S.A.',
      number: '1234567890',
      issuedOn: '2026-05-10',
      issuedQuote: 'INICIO DE VIGENCIA 10/05/2026',
      expiresOn: '2027-05-09',
      expiresQuote: 'FIN DE VIGENCIA 09/05/2027 23:59',
    },
  ],
});

function doc(id: string, collection: string, text: string) {
  return {
    kb_documents: {
      id,
      organization_id: ORG,
      title: `${id}.pdf`,
      collection_id: collection,
      uploaded_by: LUIS,
      status: 'ready',
      created_at: '2026-10-01T10:00:00Z',
    },
    kb_chunks: { id: `${id}-c0`, document_id: id, chunk_index: 0, content: text },
  };
}

function seed(...docs: Array<ReturnType<typeof doc>>) {
  return {
    kb_collections: [
      { id: SHARED, organization_id: ORG, scope: 'global', name: 'Flota' },
      { id: PERSONAL, organization_id: ORG, scope: 'user', name: 'Mío' },
    ],
    kb_documents: docs.map((d) => d.kb_documents),
    kb_chunks: docs.map((d) => d.kb_chunks),
    document_extractions: [],
    vehicles: [
      { id: VEHICLE, organization_id: ORG, user_id: ANA, plate: 'WGY482', archived: false },
    ],
    clients: [],
    users: [
      { id: ANA, organization_id: ORG, name: 'Ana', email: 'ana@x.co' },
      { id: LUIS, organization_id: ORG, name: 'Luis', email: 'luis@x.co' },
    ],
    commitments: [],
    document_expirations: [],
    document_expiration_scans: [],
  };
}

const ctx = { userId: ANA, organizationId: ORG, today: TODAY };
let w: World;

beforeEach(() => {
  model.calls = 0;
  model.reply = SOAT_REPLY;
});

describe('al llegar un documento', () => {
  beforeEach(() => {
    w = createWorld(seed(doc('d-soat', SHARED, SOAT_TEXT)), ORG);
  });

  it('lee el SOAT, lo cuelga del vehículo y lo deja POR REVISAR, a nombre de quien responde por el vehículo', async () => {
    const out = await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    expect(out).toMatchObject({ ok: true, skipped: false, found: 1, modelCalled: true });
    const [row] = w.tables.document_expirations ?? [];
    expect(row).toMatchObject({
      kind: 'soat',
      subject: 'WGY482',
      vehicle_id: VEHICLE,
      owner_user_id: ANA,
      expires_on: '2027-05-09',
      expires_quote: 'FIN DE VIGENCIA 09/05/2027 23:59',
      needs_review: true,
      confidence: 'alta',
      renewal_lead_days: 30,
    });
    // Sin confirmar no hay vencimiento vigilado.
    expect(w.tables.commitments ?? []).toHaveLength(0);
    expect(w.tables.document_expiration_scans?.[0]).toMatchObject({
      outcome: 'found',
      model_called: true,
    });
  });

  it('es idempotente: un documento ya mirado no se vuelve a pagar', async () => {
    await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    const again = await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    expect(again).toMatchObject({ ok: true, skipped: true });
    expect(model.calls).toBe(1);
    expect(w.tables.document_expirations).toHaveLength(1);
  });

  it('con force relee y actualiza la misma fila, sin duplicarla', async () => {
    await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY, force: true });
    expect(model.calls).toBe(2);
    expect(w.tables.document_expirations).toHaveLength(1);
  });

  it('un modelo caído no lanza: queda escrito en el barrido', async () => {
    model.reply = 'not json at all';
    const out = await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    expect(out).toMatchObject({ ok: true, found: 0 });
    expect(w.tables.document_expiration_scans?.[0]?.outcome).toBe('none');
  });
});

describe('lo que no se mira, sin gastar', () => {
  it('un cuaderno personal se salta', async () => {
    w = createWorld(seed(doc('d-mio', PERSONAL, SOAT_TEXT)), ORG);
    const out = await detectDocumentExpiration(w.db, 'd-mio', { today: TODAY });
    expect(out).toMatchObject({ ok: true, skipped: true });
    expect(model.calls).toBe(0);
  });

  it('una factura ya reconocida (0076) no es un papel que vence', async () => {
    const world = seed(doc('d-fac', SHARED, SOAT_TEXT));
    world.document_extractions = [
      { id: 'x', organization_id: ORG, document_id: 'd-fac', doc_type: 'invoice' },
    ] as never;
    w = createWorld(world, ORG);
    const out = await detectDocumentExpiration(w.db, 'd-fac', { today: TODAY });
    expect(out).toMatchObject({ ok: true, found: 0, modelCalled: false });
    expect(model.calls).toBe(0);
  });

  it('un texto sin vigencia no llega al modelo', async () => {
    w = createWorld(seed(doc('d-acta', SHARED, 'Acta del comité, 3 de octubre de 2026.')), ORG);
    await detectDocumentExpiration(w.db, 'd-acta', { today: TODAY });
    expect(model.calls).toBe(0);
    expect(w.tables.document_expiration_scans?.[0]?.outcome).toBe('none');
  });
});

describe('confirmar, renovar, descartar', () => {
  beforeEach(async () => {
    w = createWorld(seed(doc('d-soat', SHARED, SOAT_TEXT)), ORG);
    await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
  });

  const rowId = () => (w.tables.document_expirations?.[0]?.id as string) ?? '';

  it('al confirmar nace su vencimiento: fuente documento, confirmado por la persona, aviso a 30 días', async () => {
    const result = await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    expect(result.action).toBe('created');
    const [c] = w.tables.commitments ?? [];
    expect(c).toMatchObject({
      kind: 'soat',
      due_on: '2027-05-09',
      notice_days: 30,
      vehicle_id: VEHICLE,
      owner_user_id: ANA,
      source_kind: 'document',
      source_quote: 'FIN DE VIGENCIA 09/05/2027 23:59',
      review_state: 'confirmed',
      confirmed_by: ANA,
    });
    expect(result.row.commitment_id).toBe(c?.id);
    expect(result.row.needs_review).toBe(false);
  });

  it('confirmar dos veces no crea dos vencimientos', async () => {
    await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    expect(w.tables.commitments).toHaveLength(1);
  });

  it('una fecha corregida a mano queda a nombre de quien la corrige', async () => {
    await confirmExpiration(
      w.db,
      { id: rowId(), userId: ANA, expiresOn: '2027-05-10', today: TODAY },
      ctx,
    );
    const [c] = w.tables.commitments ?? [];
    expect(c).toMatchObject({ due_on: '2027-05-10', source_kind: 'manual', source_user_id: ANA });
  });

  it('si la flota (RUNT) ya vigila ese SOAT con esa fecha, se enlaza en vez de duplicar', async () => {
    w.tables.commitments = [
      {
        id: 'runt-1',
        organization_id: ORG,
        title: 'SOAT · WGY482',
        kind: 'soat',
        due_on: '2027-05-09',
        vehicle_id: VEHICLE,
        state: 'in_force',
        notice_days: 30,
        source_kind: 'system',
        review_state: 'confirmed',
      },
    ];
    const result = await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    expect(result.action).toBe('linked');
    expect(w.tables.commitments).toHaveLength(1);
    expect(result.row.commitment_id).toBe('runt-1');
  });

  it('un SOAT nuevo con fecha posterior cierra el anterior y su vencimiento', async () => {
    const first = await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    const renewal = await trackExpiration(
      w.db,
      { userId: ANA, kind: 'soat', subject: 'wgy-482', expiresOn: '2028-05-09', today: TODAY },
      ctx,
    );
    expect(renewal.renewed.map((r) => r.id)).toEqual([first.row.id]);
    const old = w.tables.document_expirations?.find((r) => r.id === first.row.id);
    expect(old).toMatchObject({ status: 'renovado', renewed_by_id: renewal.row.id });
    const oldCommitment = w.tables.commitments?.find((c) => c.id === first.commitmentId);
    expect(oldCommitment?.state).toBe('met');
    const fresh = w.tables.commitments?.find((c) => c.id === renewal.commitmentId);
    expect(fresh).toMatchObject({ due_on: '2028-05-09', source_kind: 'manual', state: 'in_force' });
  });

  it('un papel con fecha ANTERIOR no cierra al vigente', async () => {
    await confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx);
    const older = await trackExpiration(
      w.db,
      { userId: ANA, kind: 'soat', subject: 'WGY482', expiresOn: '2026-12-01', today: TODAY },
      ctx,
    );
    expect(older.renewed).toHaveLength(0);
  });

  it('descartar un papel confirmado suelta su vencimiento', async () => {
    const confirmed = await confirmExpiration(
      w.db,
      { id: rowId(), userId: ANA, today: TODAY },
      ctx,
    );
    await discardExpiration(w.db, { id: rowId(), reason: 'era una cotización' }, ctx);
    const c = w.tables.commitments?.find((x) => x.id === confirmed.commitmentId);
    expect(c?.state).toBe('dropped');
  });

  it('no se confirma sin fecha', async () => {
    const row = w.tables.document_expirations?.[0] as Record<string, unknown>;
    row.expires_on = null;
    await expect(
      confirmExpiration(w.db, { id: rowId(), userId: ANA, today: TODAY }, ctx),
    ).rejects.toThrow(/Falta la fecha/);
  });
});

describe('la renovación subida desde la pantalla', () => {
  it('lee con la pista aunque esté en un cuaderno personal, y hereda el sujeto', async () => {
    w = createWorld(
      seed(doc('d-soat', SHARED, SOAT_TEXT), doc('d-nuevo', PERSONAL, SOAT_TEXT)),
      ORG,
    );
    await detectDocumentExpiration(w.db, 'd-soat', { today: TODAY });
    const oldId = w.tables.document_expirations?.[0]?.id as string;
    await queueRenewalUpload(w.db, { expirationId: oldId, documentId: 'd-nuevo' });
    model.reply = JSON.stringify({
      items: [
        {
          kind: 'soat',
          kindQuote: 'SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO - SOAT',
          subjectKind: 'vehiculo',
          subject: null,
          expiresOn: '2027-05-09',
          expiresQuote: 'FIN DE VIGENCIA 09/05/2027 23:59',
        },
      ],
    });
    const out = await detectDocumentExpiration(w.db, 'd-nuevo', { today: TODAY });
    expect(out).toMatchObject({ ok: true, found: 1 });
    const fresh = w.tables.document_expirations?.find((r) => r.document_id === 'd-nuevo');
    expect(fresh).toMatchObject({ subject: 'WGY482', needs_review: true });
  });
});

describe('el barrido de lo que ya había', () => {
  it('respeta el tope de llamadas y deja lo que falta para la próxima tanda', async () => {
    w = createWorld(
      seed(
        doc('d-1', SHARED, SOAT_TEXT),
        doc('d-2', SHARED, SOAT_TEXT),
        doc('d-3', SHARED, 'nada'),
      ),
      ORG,
    );
    const first = await backfillDocumentExpirations(w.db, { maxModelCalls: 1, today: TODAY });
    expect(first.modelCalls).toBe(1);
    expect(first.more).toBe(true);
    expect(model.calls).toBe(1);
    const second = await backfillDocumentExpirations(w.db, { maxModelCalls: 5, today: TODAY });
    expect(second.modelCalls).toBe(1);
    expect(model.calls).toBe(2);
    const third = await backfillDocumentExpirations(w.db, { maxModelCalls: 5, today: TODAY });
    expect(third).toMatchObject({ scanned: 0, modelCalls: 0, more: false });
  });
});

describe('el piloto automático', () => {
  const item = (over: Partial<SnapshotExpiration>): SnapshotExpiration => ({
    id: 'e1',
    title: 'SOAT · WGY482',
    kind: 'soat',
    expiresOn: '2027-05-09',
    status: 'vigente',
    needsReview: true,
    ownerUserId: ANA,
    ownerName: 'Ana',
    createdAt: '2026-10-01T10:00:00Z',
    ...over,
  });

  it('recuerda confirmar a cada responsable, una vez por documento nuevo', () => {
    const items = collectDocumentExpirations(
      [item({}), item({ id: 'e2', createdAt: '2026-10-02T10:00:00Z' })],
      TODAY,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      area: 'vencimientos',
      effect: 'internal_notice',
      dedupeKey: `docvence:revisar:${ANA}:e2`,
      proposedAction: { toolId: 'autopilot.remind' },
    });
  });

  it('cuenta los vencidos sin renovación en una línea, sin acción', () => {
    const items = collectDocumentExpirations(
      [
        item({ needsReview: false, status: 'vencido', expiresOn: '2026-09-01' }),
        item({ id: 'e2', needsReview: false, status: 'vencido', expiresOn: '2026-09-20' }),
      ],
      TODAY,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.proposedAction).toBeNull();
    expect(items[0]?.why).toMatch(/hace 32 días/);
  });

  it('nada que decir, nada que proponer', () => {
    expect(collectDocumentExpirations([], TODAY)).toEqual([]);
    expect(collectDocumentExpirations(undefined, TODAY)).toEqual([]);
  });
});
