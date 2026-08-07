import { describe, expect, it } from 'vitest';
import type { ExtractionReading } from '../extract';
import {
  aggregateRecords,
  confirmExtraction,
  correctionStats,
  listFields,
  queryRecords,
  rejectExtraction,
  saveReading,
} from '../store';
import { createDocumentsWorld } from './fake-db';

/**
 * WHAT COUNTS, AND WHEN.
 *
 * The extraction pipeline is only interesting because of what it refuses, and
 * the refusal that matters most is not in the verifier — it is here. A reading
 * that passed every check in `verify.ts` is still not a number this company
 * has. It becomes one when somebody says so, and these tests are about the gap
 * between those two states.
 */

const ORG = 'org-postal';
const ANA = 'user-ana';
const TODAY = '2026-08-06';

function reading(over: Partial<ExtractionReading> = {}): ExtractionReading {
  return {
    docType: 'invoice',
    classificationQuote: 'FACTURA ELECTRÓNICA DE VENTA No. FE-4471',
    classificationChunkId: 'chunk-1',
    unclassifiedReason: null,
    modelId: 'claude-sonnet-5',
    extractorVersion: 'v1',
    rejected: [],
    fields: [
      field('invoice_number', { valueText: 'FE-4471' }),
      field('issuer_nit', { valueText: '9001234568' }),
      field('issuer_name', { valueText: 'COLTRANS S.A.S.' }),
      field('issued_on', { valueDate: '2026-07-15' }),
      field('total', { valueNumber: 1_500_000, currency: 'COP' }),
    ],
    ...over,
  };
}

function field(
  key: string,
  over: Partial<{
    valueText: string | null;
    valueNumber: number | null;
    valueDate: string | null;
    currency: 'COP' | 'USD' | 'EUR' | null;
  }>,
) {
  return {
    fieldKey: key,
    // The spec is not read back out of this in the code under test; only the
    // key matters, which is what the real pipeline stores.
    spec: { key, label: key, kind: 'text' as const, hint: '' },
    valueText: null,
    valueNumber: null,
    valueDate: null,
    currency: null,
    quote: `una frase del documento que contiene ${key}`,
    chunkId: 'chunk-1',
    ...over,
  };
}

function world(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createDocumentsWorld(
    {
      users: [{ id: ANA, organization_id: ORG, name: 'Ana', email: 'ana@postal.co' }],
      kb_documents: [
        { id: 'doc-1', organization_id: ORG, title: 'Factura FE-4471.pdf' },
        { id: 'doc-2', organization_id: ORG, title: 'Factura FE-4472.pdf' },
      ],
      document_extractions: [],
      document_fields: [],
      document_field_corrections: [],
      clients: [],
      ...seed,
    },
    ORG,
  );
}

/** Confirm everything as read, which is what the "Confirmar todo" button does. */
async function confirmAll(
  db: ReturnType<typeof world>['db'],
  extractionId: string,
  overrides: Record<string, Record<string, unknown>> = {},
) {
  const fields = (await listFields(db, [extractionId])).get(extractionId) ?? [];
  return confirmExtraction(db, {
    extractionId,
    userId: ANA,
    decisions: fields.map((f) => ({
      fieldKey: f.field_key,
      action: 'confirm' as const,
      ...(overrides[f.field_key] ?? {}),
    })),
  });
}

describe('an extraction before anybody has looked at it', () => {
  it('is stored pending, with every quote, and contributes nothing to any total', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });

    expect(row.review_state).toBe('pending');
    // The queryable columns are empty on purpose: the canonical surface is
    // written from confirmed fields and from nowhere else.
    expect(row.total_amount).toBeNull();
    expect(row.issued_on).toBeNull();

    const fields = (await listFields(w.db, [row.id])).get(row.id) ?? [];
    expect(fields).toHaveLength(5);
    expect(fields.every((f) => f.review_state === 'pending')).toBe(true);
    expect(fields.every((f) => f.quote.length >= 8)).toBe(true);

    expect(await queryRecords(w.db, { today: TODAY })).toEqual([]);
    const totals = await aggregateRecords(w.db, { groupBy: 'client' });
    expect(totals.groups).toEqual([]);
    // And the absence is REPORTED, rather than reading as "there is nothing".
    expect(totals.pendingExcluded).toBe(1);
  });

  it('is replaced, not duplicated, when the document is read again', async () => {
    const w = world();
    await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    expect(w.tables.document_extractions).toHaveLength(1);
    expect(w.tables.document_fields).toHaveLength(5);
  });

  it('records the NIT it read but links no client until a person confirms it', async () => {
    const w = world({
      clients: [{ id: 'cli-1', organization_id: ORG, name: 'Coltrans S.A.S.', tax_id: '900123456' }],
    });
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    expect(row.client_nit).toBe('9001234568');
    expect(row.client_match_state).toBe('matched');
    // Would match — and still is not linked. A link nobody earned is worse than
    // no link (migration 0075).
    expect(row.client_id).toBeNull();
  });
});

describe('once a person confirms it', () => {
  it('starts counting, under their name', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    const result = await confirmAll(w.db, row.id);

    expect(result.confirmed).toBe(5);
    expect(result.extraction.review_state).toBe('confirmed');
    expect(result.extraction.confirmed_by).toBe(ANA);
    expect(Number(result.extraction.total_amount)).toBe(1_500_000);
    expect(result.extraction.currency).toBe('COP');
    expect(result.extraction.issued_on).toBe('2026-07-15');

    const records = await queryRecords(w.db, { today: TODAY });
    expect(records).toHaveLength(1);
    expect(records[0]?.totalAmount).toBe(1_500_000);
    expect(records[0]?.documentTitle).toBe('Factura FE-4471.pdf');
  });

  it('files it under the client whose NIT it carries', async () => {
    const w = world({
      clients: [{ id: 'cli-1', organization_id: ORG, name: 'Coltrans S.A.S.', tax_id: '900123456' }],
    });
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    const result = await confirmAll(w.db, row.id);
    expect(result.extraction.client_id).toBe('cli-1');
  });

  it('leaves the link empty when the NIT matches nobody, even if the name does', async () => {
    const w = world({
      clients: [
        // The same company by name. A different NIT. Nothing links these two,
        // and guessing that they are the same is how a month of invoices ends
        // up on the wrong client card.
        { id: 'cli-1', organization_id: ORG, name: 'COLTRANS S.A.S.', tax_id: '811009999' },
      ],
    });
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    const result = await confirmAll(w.db, row.id);

    expect(result.extraction.client_id).toBeNull();
    expect(result.extraction.client_match_state).toBe('unmatched');
    // The counterparty is still named, from the document itself — so the
    // invoice is not lost, it is merely unattributed.
    expect(result.extraction.counterparty_name).toBe('COLTRANS S.A.S.');
  });

  it('keeps the correction beside the reading, and logs it as a correction', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    const result = await confirmAll(w.db, row.id, { total: { number: 1_499_000 } });

    expect(result.corrected).toBe(1);
    const fields = (await listFields(w.db, [row.id])).get(row.id) ?? [];
    const total = fields.find((f) => f.field_key === 'total');
    // The proposal survives untouched next to the correction.
    expect(Number(total?.value_number)).toBe(1_500_000);
    expect(Number(total?.corrected_number)).toBe(1_499_000);

    // The corrected value is what counts.
    const records = await queryRecords(w.db, { today: TODAY });
    expect(records[0]?.totalAmount).toBe(1_499_000);

    const stats = await correctionStats(w.db);
    const totalStat = stats.find((s) => s.fieldKey === 'total');
    expect(totalStat?.corrected).toBe(1);
    // A straight confirmation is not a correction, or every field would look
    // broken.
    expect(stats.find((s) => s.fieldKey === 'issued_on')).toBeUndefined();
  });

  it('stays pending while any field is still unresolved', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    const result = await confirmExtraction(w.db, {
      extractionId: row.id,
      userId: ANA,
      decisions: [{ fieldKey: 'total', action: 'confirm' }],
    });
    expect(result.extraction.review_state).toBe('pending');
    // Not in the numbers, even though the total itself was confirmed: the
    // document is not reviewed until the review is finished.
    expect(await queryRecords(w.db, { today: TODAY })).toEqual([]);
  });
});

describe('when a reading is thrown out', () => {
  it('takes its figures with it', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    await confirmAll(w.db, row.id);
    expect(await queryRecords(w.db, { today: TODAY })).toHaveLength(1);

    await rejectExtraction(w.db, { extractionId: row.id, userId: ANA, reason: 'duplicada' });
    expect(await queryRecords(w.db, { today: TODAY })).toEqual([]);
  });
});

describe('reading the documents as data', () => {
  it('adds up by client, and never adds two currencies together', async () => {
    const w = world();
    const first = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    await confirmAll(w.db, first.id);

    const second = await saveReading(w.db, {
      documentId: 'doc-2',
      reading: reading({
        fields: [
          field('issuer_name', { valueText: 'COLTRANS S.A.S.' }),
          field('issuer_nit', { valueText: '9001234568' }),
          field('issued_on', { valueDate: '2026-07-28' }),
          field('total', { valueNumber: 3_200, currency: 'USD' }),
        ],
      }),
    });
    await confirmAll(w.db, second.id);

    const totals = await aggregateRecords(w.db, {
      groupBy: 'client',
      filters: { issuedFrom: '2026-07-01', issuedTo: '2026-07-31', today: TODAY },
    });
    expect(totals.groups).toHaveLength(2);
    expect(totals.groups.map((g) => g.currency).sort()).toEqual(['COP', 'USD']);
    expect(totals.groups.find((g) => g.currency === 'COP')?.total).toBe(1_500_000);
    expect(totals.groups.find((g) => g.currency === 'USD')?.total).toBe(3_200);
  });

  it('finds what is past its deadline', async () => {
    const w = world();
    const row = await saveReading(w.db, {
      documentId: 'doc-1',
      reading: reading({
        docType: 'waybill',
        fields: [
          field('waybill_number', { valueText: 'G-88213' }),
          field('delivery_due_on', { valueDate: '2026-07-30' }),
        ],
      }),
    });
    await confirmAll(w.db, row.id);

    const overdue = await queryRecords(w.db, { overdueOnly: true, today: TODAY });
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.docNumber).toBe('G-88213');
    expect(overdue[0]?.overdue).toBe(true);
    expect(overdue[0]?.daysToDue).toBe(-7);
  });

  it('answers a month-by-month question about one client', async () => {
    const w = world();
    const row = await saveReading(w.db, { documentId: 'doc-1', reading: reading() });
    await confirmAll(w.db, row.id);

    const july = await aggregateRecords(w.db, {
      groupBy: 'month',
      filters: { counterparty: 'coltrans', issuedFrom: '2026-07-01', issuedTo: '2026-07-31' },
    });
    expect(july.groups[0]?.label).toBe('2026-07');
    expect(july.groups[0]?.total).toBe(1_500_000);

    const august = await aggregateRecords(w.db, {
      groupBy: 'month',
      filters: { counterparty: 'coltrans', issuedFrom: '2026-08-01', issuedTo: '2026-08-31' },
    });
    expect(august.groups).toEqual([]);
  });
});
