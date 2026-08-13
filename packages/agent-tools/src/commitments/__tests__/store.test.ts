import { describe, expect, it } from 'vitest';
import { syncFleetCommitments } from '../fleet';
import { MissingSourceError, type SourceInput } from '../shape';
import {
  claimNotice,
  confirmExtracted,
  createCommitment,
  getCommitment,
  listCommitments,
  markMet,
  refreshStates,
  settleNotice,
} from '../store';
import { createCommitmentsWorld } from './fake-db';

/**
 * The behaviour that decides whether this module can be trusted, exercised
 * against a database double that enforces migration 0069's unique indexes.
 *
 * Every assertion here is about ROWS, never about a call having been made:
 * "the second run sent nothing" is only meaningful if it is measured as a row
 * that was not written.
 */

const ORG = 'org-postal';
const ANA = 'user-ana';
const JEFE = 'user-jefe';
const TODAY = '2026-08-04';

/**
 * A calendar day relative to the real clock, as `YYYY-MM-DD`.
 *
 * `createCommitment` derives the initial state by comparing the due date
 * against today, so a hard-coded future date is a fixture with an expiry: it
 * works until that day arrives and then the row is born `overdue` and the test
 * fails for a reason that has nothing to do with the code. That already
 * happened here — `2026-08-10` was comfortably ahead when it was written.
 *
 * Anything asserting on a state the clock decides has to move with the clock.
 * `TODAY` above stays fixed on purpose: it is passed in explicitly, so it is a
 * parameter rather than a reading of the world.
 */
function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function world() {
  return createCommitmentsWorld(
    {
      commitments: [],
      commitment_notices: [],
      users: [
        { id: ANA, organization_id: ORG, name: 'Ana', email: 'ana@postal.co', role: 'member' },
        {
          id: JEFE,
          organization_id: ORG,
          name: 'Jefe',
          email: 'jefe@postal.co',
          role: 'org_admin',
        },
      ],
      vehicles: [],
      kb_documents: [],
    },
    ORG,
  );
}

const manual: SourceInput = { kind: 'manual', userId: ANA };

// ---------------------------------------------------------------------------
// No source, no commitment
// ---------------------------------------------------------------------------

describe('a commitment without a verifiable source', () => {
  it('is refused, with a sentence rather than a constraint name', async () => {
    const w = world();
    await expect(
      createCommitment(w.db, {
        title: 'Pago proveedor',
        kind: 'payment',
        dueOn: '2026-09-01',
        // A document-sourced date with no quote: exactly what a model that has
        // "read a contract" and is confabulating would produce.
        source: { kind: 'document', documentId: 'doc-1', quote: '' },
        createdBy: ANA,
      }),
    ).rejects.toThrow(MissingSourceError);

    expect(w.tables.commitments).toHaveLength(0);
  });

  it('is refused when a system date has no moment of reading', async () => {
    const w = world();
    await expect(
      createCommitment(w.db, {
        title: 'SOAT WGY482',
        kind: 'soat',
        dueOn: '2026-09-14',
        source: { kind: 'system', system: 'RUNT', readAt: '' },
        createdBy: ANA,
      }),
    ).rejects.toThrow(/system and the moment read/);
    expect(w.tables.commitments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Extracted dates are not watched
// ---------------------------------------------------------------------------

describe('a date extracted from a document', () => {
  it('is invisible to everything that watches, until a person confirms it', async () => {
    const w = world();
    // Due comfortably ahead of the real clock, so the row is born in force and
    // the closing assertion means something: the only way it could read
    // 'overdue' is if the refresher had touched it.
    const row = await createCommitment(w.db, {
      title: 'Vigencia contrato Servientrega',
      kind: 'contract',
      dueOn: daysFromNow(30),
      ownerUserId: ANA,
      source: {
        kind: 'document',
        documentId: 'doc-1',
        chunkId: 'chunk-1',
        quote: 'estará vigente hasta el 10 de agosto de 2026',
      },
      createdBy: ANA,
    });
    expect(row.review_state).toBe('pending');

    // The watched set — what the daily job, the tools and the screen all read.
    const watched = await listCommitments(w.db, { today: TODAY });
    expect(watched).toEqual([]);

    // It is in the review queue, and only there.
    const queue = await listCommitments(w.db, { reviewState: 'pending', today: TODAY });
    expect(queue.map((r) => r.id)).toEqual([row.id]);

    // Even the state refresher leaves it alone, so it can never drift into
    // 'overdue' and be picked up by a query that filters on the cached column
    // without also filtering on review_state.
    const before = w.tables.commitments?.find((c) => c.id === row.id)?.state;
    // Refreshed with a day well PAST the due date — so a row that was being
    // watched would certainly flip to 'overdue' here. This one does not,
    // because it is still waiting on a person.
    await refreshStates(w.db, daysFromNow(60));
    const after = w.tables.commitments?.find((c) => c.id === row.id)?.state;
    expect(after).toBe(before);
    expect(after).not.toBe('overdue');
  });

  it('starts being watched only once a named person vouches for it', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'Vigencia contrato',
      kind: 'contract',
      dueOn: '2026-08-10',
      source: { kind: 'document', documentId: 'doc-1', quote: 'vence el 10 de agosto de 2026' },
      createdBy: ANA,
    });

    await confirmExtracted(w.db, { id: row.id, userId: JEFE });

    const watched = await listCommitments(w.db, { today: TODAY });
    expect(watched.map((r) => r.id)).toEqual([row.id]);

    const stored = await getCommitment(w.db, row.id);
    // The name and the moment are what migration 0069 requires before it will
    // store review_state='confirmed' on a document-sourced row.
    expect(stored?.confirmed_by).toBe(JEFE);
    expect(stored?.confirmed_at).toBeTruthy();
    // The quote survives the correction, so a changed date sits next to the
    // sentence it was supposedly read from.
    expect(stored?.source_quote).toContain('10 de agosto de 2026');
  });

  it('lets the reviewer correct the date while confirming', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'Vigencia contrato',
      kind: 'contract',
      dueOn: '2026-08-10',
      source: { kind: 'document', documentId: 'doc-1', quote: 'vence el 10 de agosto de 2026' },
      createdBy: ANA,
    });
    const fixed = await confirmExtracted(w.db, {
      id: row.id,
      userId: JEFE,
      dueOn: '2026-09-10',
    });
    expect(fixed.due_on).toBe('2026-09-10');
    expect(fixed.source_quote).toContain('10 de agosto de 2026');
  });
});

// ---------------------------------------------------------------------------
// One notice, once
// ---------------------------------------------------------------------------

describe('the notice ledger', () => {
  async function commitment(w: ReturnType<typeof world>) {
    return createCommitment(w.db, {
      title: 'SOAT WGY482',
      kind: 'soat',
      dueOn: '2026-08-20',
      ownerUserId: ANA,
      source: manual,
      createdBy: ANA,
    });
  }

  it('lets the first claim through and refuses every one after it', async () => {
    const w = world();
    const c = await commitment(w);
    const args = {
      commitmentId: c.id,
      noticeKind: 'ahead' as const,
      dueOn: c.due_on,
      sentOn: TODAY,
      recipientEmail: 'ana@postal.co',
    };

    const first = await claimNotice(w.db, args);
    expect(first.outcome).toBe('claimed');
    await settleNotice(w.db, { id: first.id as string, delivered: true });

    // The same day again (a retry), and a different day (tomorrow's run).
    const again = await claimNotice(w.db, args);
    const tomorrow = await claimNotice(w.db, { ...args, sentOn: '2026-08-05' });
    expect(again.outcome).toBe('sent');
    expect(tomorrow.outcome).toBe('sent');

    // One row, therefore one email — measured, not assumed.
    expect(w.tables.commitment_notices).toHaveLength(1);
  });

  it('retries a claim whose message never went out, without creating a second one', async () => {
    const w = world();
    const c = await commitment(w);
    const args = {
      commitmentId: c.id,
      noticeKind: 'due_today' as const,
      dueOn: c.due_on,
      sentOn: TODAY,
      recipientEmail: 'ana@postal.co',
    };

    const first = await claimNotice(w.db, args);
    // Resend was down, or nobody had an address on file.
    await settleNotice(w.db, { id: first.id as string, delivered: false, note: 'Resend 502' });

    const retry = await claimNotice(w.db, { ...args, sentOn: '2026-08-05' });
    expect(retry.outcome).toBe('retry');
    expect(retry.id).toBe(first.id);
    expect(w.tables.commitment_notices).toHaveLength(1);
  });

  it('treats a rescheduled deadline as a new deadline worth warning about', async () => {
    const w = world();
    const c = await commitment(w);
    const base = {
      commitmentId: c.id,
      noticeKind: 'ahead' as const,
      sentOn: TODAY,
      recipientEmail: 'ana@postal.co',
    };
    await claimNotice(w.db, { ...base, dueOn: '2026-08-20' });
    const moved = await claimNotice(w.db, { ...base, dueOn: '2026-10-20' });
    expect(moved.outcome).toBe('claimed');
    expect(w.tables.commitment_notices).toHaveLength(2);
  });

  it('keeps the four kinds apart, so a warning and an escalation are not the same notice', async () => {
    const w = world();
    const c = await commitment(w);
    const base = { commitmentId: c.id, dueOn: c.due_on, sentOn: TODAY };
    for (const noticeKind of ['ahead', 'due_today', 'overdue', 'escalation'] as const) {
      expect((await claimNotice(w.db, { ...base, noticeKind })).outcome).toBe('claimed');
    }
    expect(w.tables.commitment_notices).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

describe('fulfilling a commitment', () => {
  it('keeps the old one and creates the next, once', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'Arriendo bodega',
      kind: 'payment',
      dueOn: '2026-08-05',
      ownerUserId: ANA,
      recurrence: 'monthly',
      source: manual,
      createdBy: ANA,
    });

    const first = await markMet(w.db, {
      id: row.id,
      userId: ANA,
      note: 'Transferido',
      today: TODAY,
    });
    expect(first.commitment.state).toBe('met');
    expect(first.successor?.due_on).toBe('2026-09-05');
    // Same series, so the history of this standing obligation is one query.
    expect(first.successor?.series_id).toBe(row.series_id);
    expect(first.successor?.previous_commitment_id).toBe(row.id);

    // The history is intact: the fulfilled row still carries its own date.
    const old = await getCommitment(w.db, row.id);
    expect(old?.due_on).toBe('2026-08-05');
    expect(old?.met_note).toBe('Transferido');

    // A retried job. `commitments_successor_once_idx` refuses the second
    // successor in the database, so the series cannot fork.
    const retry = await markMet(w.db, { id: row.id, userId: ANA, today: TODAY });
    expect(retry.alreadyMet).toBe(true);
    expect(w.tables.commitments).toHaveLength(2);
  });

  it('refuses to roll a registry-reported date forward, and says why', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'SOAT WGY482',
      kind: 'soat',
      dueOn: '2026-08-14',
      ownerUserId: ANA,
      // Somebody asked for a yearly cadence on a RUNT-sourced date. Reasonable
      // about the world, wrong about who produces the next date.
      recurrence: 'yearly',
      source: { kind: 'system', system: 'RUNT', readAt: '2026-08-02T14:10:00Z' },
      createdBy: ANA,
    });
    // Coerced at write time: the next one comes from the registry.
    expect(row.recurrence).toBe('from_source');

    const result = await markMet(w.db, { id: row.id, userId: ANA, today: TODAY });
    expect(result.successor).toBeNull();
    expect(result.successorDeferred).toMatch(/RUNT/);
    expect(w.tables.commitments).toHaveLength(1);
  });

  it('sends the successor of an extracted commitment back to review', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'Cuota mensual contrato',
      kind: 'payment',
      dueOn: '2026-08-05',
      recurrence: 'monthly',
      source: {
        kind: 'document',
        documentId: 'doc-1',
        quote: 'pagará el 5 de agosto de 2026 y mensualmente',
      },
      createdBy: ANA,
    });
    await confirmExtracted(w.db, { id: row.id, userId: JEFE });

    const result = await markMet(w.db, { id: row.id, userId: ANA, today: TODAY });
    // The contract stated ONE date. The next month's is a proposal again.
    expect(result.successor?.review_state).toBe('pending');
    expect(result.successor?.due_on).toBe('2026-09-05');
    const watched = await listCommitments(w.db, { today: '2026-09-01' });
    expect(watched.map((r) => r.id)).not.toContain(result.successor?.id);
  });
});

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

describe('fleet paperwork', () => {
  function fleetWorld(soat: string | null, lastSync: string | null) {
    return createCommitmentsWorld(
      {
        commitments: [],
        commitment_notices: [],
        users: [{ id: ANA, organization_id: ORG, name: 'Ana', email: 'ana@postal.co' }],
        vehicles: [
          {
            id: 'veh-1',
            organization_id: ORG,
            user_id: ANA,
            plate: 'WGY482',
            label: 'Furgón grande',
            soat_expires_at: soat,
            rtm_expires_at: null,
            last_runt_sync: lastSync,
            archived: false,
          },
        ],
        kb_documents: [],
      },
      ORG,
    );
  }

  it('turns a RUNT answer into a watched commitment with its provenance', async () => {
    const w = fleetWorld('2026-09-14', '2026-08-02T14:10:00Z');
    const result = await syncFleetCommitments(w.db);
    expect(result.created).toBe(1);

    const [row] = await listCommitments(w.db, { today: TODAY });
    expect(row?.title).toBe('SOAT · WGY482 (Furgón grande)');
    expect(row?.source_kind).toBe('system');
    expect(row?.source_system).toBe('RUNT');
    expect(row?.source_read_at).toBe('2026-08-02T14:10:00Z');
    // Never rolled forward by us.
    expect(row?.recurrence).toBe('from_source');
    // A month of warning for a SOAT, without anybody choosing it.
    expect(row?.notice_days).toBe(30);
  });

  it('writes nothing at all on the second night', async () => {
    const w = fleetWorld('2026-09-14', '2026-08-02T14:10:00Z');
    await syncFleetCommitments(w.db);
    const second = await syncFleetCommitments(w.db);
    expect(second.created).toBe(0);
    expect(w.tables.commitments).toHaveLength(1);
  });

  it('closes the previous SOAT when a later expiry appears, keeping it as history', async () => {
    const w = fleetWorld('2026-09-14', '2026-08-02T14:10:00Z');
    await syncFleetCommitments(w.db);

    // RUNT reports the renewal.
    const vehicle = w.tables.vehicles?.[0] as Record<string, unknown>;
    vehicle.soat_expires_at = '2027-09-14';
    vehicle.last_runt_sync = '2026-09-01T09:00:00Z';
    await syncFleetCommitments(w.db);

    expect(w.tables.commitments).toHaveLength(2);
    const closed = w.tables.commitments?.find((c) => c.due_on === '2026-09-14');
    expect(closed?.state).toBe('met');
    expect(String(closed?.met_note)).toMatch(/2027-09-14/);
    const open = await listCommitments(w.db, {
      states: ['in_force', 'due_soon', 'overdue'],
      today: TODAY,
    });
    expect(open.map((r) => r.due_on)).toEqual(['2027-09-14']);
  });

  it('refuses a registry date with no moment of reading', async () => {
    // "Read from RUNT" with no timestamp is not a provenance, it is a claim.
    const w = fleetWorld('2026-09-14', null);
    const result = await syncFleetCommitments(w.db);
    expect(result.created).toBe(0);
    expect(result.skippedNoReadTime).toBe(1);
    expect(w.tables.commitments).toHaveLength(0);
  });
});

/**
 * PREGUNTAR POR EL PASADO, QUE ES DONDE ESTA FUNCIÓN PODÍA MENTIR.
 *
 * Todo lo demás en `listCommitments` va sobre lo que VIENE: ordena por `due_on`
 * ascendente y corta con `limit`, que es lo correcto cuando alguien pide los
 * próximos cien vencimientos. Apuntado al pasado se convierte en una trampa —
 * `states: ['met']` devuelve los quinientos cumplidos MÁS ANTIGUOS y los
 * presenta como recientes. No falla: contesta con seguridad usando filas de
 * hace dos años, que es la peor forma de que una consulta se equivoque.
 */
describe('el historial reciente', () => {
  it('devuelve lo último cerrado, no lo más viejo', async () => {
    const w = world();

    const made = [];
    for (const [title, dueOn, metAt] of [
      ['Lo más viejo', '2024-01-10', '2024-01-09T15:00:00Z'],
      ['De hace un mes', '2026-07-10', '2026-07-09T15:00:00Z'],
      ['De ayer', '2026-08-12', '2026-08-12T15:00:00Z'],
    ] as const) {
      const row = await createCommitment(w.db, {
        title,
        kind: 'internal',
        dueOn,
        ownerUserId: ANA,
        source: { kind: 'manual', userId: ANA },
        createdBy: ANA,
      });
      const stored = w.tables.commitments?.find((c) => c.id === row.id);
      if (stored) {
        stored.state = 'met';
        stored.met_at = metAt;
      }
      made.push(row);
    }

    // Sin `metAfter` el orden es por vencimiento: lo de 2024 primero. Esa es
    // exactamente la respuesta que parecía correcta y no lo era.
    const byDueDate = await listCommitments(w.db, { states: ['met'], today: TODAY });
    expect(byDueDate[0]?.title).toBe('Lo más viejo');

    // Pidiendo historial, el orden sigue a la pregunta.
    const recent = await listCommitments(w.db, {
      states: ['met'],
      metAfter: '2026-06-01T00:00:00Z',
      today: TODAY,
    });
    expect(recent.map((r) => r.title)).toEqual(['De ayer', 'De hace un mes']);
  });

  it('deja fuera lo cerrado antes de la ventana', async () => {
    const w = world();
    const row = await createCommitment(w.db, {
      title: 'Cerrado hace mucho',
      kind: 'internal',
      dueOn: '2024-01-10',
      ownerUserId: ANA,
      source: { kind: 'manual', userId: ANA },
      createdBy: ANA,
    });
    const stored = w.tables.commitments?.find((c) => c.id === row.id);
    if (stored) {
      stored.state = 'met';
      stored.met_at = '2024-01-09T15:00:00Z';
    }

    const recent = await listCommitments(w.db, {
      states: ['met'],
      metAfter: '2026-06-01T00:00:00Z',
      today: TODAY,
    });
    expect(recent).toHaveLength(0);
  });
});
