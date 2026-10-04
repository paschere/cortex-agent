import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * INVITAR VARIOS, UNO POR UNO, CON UN RESULTADO CADA UNO.
 *
 * Lo que importa comprobar: que el tope de asientos se vuelva a mirar en cada
 * invitación (la tercera de cinco puede ser la que no cabe), que «ya es
 * miembro» no gaste un asiento ni llame a better-auth, que el mensaje llegue al
 * gancho del correo por el contexto asíncrono, y que cargo y equipo se guarden
 * atados al id de la invitación y se apliquen UNA vez al aceptar.
 */

const state = vi.hoisted(() => ({
  members: new Set<string>(),
  pending: new Map<string, { id: string; message: string | null }>(),
  invited: [] as string[],
  messagesSeen: [] as Array<string | null>,
  seatsLeft: 99,
  saved: [] as unknown[][],
  applied: [] as unknown[][],
  detailsRow: null as null | {
    position: string | null;
    teamId: string | null;
    teamName: string | null;
  },
}));

vi.mock('../auth', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('from public.ba_member m')) {
        return { rows: state.members.has(String(params[1])) ? [{ one: 1 }] : [] };
      }
      if (sql.includes('from public.ba_invitation i') && sql.includes('limit 1')) {
        const hit = state.pending.get(String(params[1]));
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('insert into public.invitation_details')) {
        state.saved.push(params);
        return { rows: [] };
      }
      if (sql.includes('from public.invitation_details d')) {
        return { rows: state.detailsRow ? [state.detailsRow] : [] };
      }
      if (
        sql.includes('insert into public.work_people_meta') ||
        sql.includes('insert into public.team_members')
      ) {
        state.applied.push([sql.includes('work_people_meta') ? 'meta' : 'team', ...params]);
        return { rows: [] };
      }
      if (sql.includes('update public.invitation_details set applied_at')) {
        state.applied.push(['applied_at', ...params]);
        return { rows: [] };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    },
  },
}));

vi.mock('../session-directory', () => ({
  resolveSessionDirectory: async () => ({
    id: 'dir-1',
    email: 'ana@x.co',
    name: 'Ana',
    role: 'member',
  }),
}));
vi.mock('../supabase/service', () => ({ getOrgScopedClient: () => ({}) }));
vi.mock('./invitations', () => ({ cancelInvitation: async () => true }));

vi.mock('./membership-admin', async () => {
  const { currentInvitationMessage } = await import('./invitation-context');
  return {
    inviteToCompany: async (input: { email: string }) => {
      state.messagesSeen.push(currentInvitationMessage());
      if (state.seatsLeft <= 0) {
        return {
          ok: false,
          status: 402,
          reason: 'plan_limit',
          message: 'Tu plan llega hasta 3 personas y ya están ocupadas.',
        };
      }
      state.seatsLeft -= 1;
      state.invited.push(input.email);
      return { ok: true, status: 200, message: 'Invitación enviada.', id: `inv-${input.email}` };
    },
  };
});

const { inviteEmails, applyInvitationDetails, cleanDetails } = await import('./invite-flow');

const base = { organizationId: 'org-1', role: 'member' as const, requestHeaders: new Headers() };

beforeEach(() => {
  state.members = new Set();
  state.pending = new Map();
  state.invited = [];
  state.messagesSeen = [];
  state.seatsLeft = 99;
  state.saved = [];
  state.applied = [];
  state.detailsRow = null;
});

describe('inviteEmails', () => {
  it('manda a cada correo y devuelve un resultado por cada uno', async () => {
    const results = await inviteEmails({ ...base, emails: ['a@x.co', 'b@x.co'] });
    expect(results.map((r) => [r.email, r.status])).toEqual([
      ['a@x.co', 'sent'],
      ['b@x.co', 'sent'],
    ]);
    expect(state.invited).toEqual(['a@x.co', 'b@x.co']);
  });

  it('«ya es miembro» no llama a better-auth ni gasta asiento', async () => {
    state.members.add('ana@x.co');
    const results = await inviteEmails({ ...base, emails: ['ana@x.co', 'b@x.co'] });
    expect(results[0]?.status).toBe('already_member');
    expect(state.invited).toEqual(['b@x.co']);
  });

  it('cuando se acaba el cupo, las siguientes salen «sin cupo» sin volver a intentar', async () => {
    state.seatsLeft = 1;
    const results = await inviteEmails({ ...base, emails: ['a@x.co', 'b@x.co', 'c@x.co'] });
    expect(results.map((r) => r.status)).toEqual(['sent', 'no_seats', 'no_seats']);
    // Sólo la segunda llegó a preguntar; la tercera ya sabía que no cabía.
    expect(state.messagesSeen).toHaveLength(2);
  });

  it('un correo inválido se informa sin llamar a nadie', async () => {
    const results = await inviteEmails({ ...base, emails: ['hola'] });
    expect(results[0]?.status).toBe('invalid');
    expect(state.invited).toEqual([]);
  });

  it('pasa el mensaje personal al gancho del correo por el contexto', async () => {
    await inviteEmails({ ...base, emails: ['a@x.co'], details: { message: 'Bienvenida' } });
    expect(state.messagesSeen).toEqual(['Bienvenida']);
  });

  it('reenviar sin mensaje nuevo conserva el que ya llevaba la invitación', async () => {
    state.pending.set('a@x.co', { id: 'inv-old', message: 'El de antes' });
    const [result] = await inviteEmails({ ...base, emails: ['a@x.co'] });
    expect(state.messagesSeen).toEqual(['El de antes']);
    expect(result?.message).toMatch(/Reenviada/);
  });

  it('guarda cargo, equipo y mensaje atados al id de la invitación', async () => {
    await inviteEmails({
      ...base,
      emails: ['a@x.co'],
      details: { message: 'Hola', position: 'Analista', teamId: 'team-1' },
      inviterAccountId: 'acc-1',
    });
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]).toEqual(['inv-a@x.co', 'org-1', 'Hola', 'Analista', 'team-1', 'acc-1']);
  });

  it('sin mensaje, cargo ni equipo no escribe la tabla de detalles', async () => {
    await inviteEmails({ ...base, emails: ['a@x.co'] });
    expect(state.saved).toEqual([]);
  });

  it('respeta el tope de 25 por petición', async () => {
    const emails = Array.from({ length: 40 }, (_, i) => `p${i}@x.co`);
    const results = await inviteEmails({ ...base, emails });
    expect(results).toHaveLength(25);
  });
});

describe('cleanDetails', () => {
  it('recorta, limita y vuelve null lo vacío', () => {
    expect(cleanDetails({ message: '  ', position: 'x'.repeat(200), teamId: '' })).toEqual({
      message: null,
      position: 'x'.repeat(80),
      teamId: null,
    });
  });
});

describe('applyInvitationDetails', () => {
  const input = { invitationId: 'inv-1', organizationId: 'org-1', accountId: 'acc-1' };

  it('pone el cargo y el equipo de la persona y marca la invitación como aplicada', async () => {
    state.detailsRow = { position: 'Analista', teamId: 'team-1', teamName: 'Cartera' };
    const out = await applyInvitationDetails(input);
    expect(out).toEqual({ position: 'Analista', teamName: 'Cartera' });
    expect(state.applied.map((a) => a[0])).toEqual(['meta', 'team', 'applied_at']);
    expect(state.applied[0]).toEqual(['meta', 'org-1', 'dir-1', 'Analista']);
    expect(state.applied[1]).toEqual(['team', 'team-1', 'dir-1', 'org-1']);
  });

  it('no hace nada si ya se aplicó o no hay detalles', async () => {
    state.detailsRow = null;
    expect(await applyInvitationDetails(input)).toEqual({ position: null, teamName: null });
    expect(state.applied).toEqual([]);
  });
});
