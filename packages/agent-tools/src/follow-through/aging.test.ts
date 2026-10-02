import { describe, expect, it } from 'vitest';
import { agingClaimKey, agingNotice, planApprovalAging, waitingAgePhrase } from './aging';

const NOW = new Date('2026-10-02T13:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const action = (
  id: string,
  userId: string,
  ageHours: number,
  extra: Partial<{ state: string; expiresAt: string }> = {},
) => ({
  id,
  userId,
  state: 'proposed',
  createdAt: hoursAgo(ageHours),
  expiresAt: inDays(7 - ageHours / 24),
  headline: `Cobro de cartera a ${id}@cliente.co`,
  ...extra,
});

describe('lo que lleva días esperando tu visto bueno', () => {
  it('un recordatorio por persona y día, con todos sus borradores de más de un día', () => {
    const plans = planApprovalAging({
      actions: [
        action('a', 'u1', 30),
        action('b', 'u1', 50),
        action('c', 'u1', 2),
        action('d', 'u2', 26),
      ],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set(),
    });
    expect(plans).toEqual([
      expect.objectContaining({
        userId: 'u1',
        step: 'reminder',
        refs: ['2026-10-02'],
        actionIds: ['b', 'a'],
        oldestHours: 50,
      }),
      expect.objectContaining({ userId: 'u2', step: 'reminder', actionIds: ['d'] }),
    ]);
  });

  it('el recordatorio de hoy ya dado no se repite', () => {
    const plans = planApprovalAging({
      actions: [action('a', 'u1', 30)],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set([agingClaimKey('u1', 'approval_reminder', '2026-10-02')]),
    });
    expect(plans).toEqual([]);
  });

  it('a los cinco días se pregunta «¿lo descarto?», una vez por borrador, y no se recuerda además', () => {
    const plans = planApprovalAging({
      actions: [
        action('viejo', 'u1', 5 * 24 + 1),
        action('otro', 'u1', 6 * 24),
        action('a', 'u1', 30),
      ],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set([agingClaimKey('u1', 'approval_discard', 'otro')]),
    });
    expect(plans.map((p) => [p.step, p.actionIds])).toEqual([
      ['discard', ['viejo']],
      ['reminder', ['a']],
    ]);
  });

  it('lo decidido, lo vencido o lo de fecha ilegible no se avisa', () => {
    const plans = planApprovalAging({
      actions: [
        action('ok', 'u1', 30, { state: 'approved' }),
        action('venc', 'u1', 30, { expiresAt: hoursAgo(1) }),
        { ...action('roto', 'u1', 30), createdAt: 'ayer' },
      ],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set(),
    });
    expect(plans).toEqual([]);
  });

  it('el aviso nombra lo que espera y a dónde ir, sin un aviso por borrador', () => {
    const [plan] = planApprovalAging({
      actions: [
        action('a', 'u1', 49),
        action('b', 'u1', 30),
        action('c', 'u1', 26),
        action('d', 'u1', 25),
      ],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set(),
    });
    const n = plan && agingNotice(plan);
    expect(n?.title).toBe('Tienes 4 borradores esperando tu visto bueno');
    expect(n?.body).toContain('El más viejo lleva dos días');
    expect(n?.body).toContain('y 1 otro');
    expect(n?.href).toBe('/actions');
  });

  it('el «¿lo descarto?» lleva a los viejos en Acciones', () => {
    const [plan] = planApprovalAging({
      actions: [action('v', 'u1', 6 * 24)],
      now: NOW,
      today: '2026-10-02',
      claimed: new Set(),
    });
    const n = plan && agingNotice(plan);
    expect(n?.title).toBe('Un borrador lleva seis días esperando: ¿lo descarto?');
    expect(n?.href).toBe('/actions?viejos=1');
  });

  it('la edad se dice en palabras y sólo desde un día', () => {
    expect(waitingAgePhrase(hoursAgo(5), NOW)).toBeNull();
    expect(waitingAgePhrase(hoursAgo(26), NOW)).toBe('lleva un día esperando');
    expect(waitingAgePhrase(hoursAgo(73), NOW)).toBe('lleva tres días esperando');
    expect(waitingAgePhrase('nunca', NOW)).toBeNull();
  });
});
