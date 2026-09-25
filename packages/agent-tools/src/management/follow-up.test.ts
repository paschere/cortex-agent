import { describe, expect, it } from 'vitest';
import {
  type FollowUpNotice,
  type FollowUpPerson,
  bogotaDateOf,
  businessDaysBetween,
  colombianHolidays,
  easterSunday,
  followUpKey,
  followUpReasonText,
  followUpReasons,
  isBusinessDay,
  planFollowUps,
} from './follow-up';
import { type ManagementCase, managementCaseSchema } from './shape';

/**
 * Lo que estas pruebas cuidan: un aviso a la persona equivocada, o un escalado
 * un día antes de tiempo, no se ve roto en ninguna pantalla. El correo sale, el
 * libro dice «entregado» y el único síntoma es que alguien se sintió acusado.
 */

const owner = '11111111-1111-4111-a111-111111111111';
const boss = '22222222-2222-4222-a222-222222222222';
const admin = '33333333-3333-4333-a333-333333333333';
const escalator = '44444444-4444-4444-a444-444444444444';
const stranger = '99999999-9999-4999-a999-999999999999';
const caseId = 'cccccccc-cccc-4ccc-accc-cccccccccccc';

const people: FollowUpPerson[] = [
  { id: admin, role: 'org_admin', managerId: null },
  { id: boss, role: 'member', managerId: admin },
  { id: owner, role: 'member', managerId: boss },
  { id: escalator, role: 'member', managerId: null },
];

function item(
  data: Partial<ManagementCase['data']> = {},
  extra: Partial<ManagementCase> = {},
): ManagementCase {
  return {
    id: caseId,
    data: {
      ...managementCaseSchema.parse({
        title: 'Conciliar cartera',
        objective: 'Cuadrar saldos',
        successCriteria: 'Saldo conciliado',
        ownerId: owner,
        dueOn: '2026-09-30',
        nextReviewOn: '2026-09-21',
        impact: 'high',
        nextAction: 'Pedir extracto',
        state: 'working',
      }),
      ...data,
    },
    revision: 3,
    created_by: admin,
    updated_by: owner,
    created_at: '2026-09-01T15:00:00Z',
    updated_at: '2026-09-15T15:00:00Z',
    ...extra,
  };
}

const notice = (n: Partial<FollowUpNotice>): FollowUpNotice => ({
  caseId,
  caseRevision: 3,
  step: 'owner',
  sentOn: '2026-09-21',
  delivered: true,
  ...n,
});

describe('seguimiento: días hábiles en Bogotá', () => {
  it('calcula la Pascua', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });

  it('conoce los festivos de 2026, con los que se corren al lunes', () => {
    const h = colombianHolidays(2026);
    for (const day of [
      '2026-01-01',
      '2026-01-12', // Reyes, del martes 6 al lunes
      '2026-03-23', // San José
      '2026-04-02', // Jueves Santo
      '2026-04-03', // Viernes Santo
      '2026-05-01',
      '2026-05-18', // Ascensión
      '2026-06-08', // Corpus Christi
      '2026-06-15', // Sagrado Corazón
      '2026-06-29', // San Pedro, ya es lunes
      '2026-07-20',
      '2026-08-07',
      '2026-08-17', // Asunción
      '2026-10-12',
      '2026-11-02', // Todos los Santos
      '2026-11-16', // Cartagena
      '2026-12-08',
      '2026-12-25',
    ])
      expect(h.has(day), day).toBe(true);
    expect(h.size).toBe(18);
    expect(h.has('2026-01-06')).toBe(false);
  });

  it('fines de semana y festivos no son hábiles', () => {
    expect(isBusinessDay('2026-09-24')).toBe(true); // jueves
    expect(isBusinessDay('2026-09-26')).toBe(false); // sábado
    expect(isBusinessDay('2026-09-27')).toBe(false); // domingo
    expect(isBusinessDay('2026-10-12')).toBe(false); // festivo
  });

  it('cuenta (desde, hasta]: el día del aviso no cuenta y hoy sí', () => {
    expect(businessDaysBetween('2026-09-21', '2026-09-21')).toBe(0);
    expect(businessDaysBetween('2026-09-21', '2026-09-22')).toBe(1);
    expect(businessDaysBetween('2026-09-21', '2026-09-23')).toBe(2); // lunes → miércoles
    expect(businessDaysBetween('2026-09-25', '2026-09-28')).toBe(1); // viernes → lunes
    expect(businessDaysBetween('2026-09-25', '2026-09-29')).toBe(2); // viernes → martes
    // Viernes antes del lunes festivo del 12 de octubre: escala el miércoles.
    expect(businessDaysBetween('2026-10-09', '2026-10-13')).toBe(1);
    expect(businessDaysBetween('2026-10-09', '2026-10-14')).toBe(2);
    expect(businessDaysBetween('2026-09-23', '2026-09-21')).toBe(0);
  });

  it('el día de un timestamp es el de Bogotá, no el de UTC', () => {
    expect(bogotaDateOf('2026-09-22T03:00:00Z')).toBe('2026-09-21');
    expect(bogotaDateOf('2026-09-22T05:00:00Z')).toBe('2026-09-22');
  });
});

describe('seguimiento: qué pone un asunto en la lista', () => {
  const today = '2026-09-24';

  it('revisión llegada', () => {
    expect(followUpReasons(item().data, '2026-09-15', today)).toEqual(['review_due']);
  });

  it('nada si todo está en su plazo', () => {
    expect(followUpReasons(item({ nextReviewOn: '2026-09-28' }).data, '2026-09-15', today)).toEqual(
      [],
    );
  });

  it('vencido y sin tocar desde el plazo', () => {
    const data = item({ dueOn: '2026-09-20', nextReviewOn: '2026-09-28' }).data;
    expect(followUpReasons(data, '2026-09-15', today)).toEqual(['overdue']);
  });

  it('vencido pero actualizado después, con revisión futura: está en gestión', () => {
    const data = item({ dueOn: '2026-09-20', nextReviewOn: '2026-09-28' }).data;
    expect(followUpReasons(data, '2026-09-22', today)).toEqual([]);
  });

  it('bloqueado sin novedades en 3 días hábiles, no antes', () => {
    const data = item({
      state: 'blocked',
      blocker: 'Falta firma',
      nextReviewOn: '2026-09-30',
    }).data;
    expect(followUpReasons(data, '2026-09-21', today)).toEqual(['blocked_stale']);
    expect(followUpReasons(data, '2026-09-22', today)).toEqual([]);
  });

  it('sin responsable, o con uno que ya no está', () => {
    const data = item({ ownerId: null, state: 'open', nextReviewOn: '2026-09-30' }).data;
    expect(followUpReasons(data, '2026-09-23', today)).toEqual(['unowned']);
    expect(
      followUpReasons(item({ nextReviewOn: '2026-09-30' }).data, '2026-09-23', today, false),
    ).toEqual(['unowned']);
  });

  it('por verificar, cerrado o descartado no se persigue', () => {
    for (const state of ['review', 'verified', 'cancelled'] as const)
      expect(followUpReasons(item({ state, dueOn: '2026-09-01' }).data, '', today)).toEqual([]);
  });

  it('redacta el motivo con fechas en español', () => {
    const data = item({ dueOn: '2026-09-20' }).data;
    expect(followUpReasonText('overdue', data, '')).toBe('El plazo venció el 20 de septiembre.');
    expect(followUpReasonText('blocked_stale', data, '2026-09-01')).toContain('1 de septiembre');
  });
});

describe('seguimiento: quién recibe qué y cuándo', () => {
  const base = { people, escalationOwnerId: null, today: '2026-09-21' };

  it('paso 1 al responsable cuando no se ha dicho nada', () => {
    const [p] = planFollowUps({ ...base, cases: [item()], notices: [] });
    expect(p).toMatchObject({ step: 'owner', recipients: [owner], cc: [], caseRevision: 3 });
    expect(p?.reasons).toEqual(['review_due']);
  });

  it('no repite el paso 1 de la misma revisión, y no escala antes de dos días hábiles', () => {
    const notices = [notice({ sentOn: '2026-09-21' })];
    expect(planFollowUps({ ...base, cases: [item()], notices, today: '2026-09-21' })).toEqual([]);
    expect(planFollowUps({ ...base, cases: [item()], notices, today: '2026-09-22' })).toEqual([]);
  });

  it('escala al jefe del responsable a los dos días hábiles, con copia al responsable', () => {
    const [p] = planFollowUps({
      ...base,
      cases: [item()],
      notices: [notice({ sentOn: '2026-09-21' })],
      today: '2026-09-23',
    });
    expect(p).toMatchObject({
      step: 'escalation',
      recipients: [boss],
      cc: [owner],
      via: 'manager',
      firstNoticeOn: '2026-09-21',
    });
  });

  it('el responsable de escalamiento del perfil gana sobre el jefe', () => {
    const [p] = planFollowUps({
      ...base,
      escalationOwnerId: escalator,
      cases: [item()],
      notices: [notice({ sentOn: '2026-09-21' })],
      today: '2026-09-23',
    });
    expect(p).toMatchObject({ recipients: [escalator], via: 'named' });
  });

  it('un escalamiento nombrado que es el propio responsable o alguien de fuera no cuenta', () => {
    for (const named of [owner, stranger]) {
      const [p] = planFollowUps({
        ...base,
        escalationOwnerId: named,
        cases: [item()],
        notices: [notice({ sentOn: '2026-09-21' })],
        today: '2026-09-23',
      });
      expect(p).toMatchObject({ recipients: [boss], via: 'manager' });
    }
  });

  it('sin jefe, al primer administrador; si el responsable es ese administrador, a nadie', () => {
    const lone = [
      { id: admin, role: 'org_admin', managerId: null },
      { id: owner, role: 'member', managerId: null },
    ];
    const args = {
      ...base,
      people: lone,
      notices: [notice({ sentOn: '2026-09-21' })],
      today: '2026-09-23',
    };
    expect(planFollowUps({ ...args, cases: [item()] })[0]).toMatchObject({
      recipients: [admin],
      via: 'admin',
    });
    expect(planFollowUps({ ...args, cases: [item({ ownerId: admin })] })).toEqual([]);
  });

  it('un aviso que no llegó no inicia el reloj: se reintenta el paso 1', () => {
    const [p] = planFollowUps({
      ...base,
      cases: [item()],
      notices: [notice({ delivered: false })],
      today: '2026-09-23',
    });
    expect(p?.step).toBe('owner');
  });

  it('una revisión nueva (el responsable respondió) reinicia en el paso 1', () => {
    const [p] = planFollowUps({
      ...base,
      cases: [item({}, { revision: 4, updated_at: '2026-09-22T15:00:00Z' })],
      notices: [notice({ sentOn: '2026-09-21' })],
      today: '2026-09-23',
    });
    expect(p).toMatchObject({ step: 'owner', caseRevision: 4 });
  });

  it('no escala dos veces la misma revisión', () => {
    expect(
      planFollowUps({
        ...base,
        cases: [item()],
        notices: [notice({}), notice({ step: 'escalation', sentOn: '2026-09-23' })],
        today: '2026-09-28',
      }),
    ).toEqual([]);
  });

  it('sin responsable: a todos los administradores, una sola vez en la vida del asunto', () => {
    const unowned = item({ ownerId: null, state: 'open' });
    const [p] = planFollowUps({ ...base, cases: [unowned], notices: [] });
    expect(p).toMatchObject({ step: 'unowned', recipients: [admin], cc: [] });
    expect(
      planFollowUps({
        ...base,
        cases: [{ ...unowned, revision: 9 }],
        notices: [notice({ step: 'unowned', caseRevision: 3 })],
      }),
    ).toEqual([]);
  });

  it('un responsable que ya no está en la empresa se trata como sin responsable', () => {
    const [p] = planFollowUps({ ...base, cases: [item({ ownerId: stranger })], notices: [] });
    expect(p).toMatchObject({ step: 'unowned', recipients: [admin] });
    expect(p?.recipients).not.toContain(stranger);
  });

  it('nunca escribe a alguien fuera del directorio', () => {
    const plan = planFollowUps({
      ...base,
      escalationOwnerId: stranger,
      cases: [item(), item({ ownerId: stranger })],
      notices: [notice({ sentOn: '2026-09-14' })],
    });
    const everyone = plan.flatMap((p) => [...p.recipients, ...p.cc]);
    expect(everyone).not.toContain(stranger);
    for (const id of everyone) expect(people.some((p) => p.id === id)).toBe(true);
  });
});

describe('seguimiento: claves de aviso', () => {
  it('una por (asunto, revisión, paso); la de sin responsable no lleva revisión', () => {
    expect(followUpKey(caseId, 3, 'owner')).toBe(`management-case:${caseId}:owner:3`);
    expect(followUpKey(caseId, 3, 'escalation')).toBe(`management-case:${caseId}:escalation:3`);
    expect(followUpKey(caseId, 3, 'unowned')).toBe(followUpKey(caseId, 7, 'unowned'));
    expect(followUpKey(caseId, 3, 'owner')).not.toBe(followUpKey(caseId, 4, 'owner'));
  });
});
