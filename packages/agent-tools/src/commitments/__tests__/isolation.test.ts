import { describe, expect, it } from 'vitest';
import { syncFleetCommitments } from '../fleet';
import {
  claimNotice,
  confirmExtracted,
  createCommitment,
  getCommitment,
  listCommitments,
  listNoticesFor,
  listSeries,
  markMet,
  refreshStates,
} from '../store';
import { createCommitmentsWorld } from './fake-db';

/**
 * TWO COMPANIES, ONE DATABASE — the commitments half.
 *
 * Same posture as tenancy/__tests__/isolation.test.ts, and the fixture is
 * adversarial in the same way: both companies run a truck, both have a SOAT
 * expiring on the same day, both have a contract with the same title, and both
 * have something in the review queue. A query that lost its workspace filter
 * therefore returns something PLAUSIBLE rather than something empty, which is
 * how this class of bug survives review.
 *
 * The subject under test is the real product code — `store.ts`, `fleet.ts` —
 * through the real `createOrgScopedClient`, and every assertion is about which
 * rows came back.
 */

const POSTAL = 'org-postal';
const ADUANAS = 'org-aduanas';

const ANA = 'user-ana'; // Postal
const CARLA = 'user-carla'; // Aduanas

const TODAY = '2026-08-04';

function world() {
  return createCommitmentsWorld(
    {
      users: [
        {
          id: ANA,
          organization_id: POSTAL,
          name: 'Ana',
          email: 'ana@postal.co',
          role: 'org_admin',
        },
        // Same first name, different company: matching on a name is not enough
        // to cross the boundary either.
        {
          id: CARLA,
          organization_id: ADUANAS,
          name: 'Ana',
          email: 'ana@aduanas.co',
          role: 'org_admin',
        },
      ],
      vehicles: [
        {
          id: 'veh-postal',
          organization_id: POSTAL,
          user_id: ANA,
          plate: 'WGY482',
          label: null,
          soat_expires_at: '2026-09-14',
          rtm_expires_at: null,
          last_runt_sync: '2026-08-02T14:10:00Z',
          archived: false,
        },
        {
          id: 'veh-aduanas',
          organization_id: ADUANAS,
          user_id: CARLA,
          plate: 'HKL903',
          label: null,
          // The same expiry date, on purpose.
          soat_expires_at: '2026-09-14',
          rtm_expires_at: null,
          last_runt_sync: '2026-08-02T14:10:00Z',
          archived: false,
        },
      ],
      commitments: [],
      commitment_notices: [],
      kb_documents: [
        { id: 'doc-postal', organization_id: POSTAL, title: 'Contrato Servientrega 2026' },
        { id: 'doc-aduanas', organization_id: ADUANAS, title: 'Contrato Servientrega 2026' },
      ],
    },
    POSTAL,
  );
}

async function seed(w: ReturnType<typeof world>) {
  const postal = w.scopedFor(POSTAL);
  const aduanas = w.scopedFor(ADUANAS);

  const a = await createCommitment(postal, {
    title: 'Renovación contrato Servientrega',
    kind: 'contract',
    dueOn: '2026-08-20',
    ownerUserId: ANA,
    source: { kind: 'manual', userId: ANA },
    createdBy: ANA,
  });
  const b = await createCommitment(aduanas, {
    // Identical title and date. A missing filter returns this instead of
    // nothing, which is what makes the failure invisible in real life.
    title: 'Renovación contrato Servientrega',
    kind: 'contract',
    dueOn: '2026-08-20',
    ownerUserId: CARLA,
    source: { kind: 'manual', userId: CARLA },
    createdBy: CARLA,
  });
  return { postal, aduanas, a, b };
}

describe('two companies, one commitments table', () => {
  it('each company lists only its own, even with identical titles and dates', async () => {
    const w = world();
    const { postal, aduanas, a, b } = await seed(w);

    expect((await listCommitments(postal, { today: TODAY })).map((r) => r.id)).toEqual([a.id]);
    expect((await listCommitments(aduanas, { today: TODAY })).map((r) => r.id)).toEqual([b.id]);
  });

  it('knowing the other company’s commitment id is not enough to read it', async () => {
    const w = world();
    const { postal, b } = await seed(w);
    expect(await getCommitment(postal, b.id)).toBeNull();
  });

  it('a write cannot be aimed at another workspace', async () => {
    const w = world();
    const { postal } = await seed(w);
    // The scoped client stamps the caller's workspace over anything the payload
    // claims, so this lands in Postal.
    await postal.from('commitments').insert({
      title: 'Plantado',
      kind: 'other',
      due_on: '2026-12-01',
      source_kind: 'manual',
      source_user_id: ANA,
      organization_id: ADUANAS,
    });
    const planted = w.tables.commitments?.find((c) => c.title === 'Plantado');
    expect(planted?.organization_id).toBe(POSTAL);
  });

  it('fulfilling another company’s commitment does nothing', async () => {
    const w = world();
    const { postal, b } = await seed(w);
    await expect(markMet(postal, { id: b.id, userId: ANA, today: TODAY })).rejects.toThrow(
      /no longer exists/i,
    );
    const untouched = w.tables.commitments?.find((c) => c.id === b.id);
    expect(untouched?.state).not.toBe('met');
  });

  it('confirming another company’s extraction is refused', async () => {
    const w = world();
    const { postal, aduanas } = await seed(w);
    const theirs = await createCommitment(aduanas, {
      title: 'Póliza de cumplimiento',
      kind: 'policy',
      dueOn: '2026-10-01',
      source: {
        kind: 'document',
        documentId: 'doc-aduanas',
        quote: 'vigente hasta el 1 de octubre de 2026',
      },
      createdBy: CARLA,
    });

    await expect(confirmExtracted(postal, { id: theirs.id, userId: ANA })).rejects.toThrow(
      /no longer exists/i,
    );
    const stored = w.tables.commitments?.find((c) => c.id === theirs.id);
    // Still a proposal, still unwatched, and nobody from Postal is on the row.
    expect(stored?.review_state).toBe('pending');
    expect(stored?.confirmed_by).toBeNull();
  });

  it('the review queue does not show the other company’s proposals', async () => {
    const w = world();
    const { postal, aduanas } = await seed(w);
    await createCommitment(aduanas, {
      title: 'Plazo de aduana DIAN',
      kind: 'customs',
      dueOn: '2026-08-30',
      source: {
        kind: 'document',
        documentId: 'doc-aduanas',
        quote: 'el plazo vence el 30 de agosto de 2026',
      },
      createdBy: CARLA,
    });
    expect(await listCommitments(postal, { reviewState: 'pending', today: TODAY })).toEqual([]);
  });

  it('notices stay with their own company, and one company’s claim does not block the other', async () => {
    const w = world();
    const { postal, aduanas, a, b } = await seed(w);

    const mine = await claimNotice(postal, {
      commitmentId: a.id,
      noticeKind: 'ahead',
      dueOn: a.due_on,
      sentOn: TODAY,
      recipientEmail: 'ana@postal.co',
    });
    const theirs = await claimNotice(aduanas, {
      commitmentId: b.id,
      noticeKind: 'ahead',
      dueOn: b.due_on,
      sentOn: TODAY,
      recipientEmail: 'ana@aduanas.co',
    });
    // Same kind, same date, different commitment: both are legitimate.
    expect(mine.outcome).toBe('claimed');
    expect(theirs.outcome).toBe('claimed');

    const seen = await listNoticesFor(postal, [a.id, b.id]);
    expect(seen.map((n) => n.commitment_id)).toEqual([a.id]);
  });

  it('the fleet sync files each truck’s paperwork in its own workspace', async () => {
    const w = world();
    await syncFleetCommitments(w.scopedFor(POSTAL));
    await syncFleetCommitments(w.scopedFor(ADUANAS));

    const postal = await listCommitments(w.scopedFor(POSTAL), { today: TODAY });
    const aduanas = await listCommitments(w.scopedFor(ADUANAS), { today: TODAY });
    expect(postal.map((r) => r.vehicle_plate)).toEqual(['WGY482']);
    expect(aduanas.map((r) => r.vehicle_plate)).toEqual(['HKL903']);
    // Identical dates on both sides did not collapse into one row.
    expect(w.tables.commitments).toHaveLength(2);
  });

  it('the state refresher only touches the caller’s workspace', async () => {
    const w = world();
    const { postal, b } = await seed(w);
    // Far past both due dates: a refresher without a tenant filter would mark
    // Aduanas' contract overdue too.
    await refreshStates(postal, '2026-12-01');
    const theirs = w.tables.commitments?.find((c) => c.id === b.id);
    expect(theirs?.state).not.toBe('overdue');
  });

  it('a series id from another company opens nothing', async () => {
    const w = world();
    const { postal, b } = await seed(w);
    expect(await listSeries(postal, b.series_id as string)).toEqual([]);
  });

  it('hydration cannot name another company’s document', async () => {
    const w = world();
    const { postal } = await seed(w);
    const mine = await createCommitment(postal, {
      title: 'Vigencia contrato',
      kind: 'contract',
      dueOn: '2026-09-30',
      // A document id from the OTHER company, guessed or leaked.
      source: {
        kind: 'document',
        documentId: 'doc-aduanas',
        quote: 'vigente hasta el 30 de septiembre de 2026',
      },
      createdBy: ANA,
    });
    const [row] = await listCommitments(postal, { reviewState: 'pending', today: TODAY });
    expect(row?.id).toBe(mine.id);
    // The title is not resolved, because the document is not visible here. The
    // chip falls back to a generic label rather than leaking a file name.
    expect(row?.source_document_title).toBeNull();
  });
});
