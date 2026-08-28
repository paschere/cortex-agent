import { describe, expect, it } from 'vitest';
import { everyoneGrant } from '../../kb/__tests__/space-fake';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { TABLE_TENANCY } from '../../tenancy/tables';
import { loadTurnContexts } from '../read';
import { loadOverrides, saveOverrides } from '../settings';

/**
 * Who can see a captured turn, and how far an adjustment reaches.
 *
 * Two different boundaries, tested together because they are the two ways this
 * feature could do real harm:
 *
 *   1. A capture quotes the corpus. If a workspace could read another's rows,
 *      this table would be the most effective leak in the product — it holds
 *      passages selected for relevance to a question somebody cared about.
 *
 *   2. An adjustment changes how an assistant behaves. If its scope were wider
 *      than the panel claims, somebody debugging one bad answer would silently
 *      change everybody's assistant, and nothing on screen would connect the
 *      two six weeks later.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

/** Two workspaces, each with a conversation, a capture and a setting. */
function world() {
  return createFakeSupabase({
    turn_contexts: [
      {
        id: 'tc-acme',
        organization_id: ACME,
        conversation_id: 'conv-acme',
        message_id: 'msg-acme',
        created_at: '2026-08-01T10:00:00Z',
        model: 'anthropic:claude-opus-5',
        prompt_tokens: 100,
        completion_tokens: 10,
        parts: [],
        instructions: { chars: 10, digest: 'abc' },
        memories: [],
        retrieval: {
          ran: true,
          skipped: null,
          query: 'tarifa de bodegaje',
          coverage: 'answered',
          summary: 'sí',
          cuts: {
            modelId: 'voyage:voyage-4-lite',
            strongMatch: 0.46,
            weakFloor: 0.34,
            railCeiling: 0.75,
            measured: true,
          },
          limit: 3,
          fragments: [
            {
              chunkId: 'c1',
              documentId: 'd1',
              documentTitle: 'Tarifas Acme',
              spaceId: 'space-acme-global',
              spaceName: 'Compañía',
              spaceKind: 'global',
              chunkIndex: 0,
              cosine: 0.51,
              keyword: 0,
              blended: 0.36,
              verdict: 'strong',
              prepended: true,
              excerpt: 'La tarifa de bodegaje es de 12.000 por tonelada.',
            },
            {
              chunkId: 'c2',
              documentId: 'd2',
              documentTitle: 'Notas de Ana',
              spaceId: 'space-ana-personal',
              spaceName: 'Notas de Ana',
              spaceKind: 'personal',
              chunkIndex: 2,
              cosine: 0.47,
              keyword: 0,
              blended: 0.33,
              verdict: 'strong',
              prepended: true,
              excerpt: 'Ana anotó que el cliente pidió descuento por debajo de la mesa.',
            },
          ],
        },
        tools: { reason: 'semantic', candidates: 60, offered: [], families: [] },
        overridden: false,
        redacted_at: null,
      },
      {
        id: 'tc-globex',
        organization_id: GLOBEX,
        conversation_id: 'conv-globex',
        message_id: 'msg-globex',
        created_at: '2026-08-01T11:00:00Z',
        model: 'anthropic:claude-opus-5',
        prompt_tokens: 200,
        completion_tokens: 20,
        parts: [],
        instructions: { chars: 10, digest: 'zzz' },
        memories: [],
        retrieval: { ran: false, skipped: null, fragments: [] },
        tools: { reason: 'semantic', candidates: 10, offered: [], families: [] },
        overridden: false,
        redacted_at: null,
      },
    ],
    // Desde la 0123 la visibilidad de un espacio se resuelve cruzando las
    // concesiones con el DIRECTORIO — quién es esta persona y de qué empresa —
    // así que el fixture necesita las dos cosas. Antes bastaba con los espacios
    // porque «global» quería decir «de todos», que es justamente la rigidez que
    // la 0123 quitó.
    users: [
      { id: 'user-ana', organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'member' },
      // Carlos también es de Acme: puede abrir esta conversación, y aun así el
      // cuaderno de Ana no es suyo. Es el caso que este archivo existe para
      // probar.
      {
        id: 'user-carlos',
        organization_id: ACME,
        email: 'carlos@acme.com',
        name: 'Carlos',
        role: 'member',
      },
    ],
    // Lo que la 0123 le escribió a todo espacio que ya era global: «lo ve toda
    // la empresa» es una concesión desde entonces, no una propiedad del scope.
    kb_space_grants: [everyoneGrant('space-acme-global', ACME)],
    kb_collections: [
      {
        id: 'space-acme-global',
        organization_id: ACME,
        name: 'Compañía',
        scope: 'global',
        scope_id: null,
        description: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'space-ana-personal',
        organization_id: ACME,
        name: 'Notas de Ana',
        scope: 'user',
        scope_id: 'user-ana',
        description: null,
        created_by: 'user-ana',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    turn_context_settings: [
      {
        conversation_id: 'conv-acme',
        organization_id: ACME,
        fragment_limit: 5,
        space_ids: null,
        muted_families: ['gmail'],
        updated_by: 'user-ana',
        updated_at: '2026-08-01T10:00:00Z',
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'conv-acme-other',
        organization_id: ACME,
        fragment_limit: null,
        space_ids: null,
        muted_families: [],
        updated_by: 'user-ana',
        updated_at: '2026-08-01T10:00:00Z',
        created_at: '2026-08-01T10:00:00Z',
      },
    ],
  });
}

describe('a workspace cannot read another workspace’s captured context', () => {
  it('is registered as tenant data, so an unfiltered query is impossible by construction', () => {
    // The registry is the mechanism: the scoped client refuses any table that
    // is not classified, and a `tenant` classification pins organization_id
    // onto every read. This assertion is what keeps somebody from later
    // "simplifying" it to shared().
    expect(TABLE_TENANCY.turn_contexts).toEqual({ kind: 'tenant', nullable: false });
    expect(TABLE_TENANCY.turn_context_settings).toEqual({ kind: 'tenant', nullable: false });
  });

  it('returns Globex nothing when it asks for an Acme conversation by id', async () => {
    const fake = world();
    const globex = createOrgScopedClient(fake.client, GLOBEX);

    // The id is correct and guessable. The workspace filter is what stops it,
    // and it is applied by the handle rather than by this call site.
    const rows = await loadTurnContexts(globex, {
      conversationId: 'conv-acme',
      viewerId: 'user-ana',
    });
    expect(rows).toHaveLength(0);
  });

  it('gives Acme its own turn', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    const rows = await loadTurnContexts(acme, {
      conversationId: 'conv-acme',
      viewerId: 'user-ana',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('tc-acme');
  });
});

describe('space visibility survives inside a capture', () => {
  it('withholds the text of a space the reader cannot see, and keeps the numbers', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    // Carlos is in Acme and may open this conversation — but "Notas de Ana" is
    // Ana's personal space, and being able to read a transcript is not the same
    // as being handed a colleague's private notes.
    const [turn] = await loadTurnContexts(acme, {
      conversationId: 'conv-acme',
      viewerId: 'user-carlos',
    });

    const fragments = turn?.retrieval.fragments ?? [];
    const global = fragments.find((f) => f.spaceId === 'space-acme-global');
    const personal = fragments.find((f) => f.spaceId === 'space-ana-personal');

    expect(global?.withheld).toBe(false);
    expect(global?.excerpt).toContain('12.000');

    expect(personal?.withheld).toBe(true);
    expect(personal?.excerpt).toBeNull();
    // The diagnosis survives the redaction: Carlos can still see that a second
    // fragment came back, that it scored 0,47 and that it reached the model.
    expect(personal?.cosine).toBe(0.47);
    expect(personal?.prepended).toBe(true);
    expect(personal?.documentTitle).toBe('Notas de Ana');
  });

  it('gives Ana her own fragment in full', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    const [turn] = await loadTurnContexts(acme, {
      conversationId: 'conv-acme',
      viewerId: 'user-ana',
    });
    const personal = turn?.retrieval.fragments.find((f) => f.spaceId === 'space-ana-personal');
    expect(personal?.withheld).toBe(false);
    expect(personal?.excerpt).toContain('descuento');
  });
});

describe('an adjustment reaches exactly as far as it says', () => {
  it('applies to the conversation it names and to no other', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    await saveOverrides(acme, {
      conversationId: 'conv-acme',
      userId: 'user-ana',
      overrides: { fragmentLimit: 0, spaceIds: null, mutedFamilies: ['hubspot'] },
    });

    expect(await loadOverrides(acme, 'conv-acme')).toMatchObject({
      fragmentLimit: 0,
      mutedFamilies: ['hubspot'],
    });

    // The sibling conversation in the SAME workspace, belonging to the SAME
    // person, is untouched. This is the property the panel promises in words
    // ("Solo en esta conversación") and the one that makes the control safe to
    // hand to somebody who is mid-diagnosis.
    expect(await loadOverrides(acme, 'conv-acme-other')).toMatchObject({
      fragmentLimit: null,
      mutedFamilies: [],
    });
  });

  it('does not reach across workspaces even for the same conversation id', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);
    const globex = createOrgScopedClient(fake.client, GLOBEX);

    await saveOverrides(acme, {
      conversationId: 'conv-acme',
      userId: 'user-ana',
      overrides: { fragmentLimit: 1, spaceIds: null, mutedFamilies: [] },
    });

    expect(await loadOverrides(globex, 'conv-acme')).toMatchObject({ fragmentLimit: null });
  });

  it('keeps zero distinct from "no preference"', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    await saveOverrides(acme, {
      conversationId: 'conv-acme',
      userId: 'user-ana',
      overrides: { fragmentLimit: 0, spaceIds: null, mutedFamilies: [] },
    });
    // "Answer without the brain this time" is a real instruction and must not
    // collapse into "use the default".
    expect((await loadOverrides(acme, 'conv-acme')).fragmentLimit).toBe(0);
  });

  it('stores an empty space list as no restriction, never as "no space at all"', async () => {
    const fake = world();
    const acme = createOrgScopedClient(fake.client, ACME);

    await saveOverrides(acme, {
      conversationId: 'conv-acme',
      userId: 'user-ana',
      overrides: { fragmentLimit: null, spaceIds: [], mutedFamilies: [] },
    });

    // `kbSpaceIds: []` means "search zero spaces". If an empty selection round
    // tripped as an empty array, deselecting every space in the UI would
    // silently switch the brain off for the conversation instead of resetting
    // it — so the two states are collapsed deliberately, on the way in.
    expect((await loadOverrides(acme, 'conv-acme')).spaceIds).toBeNull();
  });

  it('never throws on the chat hot path when the settings read fails', async () => {
    const broken = {
      from: () => {
        throw new Error('la base se cayó');
      },
    } as unknown as Parameters<typeof loadOverrides>[0];

    // A diagnostics setting that cannot be read costs the default behaviour,
    // never the answer.
    await expect(loadOverrides(broken, 'conv-acme')).resolves.toMatchObject({
      fragmentLimit: null,
      mutedFamilies: [],
    });
  });
});
