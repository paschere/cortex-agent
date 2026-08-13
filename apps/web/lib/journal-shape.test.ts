import { describe, expect, it } from 'vitest';
import {
  bogotaClock,
  bogotaDay,
  buildJournal,
  cardinal,
  composeCommitmentWatch,
  composeDrafts,
  composeErrands,
  composeFlows,
  composeLearning,
  composeLingering,
  composeMandateUses,
  composeMemories,
  composeRoutines,
  composeSends,
  instant,
  journalHeadline,
} from './journal-shape';

/**
 * ESTAS PRUEBAS SON LA ESPECIFICACIÓN DEL PARTE DE TRABAJO.
 *
 * Defienden tres reglas, y las tres son de arquitectura antes que de redacción:
 *
 *   1. NINGUNA FRASE SALE DE UN MODELO. Que sea una función pura es lo que
 *      permite comprobar aquí, caso por caso, que dice la verdad. Si mañana
 *      alguien la sustituye por una llamada a la API, este archivo es lo primero
 *      que deja de poder existir.
 *   2. NI UNA LÍNEA INVENTADA. Cero filas produce cero líneas, siempre — nunca
 *      «el cron corrió» deducido del reloj.
 *   3. AGRUPA, NO ENUMERA, salvo lo que falló, lo que espera a una persona y lo
 *      que se hizo sin preguntar; y aun eso, con tope.
 *
 * Los instantes son fijos y llevan desfase explícito (`-05:00`), así que las
 * pruebas dan lo mismo en cualquier máquina: el formateo usa `America/Bogota`
 * pase lo que pase con la zona del proceso.
 */

// Un lunes cualquiera. 09:30 de la mañana en Bogotá.
const NOW = Date.parse('2026-08-10T09:30:00-05:00');
const at = (iso: string) => Date.parse(iso);

describe('el reloj de la jornada', () => {
  it('dice la hora de Bogotá, no la del servidor', () => {
    // Las 06:00 de Bogotá son las 11:00 UTC. Escrito en UTC a propósito.
    expect(bogotaClock(Date.parse('2026-08-10T11:00:00Z'))).toBe('06:00');
    expect(bogotaClock(Date.parse('2026-08-10T09:20:00Z'))).toBe('04:20');
  });

  it('nunca escribe un «24:00», que es una hora que no existe', () => {
    expect(bogotaClock(Date.parse('2026-08-10T00:00:00-05:00'))).toBe('00:00');
  });

  it('coloca en el día de Bogotá lo que en UTC ya es del día siguiente', () => {
    // 23:00 del 10 en Bogotá = 04:00 del 11 en UTC. Es del 10.
    expect(bogotaDay(Date.parse('2026-08-11T04:00:00Z'))).toBe('2026-08-10');
  });

  it('descarta una marca de tiempo ilegible en vez de colocarla a una hora cualquiera', () => {
    expect(instant('no es una fecha')).toBeNull();
    expect(instant(null)).toBeNull();
    expect(instant(undefined)).toBeNull();
    expect(instant('2026-08-10T11:00:00Z')).toBe(Date.parse('2026-08-10T11:00:00Z'));
  });
});

describe('los números, con el género de lo que cuentan', () => {
  it('distingue «un correo» de «una rutina»', () => {
    expect(cardinal(1, 'm')).toBe('un');
    expect(cardinal(1, 'f')).toBe('una');
  });

  it('escribe con letra hasta el doce y con cifra a partir del trece', () => {
    expect(cardinal(9, 'm')).toBe('nueve');
    expect(cardinal(12, 'f')).toBe('doce');
    expect(cardinal(47, 'm')).toBe('47');
  });
});

describe('el vigilante de vencimientos', () => {
  const notice = (
    id: string,
    hour: string,
    over: Partial<{ kind: string; delivered: boolean }> = {},
  ) => ({
    id,
    at: at(`2026-08-10T${hour}-05:00`),
    kind: (over.kind ?? 'ahead') as 'ahead' | 'due_today' | 'overdue' | 'escalation',
    delivered: over.delivered ?? true,
  });

  it('cuenta la pasada entera en una línea, no un renglón por aviso', () => {
    const lines = composeCommitmentWatch(
      [notice('a', '06:00:10'), notice('b', '06:00:20'), notice('c', '06:00:31')],
      47,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Revisé 47 vencimientos y avisé de tres.');
    expect(lines[0]?.clock).toBe('06:00');
  });

  it('no dice que revisó nada si el conteo no se pudo leer', () => {
    const lines = composeCommitmentWatch([notice('a', '06:00:10')], null);
    expect(lines[0]?.text).toBe('Avisé de un vencimiento.');
  });

  it('no inventa la pasada cuando no dejó ni un aviso', () => {
    // Cero avisos NO significa «revisé 47 y no avisé de ninguno»: significa que
    // no hay ninguna fila que pruebe que el cron corrió.
    expect(composeCommitmentWatch([], 47)).toEqual([]);
  });

  it('saca aparte lo que no logró salir, y lo marca para que alguien mire', () => {
    const lines = composeCommitmentWatch(
      [notice('a', '06:00:10'), notice('b', '06:00:20', { delivered: false })],
      12,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text).toBe('Uno de esos avisos no logró salir por correo.');
    expect(lines[1]?.attention).toBe(true);
    expect(lines[1]?.tone).toBe('rose');
  });

  it('dice cuándo tuvo que pasar por encima del dueño de un vencimiento', () => {
    const lines = composeCommitmentWatch([notice('a', '06:00:10', { kind: 'escalation' })], 3);
    expect(lines[1]?.text).toBe(
      'Uno llevaba tanto vencido sin respuesta que lo subí por encima de su dueño.',
    );
    expect(lines[1]?.attention).toBe(true);
  });
});

describe('los correos', () => {
  it('agrupa siempre los borradores: su cola ya existe en otra pantalla', () => {
    const lines = composeDrafts([
      { id: 'a', at: at('2026-08-10T06:30:00-05:00') },
      { id: 'b', at: at('2026-08-10T06:30:40-05:00') },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Te dejé dos correos listos para mandar.');
    expect(lines[0]?.clock).toBe('06:30');
  });

  it('nombra al destinatario cuando salió uno solo', () => {
    const lines = composeSends([
      {
        id: 'a',
        at: at('2026-08-10T09:14:00-05:00'),
        recipient: 'cartera@coltrans.com.co',
        ok: true,
        error: null,
      },
    ]);
    expect(lines[0]?.text).toBe('Mandé el correo que aprobaste a cartera@coltrans.com.co.');
  });

  it('junta los que salieron y separa cada uno que no', () => {
    const ok = (id: string) => ({
      id,
      at: at('2026-08-10T09:00:00-05:00'),
      recipient: `${id}@x.co`,
      ok: true,
      error: null,
    });
    const lines = composeSends([
      ok('a'),
      ok('b'),
      {
        id: 'c',
        at: at('2026-08-10T09:20:00-05:00'),
        recipient: 'pagos@naviera.co',
        ok: false,
        error: 'Gmail rechazó la dirección',
      },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Mandé dos correos que aprobaste.',
      'El correo a pagos@naviera.co no salió: Gmail rechazó la dirección.',
    ]);
    expect(lines[1]?.attention).toBe(true);
  });

  it('vuelve a agrupar los fallos cuando pasan del tope', () => {
    const bad = (id: string) => ({
      id,
      at: at('2026-08-10T09:00:00-05:00'),
      recipient: `${id}@x.co`,
      ok: false,
      error: null,
    });
    const lines = composeSends([bad('a'), bad('b'), bad('c'), bad('d'), bad('e')]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('cinco correos aprobados no lograron salir.');
  });
});

describe('lo que hizo sin preguntar', () => {
  // La coletilla llega ya escrita: la compone `authorizationPhrase` en
  // lib/mandates/delegation.ts, que es la misma que ve alguien en el chat
  // cuando Cortex acaba de actuar. Aquí sólo se comprueba que se engarza.
  const use = {
    id: 'u1',
    at: at('2026-08-10T11:02:00-05:00'),
    toolLabel: 'Enviar este correo tal cual',
    mandateLabel: 'Cobros a clientes',
    authorization: 'como me autorizaste el 3 de agosto',
    amount: null,
  };

  it('cuenta cada uno por separado, con el mandato y la fecha en que se lo autorizaron', () => {
    const lines = composeMandateUses([use]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(
      'Hice «Enviar este correo tal cual» sin preguntarte, como me autorizaste el 3 de agosto con el mandato «Cobros a clientes».',
    );
    expect(lines[0]?.clock).toBe('11:02');
  });

  it('dice el importe cuando movió dinero', () => {
    const lines = composeMandateUses([{ ...use, amount: '$1.200.000' }]);
    expect(lines[0]?.text).toContain('sin preguntarte, por $1.200.000, como me autorizaste');
  });

  it('se calla la razón que no puede sostener en vez de inventarla', () => {
    const lines = composeMandateUses([{ ...use, authorization: null }]);
    expect(lines[0]?.text).toBe(
      'Hice «Enviar este correo tal cual» sin preguntarte, dentro del mandato «Cobros a clientes».',
    );
  });

  it('vuelve a contar junto pasado el tope: veinte no son veinte hallazgos', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...use, id: `u${i}` }));
    const lines = composeMandateUses(many);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(
      'Hice seis cosas sin preguntarte, todas dentro de los mandatos que me diste.',
    );
  });
});

describe('trámites, rutinas y encargos', () => {
  it('separa el trámite que se quedó a medias del que falló', () => {
    const lines = composeFlows([
      {
        id: 'r1',
        at: at('2026-08-10T08:00:00-05:00'),
        name: 'Certificado de tradición',
        status: 'succeeded',
        error: null,
        stalled: false,
      },
      {
        id: 'r2',
        at: at('2026-08-10T09:14:00-05:00'),
        name: 'RUNT',
        status: 'running',
        error: null,
        stalled: true,
      },
      {
        id: 'r3',
        at: at('2026-08-10T09:20:00-05:00'),
        name: 'SIMIT',
        status: 'failed',
        error: 'el portal no cargó',
        stalled: false,
      },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Hice el trámite «Certificado de tradición» en el portal.',
      'Empecé el trámite «RUNT» y se quedó a medias: sigue esperando a alguien.',
      'El trámite «SIMIT» falló: el portal no cargó.',
    ]);
    expect(lines.map((l) => l.attention)).toEqual([false, true, true]);
  });

  it('no cuenta como fallo un trámite que sigue corriendo y todavía va a tiempo', () => {
    const lines = composeFlows([
      {
        id: 'r1',
        at: at('2026-08-10T09:29:00-05:00'),
        name: 'RUNT',
        status: 'running',
        error: null,
        stalled: false,
      },
    ]);
    expect(lines).toEqual([]);
  });

  it('junta las rutinas que salieron y nombra la que falló', () => {
    const lines = composeRoutines([
      {
        id: 'a',
        at: at('2026-08-10T07:00:00-05:00'),
        name: 'Resumen diario',
        status: 'ok',
        error: null,
      },
      {
        id: 'b',
        at: at('2026-08-10T07:05:00-05:00'),
        name: 'Cartera',
        status: 'ok',
        error: null,
      },
      {
        id: 'c',
        at: at('2026-08-10T07:10:00-05:00'),
        name: 'Informe de flota',
        status: 'error',
        error: 'HubSpot devolvió 401',
      },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Corrí dos rutinas.',
      'La rutina «Informe de flota» falló: HubSpot devolvió 401.',
    ]);
  });

  it('deja a cada encargo su propia pregunta, que es lo único que lo distingue', () => {
    const lines = composeErrands([
      {
        id: 'e1',
        at: at('2026-08-10T08:40:00-05:00'),
        request: 'Comparar tarifas de tres navieras a Cartagena',
        state: 'delivered',
        closingNote: null,
      },
      {
        id: 'e2',
        at: at('2026-08-10T08:50:00-05:00'),
        request: 'Buscar proveedores de estibas en Barranquilla',
        state: 'blocked',
        closingNote: null,
      },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Entregué el encargo «Comparar tarifas de tres navieras a Cartagena».',
      'El encargo «Buscar proveedores de estibas en Barranquilla» se atascó y te preguntó algo.',
    ]);
    expect(lines[0]?.href).toBe('/errands/e1');
  });
});

describe('lo que aprendió, y lo que no pudo aplicar solo', () => {
  it('cuenta lo anotado de la persona en una línea', () => {
    const lines = composeMemories([
      { id: 'm1', at: at('2026-08-10T02:00:00-05:00') },
      { id: 'm2', at: at('2026-08-10T02:00:20-05:00') },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Anoté dos cosas que aprendí de cómo trabajas.');
    expect(lines[0]?.clock).toBe('02:00');
  });

  it('marca como pendiente de mirar lo que concluyó y no tiene permiso de aplicar', () => {
    const lines = composeLearning({
      adjustments: 3,
      proposals: 1,
      adjustedAt: at('2026-08-10T04:20:00-05:00'),
      proposedAt: at('2026-08-10T04:21:00-05:00'),
    });
    expect(lines.map((l) => l.text)).toEqual([
      'Repasé cómo se está usando Brain Knowledge y ajusté tres fragmentos.',
      'Y te dejé una conclusión que no puedo aplicar solo.',
    ]);
    expect(lines.map((l) => l.attention)).toEqual([false, true]);
  });

  it('no dice nada de una pasada que no dejó nada escrito', () => {
    expect(
      composeLearning({ adjustments: 0, proposals: 0, adjustedAt: null, proposedAt: null }),
    ).toEqual([]);
  });
});

describe('lo que sigue sin moverse', () => {
  it('dice cuántos días lleva callado un correo que Cortex mandó', () => {
    const lines = composeLingering([
      {
        id: 'a1',
        at: at('2026-08-01T09:00:00-05:00'),
        recipient: 'cartera@coltrans.com.co',
        subject: 'Factura FV-2211 vencida',
        days: 9,
      },
    ]);
    expect(lines[0]?.text).toBe(
      'El correo a cartera@coltrans.com.co («Factura FV-2211 vencida») lleva nueve días sin respuesta.',
    );
    expect(lines[0]?.attention).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La jornada entera: los tres casos que importan
// ---------------------------------------------------------------------------

describe('un lunes normal', () => {
  const lines = [
    ...composeMemories([{ id: 'm1', at: at('2026-08-10T02:00:00-05:00') }]),
    ...composeCommitmentWatch(
      [
        { id: 'n1', at: at('2026-08-10T06:00:05-05:00'), kind: 'ahead', delivered: true },
        { id: 'n2', at: at('2026-08-10T06:00:15-05:00'), kind: 'overdue', delivered: true },
      ],
      47,
    ),
    ...composeDrafts([{ id: 'd1', at: at('2026-08-10T06:30:00-05:00') }]),
    ...composeFlows([
      {
        id: 'r2',
        at: at('2026-08-10T09:14:00-05:00'),
        name: 'RUNT',
        status: 'running',
        error: null,
        stalled: true,
      },
    ]),
    // De ayer: la pasada de aprendizaje.
    ...composeLearning({
      adjustments: 2,
      proposals: 0,
      adjustedAt: at('2026-08-09T04:20:00-05:00'),
      proposedAt: null,
    }),
  ];

  const journal = buildJournal({ lines, lingering: [], gaps: [], now: NOW });

  it('agrupa por día de Bogotá, con hoy primero', () => {
    expect(journal.days.map((d) => d.label)).toEqual(['Hoy', 'Ayer']);
    expect(journal.days[0]?.date).toBe('2026-08-10');
    expect(journal.days[1]?.date).toBe('2026-08-09');
  });

  it('pone lo último arriba dentro de cada día', () => {
    expect(journal.days[0]?.lines.map((l) => l.clock)).toEqual([
      '09:14',
      '06:30',
      '06:00',
      '02:00',
    ]);
  });

  it('titula con lo hecho hoy y con lo que no salió', () => {
    expect(journal.headline).toBe('Hoy he hecho cuatro cosas y una no salió como debía.');
    expect(journal.total).toBe(5);
    expect(journal.attention).toBe(1);
  });

  it('dice la frase que da nombre a todo esto', () => {
    expect(journal.days[0]?.lines.map((l) => l.text)).toContain(
      'Revisé 47 vencimientos y avisé de dos.',
    );
  });
});

describe('un día sin actividad', () => {
  const journal = buildJournal({ lines: [], lingering: [], gaps: [], now: NOW });

  it('no dibuja ni un día ni una línea', () => {
    expect(journal.days).toEqual([]);
    expect(journal.total).toBe(0);
  });

  it('lo dice, en vez de rellenar', () => {
    expect(journal.headline).toBe(
      'Anoche no había nada que revisar y hoy todavía no he hecho nada.',
    );
  });

  it('avisa igual de lo que sigue colgando desde antes', () => {
    const withOld = buildJournal({
      lines: [],
      lingering: composeLingering([
        {
          id: 'a1',
          at: at('2026-08-01T09:00:00-05:00'),
          recipient: 'cartera@coltrans.com.co',
          subject: 'Factura FV-2211',
          days: 9,
        },
      ]),
      gaps: [],
      now: NOW,
    });
    expect(withOld.headline).toBe(
      'Anoche no había nada que revisar y hoy todavía no he hecho nada, pero hay algo mío que sigue sin moverse.',
    );
    expect(withOld.lingering).toHaveLength(1);
  });

  it('sabe distinguir «hoy todavía nada» de «no ha pasado nada en 48 horas»', () => {
    const onlyYesterday = buildJournal({
      lines: composeMemories([
        { id: 'm1', at: at('2026-08-09T02:00:00-05:00') },
        { id: 'm2', at: at('2026-08-09T02:00:10-05:00') },
      ]),
      lingering: [],
      gaps: [],
      now: NOW,
    });
    expect(onlyYesterday.headline).toBe('Hoy todavía no he hecho nada; ayer hice una cosa.');
  });
});

describe('una fuente caída', () => {
  // Los trámites no se pudieron leer. Todo lo demás sí.
  const journal = buildJournal({
    lines: [
      ...composeCommitmentWatch(
        [{ id: 'n1', at: at('2026-08-10T06:00:05-05:00'), kind: 'ahead', delivered: true }],
        12,
      ),
      ...composeDrafts([{ id: 'd1', at: at('2026-08-10T06:30:00-05:00') }]),
    ],
    lingering: [],
    gaps: ['No pude leer los trámites: column browser_flow_runs.status does not exist'],
    now: NOW,
  });

  it('no se lleva por delante las demás clases de trabajo', () => {
    expect(journal.total).toBe(2);
    expect(journal.days[0]?.lines).toHaveLength(2);
  });

  it('conserva el hueco con nombre, para que no se lea como «no hubo nada»', () => {
    expect(journal.gaps).toEqual([
      'No pude leer los trámites: column browser_flow_runs.status does not exist',
    ]);
  });

  it('no cuenta el hueco como un fallo del día: es un fallo de la pantalla', () => {
    expect(journal.headline).toBe('Hoy he hecho dos cosas.');
    expect(journal.attention).toBe(0);
  });

  it('una pantalla que no pudo leer NADA sigue sin inventarse la jornada', () => {
    const blind = buildJournal({
      lines: [],
      lingering: [],
      gaps: ['No pude leer los vencimientos: timeout', 'No pude leer las rutinas: timeout'],
      now: NOW,
    });
    expect(blind.headline).toBe('Anoche no había nada que revisar y hoy todavía no he hecho nada.');
    expect(blind.gaps).toHaveLength(2);
  });
});

describe('la frase de arriba, caso por caso', () => {
  it('no promete trabajo que no hubo', () => {
    expect(journalHeadline({ total: 0, todayCount: 0, attention: 0, lingering: 0 })).toBe(
      'Anoche no había nada que revisar y hoy todavía no he hecho nada.',
    );
  });

  it('cuenta en singular sin sonar a máquina', () => {
    expect(journalHeadline({ total: 1, todayCount: 1, attention: 0, lingering: 0 })).toBe(
      'Hoy he hecho una cosa.',
    );
  });

  it('nunca esconde lo que salió mal', () => {
    expect(journalHeadline({ total: 9, todayCount: 9, attention: 3, lingering: 0 })).toBe(
      'Hoy he hecho nueve cosas y tres no salieron como debían.',
    );
  });
});
