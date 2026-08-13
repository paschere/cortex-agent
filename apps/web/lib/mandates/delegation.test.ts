import { describe, expect, it } from 'vitest';
import {
  type ExercisedMandate,
  authorizationPhrase,
  delegatedByOf,
  delegationHeadline,
  formatDay,
  groupTurnDelegations,
  lastUseSentence,
  matchExercised,
  planNotices,
  summarizeUses,
} from './delegation';

/**
 * Las tres cosas que este archivo tiene que garantizar, y por qué son estas:
 *
 *   1. LA RAZÓN SALE DE LA FILA. «Como me autorizaste el 3 de agosto» se compone
 *      de `created_at` y `granted_by` y de nada más. Si algún día alguien mete
 *      ahí una frase generada, o un valor por defecto plausible para cuando
 *      falta la fecha, estas pruebas caen — que es el único motivo por el que
 *      existen.
 *   2. EL AGRUPADO CUANDO HAY MUCHOS USOS. Cuarenta llamadas bajo un mandato son
 *      un aviso con un contador, no cuarenta avisos. Un fallo aquí no rompe
 *      nada visiblemente: simplemente hace que la persona apague el aviso, y
 *      entonces el que importa tampoco se lee.
 *   3. Que un mandato revocado deje de autorizar — eso está en revocation.test.ts,
 *      porque se prueba contra la lectura de verdad y no contra estas funciones.
 */

const AGOSTO = '2026-08-03T20:00:00.000Z'; // 3 de agosto, 15:00 en Bogotá
const AHORA = new Date('2026-08-13T12:00:00.000Z');

describe('la razón que acompaña a un acto delegado', () => {
  it('se compone de la fila del mandato: la fecha de created_at y la persona de granted_by', () => {
    expect(
      authorizationPhrase(
        {
          label: 'Correos a clientes',
          grantedByName: 'Ana Ruiz',
          grantedByIsViewer: true,
          createdAt: AGOSTO,
        },
        AHORA,
      ),
    ).toBe('como me autorizaste el 3 de agosto');

    expect(
      authorizationPhrase(
        {
          label: 'Correos a clientes',
          grantedByName: 'Ana Ruiz',
          grantedByIsViewer: false,
          createdAt: AGOSTO,
        },
        AHORA,
      ),
    ).toBe('como me autorizó Ana Ruiz el 3 de agosto');
  });

  it('no depende de nada más que de la fila: el nombre del mandato no entra en la frase', () => {
    const base = {
      grantedByName: 'Ana Ruiz',
      grantedByIsViewer: false,
      createdAt: AGOSTO,
    };
    expect(authorizationPhrase({ ...base, label: 'Correos a clientes' }, AHORA)).toBe(
      authorizationPhrase({ ...base, label: 'Otro nombre completamente distinto' }, AHORA),
    );
  });

  it('es literalmente el texto fijo más la fecha formateada de la fila, sin nada añadido', () => {
    const day = formatDay(AGOSTO, AHORA);
    expect(day).toBe('3 de agosto');
    expect(
      authorizationPhrase(
        { label: 'X', grantedByName: 'Ana Ruiz', grantedByIsViewer: false, createdAt: AGOSTO },
        AHORA,
      ),
    ).toBe(`como me autorizó Ana Ruiz el ${day}`);
  });

  it('dice el año cuando el permiso no es de este año', () => {
    expect(
      authorizationPhrase(
        {
          label: 'X',
          grantedByName: 'Ana Ruiz',
          grantedByIsViewer: true,
          createdAt: '2025-11-20T15:00:00.000Z',
        },
        AHORA,
      ),
    ).toBe('como me autorizaste el 20 de noviembre de 2025');
  });

  it('devuelve null antes que inventarse una fecha', () => {
    for (const createdAt of [null, '', 'no es una fecha']) {
      expect(
        authorizationPhrase(
          { label: 'X', grantedByName: 'Ana Ruiz', grantedByIsViewer: true, createdAt },
          AHORA,
        ),
      ).toBeNull();
    }
  });

  it('dice lo que consta cuando el nombre no se pudo resolver, y no se lo inventa', () => {
    expect(
      authorizationPhrase(
        { label: 'X', grantedByName: null, grantedByIsViewer: false, createdAt: AGOSTO },
        AHORA,
      ),
    ).toBe('como me autorizaron el 3 de agosto');
  });
});

// ---------------------------------------------------------------------------

function delegated(toolName: string, label: string) {
  return { toolName, state: 'result', result: { ok: true, _security: { delegatedBy: label } } };
}

describe('la señal de que hubo autonomía', () => {
  it('solo la da `_security.delegatedBy`, que es lo que registry.ts pega al resultado', () => {
    expect(delegatedByOf({ _security: { delegatedBy: 'Correos a clientes' } })).toBe(
      'Correos a clientes',
    );
    // Un aviso de riesgo SIN mandato: la persona sí confirmó. No es delegación.
    expect(delegatedByOf({ _security: { riskLevel: 'high', notice: 'ojo' } })).toBeNull();
    expect(delegatedByOf({ ok: true })).toBeNull();
    expect(delegatedByOf(null)).toBeNull();
    expect(delegatedByOf('texto')).toBeNull();
  });
});

describe('el agrupado, para que cuarenta usos no sean cuarenta avisos', () => {
  it('cuarenta llamadas bajo el mismo mandato son UN aviso con un contador', () => {
    const invocations = Array.from({ length: 40 }, () =>
      delegated('gmail.send_draft', 'Correos a clientes'),
    );
    const [only, ...rest] = groupTurnDelegations(invocations);
    expect(rest).toEqual([]);
    expect(only?.calls).toBe(40);
    expect(only?.toolIds).toEqual(['gmail.send_draft']);
    expect(only && delegationHeadline(only)).toBe(
      'Usé «enviar el correo redactado» 40 veces sin preguntarte',
    );
  });

  it('dos mandatos distintos en el mismo turno son dos avisos: son dos permisos', () => {
    const groups = groupTurnDelegations([
      delegated('gmail.send_draft', 'Correos a clientes'),
      delegated('clients.update', 'Fichas de cliente'),
      delegated('gmail.send_draft', 'Correos a clientes'),
      { toolName: 'kb.search', state: 'result', result: { ok: true } },
    ]);
    expect(groups.map((g) => [g.label, g.calls])).toEqual([
      ['Correos a clientes', 2],
      ['Fichas de cliente', 1],
    ]);
  });

  it('cuenta las llamadas y no repite la herramienta', () => {
    const [only] = groupTurnDelegations([
      delegated('gmail.send_draft', 'M'),
      delegated('gmail.send_draft', 'M'),
      delegated('clients.update', 'M'),
    ]);
    expect(only?.calls).toBe(3);
    expect(only?.toolIds).toEqual(['gmail.send_draft', 'clients.update']);
    expect(only && delegationHeadline(only)).toBe(
      'Hice 3 cosas sin preguntarte, con 2 herramientas',
    );
  });

  it('enseña entero el primer aviso de cada mandato y en una línea los siguientes', () => {
    const plan = planNotices([
      { id: 'm1', invocations: [delegated('gmail.send_draft', 'Correos a clientes')] },
      { id: 'm2', invocations: [] },
      { id: 'm3', invocations: [delegated('gmail.send_draft', 'Correos a clientes')] },
      {
        id: 'm4',
        invocations: [
          delegated('gmail.send_draft', 'Correos a clientes'),
          delegated('clients.update', 'Fichas de cliente'),
        ],
      },
    ]);

    expect(plan.m1?.map((d) => d.variant)).toEqual(['full']);
    expect(plan.m2).toBeUndefined();
    expect(plan.m3?.map((d) => d.variant)).toEqual(['brief']);
    // El mandato NUEVO se enseña entero aunque llegue en el cuarto mensaje: es
    // ahí donde vive la información, y es lo que la regla protege.
    expect(plan.m4?.map((d) => [d.label, d.variant])).toEqual([
      ['Correos a clientes', 'brief'],
      ['Fichas de cliente', 'full'],
    ]);
  });
});

describe('casar un aviso con la fila que lo autorizó', () => {
  const base: Omit<ExercisedMandate, 'mandateId' | 'toolIds'> = {
    label: 'Correos a clientes',
    grantedByName: 'Ana Ruiz',
    grantedByIsViewer: false,
    createdAt: AGOSTO,
    state: 'active',
    calls: 1,
    lastUsedAt: AGOSTO,
  };

  it('casa por nombre cuando solo hay una concesión con ese nombre', () => {
    const match = matchExercised(
      { label: 'Correos a clientes', toolIds: ['gmail_send_draft'], calls: 1 },
      [{ ...base, mandateId: 'a', toolIds: ['gmail.send_draft'] }],
    );
    expect(match?.mandateId).toBe('a');
  });

  it('desempata por herramienta cuando dos concesiones se llaman igual', () => {
    const match = matchExercised(
      { label: 'Correos a clientes', toolIds: ['clients_update'], calls: 1 },
      [
        { ...base, mandateId: 'a', toolIds: ['gmail.send_draft'] },
        { ...base, mandateId: 'b', toolIds: ['clients.update'] },
      ],
    );
    expect(match?.mandateId).toBe('b');
  });

  it('prefiere no ofrecer nada antes que ofrecer revocar la concesión equivocada', () => {
    const match = matchExercised(
      { label: 'Correos a clientes', toolIds: ['gmail_send_draft'], calls: 1 },
      [
        { ...base, mandateId: 'a', toolIds: ['gmail.send_draft'] },
        { ...base, mandateId: 'b', toolIds: ['gmail.send_draft'] },
      ],
    );
    expect(match).toBeNull();
  });
});

describe('el uso agrupado que enseña la pantalla del mandato', () => {
  const uses = [
    ...Array.from({ length: 40 }, (_, i) => ({
      mandate_id: 'a',
      tool_id: 'gmail.send_draft',
      used_at: `2026-08-${String(1 + (i % 10)).padStart(2, '0')}T12:00:00.000Z`,
    })),
    { mandate_id: 'a', tool_id: 'clients.update', used_at: '2026-08-12T12:00:00.000Z' },
    {
      mandate_id: 'b',
      tool_id: 'payments.record',
      used_at: '2026-08-11T12:00:00.000Z',
      amount: '150000.00',
      currency: 'COP',
    },
    {
      mandate_id: 'b',
      tool_id: 'payments.record',
      used_at: '2026-08-09T12:00:00.000Z',
      amount: 20,
      currency: 'USD',
    },
  ];

  it('cuarenta usos de una herramienta son UNA fila con su contador', () => {
    const summary = summarizeUses(uses);
    expect(summary.a?.calls).toBe(41);
    expect(summary.a?.byTool).toHaveLength(2);
    expect(summary.a?.byTool[0]).toMatchObject({ toolId: 'gmail.send_draft', calls: 40 });
    expect(summary.a?.byTool[1]).toMatchObject({ toolId: 'clients.update', calls: 1 });
    expect(summary.a?.lastUsedAt).toBe('2026-08-12T12:00:00.000Z');
  });

  it('nunca suma dos monedas en un mismo número', () => {
    const summary = summarizeUses(uses);
    expect(summary.b?.money).toEqual([
      { currency: 'COP', total: 150000 },
      { currency: 'USD', total: 20 },
    ]);
  });

  it('un mandato sin usos no aparece, y el llamante usa EMPTY_USAGE', () => {
    expect(summarizeUses([]).a).toBeUndefined();
  });
});

describe('cuándo fue la última vez', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');

  it('cuenta los días desde el último uso', () => {
    expect(
      lastUseSentence({
        lastUsedAt: '2026-08-13T01:00:00.000Z',
        createdAt: AGOSTO,
        windowDays: 90,
        now,
      }),
    ).toBe('La última vez fue hoy');
    expect(
      lastUseSentence({
        lastUsedAt: '2026-08-12T01:00:00.000Z',
        createdAt: AGOSTO,
        windowDays: 90,
        now,
      }),
    ).toBe('La última vez fue ayer');
    expect(
      lastUseSentence({
        lastUsedAt: '2026-08-03T01:00:00.000Z',
        createdAt: AGOSTO,
        windowDays: 90,
        now,
      }),
    ).toBe('La última vez fue hace 10 días');
  });

  it('cuando la ventana cubre toda la vida del mandato, lo dice fuerte', () => {
    expect(
      lastUseSentence({
        lastUsedAt: null,
        createdAt: '2026-06-12T12:00:00.000Z',
        windowDays: 90,
        now,
      }),
    ).toBe('No lo ha ejercido ni una vez desde que se concedió, hace 62 días');
  });

  it('cuando el mandato es más viejo que la ventana, no afirma más de lo que se leyó', () => {
    expect(
      lastUseSentence({
        lastUsedAt: null,
        createdAt: '2025-01-01T12:00:00.000Z',
        windowDays: 90,
        now,
      }),
    ).toBe('No lo ha ejercido en los últimos 90 días');
  });
});
